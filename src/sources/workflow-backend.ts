/** The interpreter's Backend over the Engine: a call becomes a Trigger, and its answer is the result of the Ticket accepted from it. */
import { latestAssignment, threadKey, type Decision, type Ticket } from '../core/index.ts'
import { retryableFailure, type AgentCall, type AgentOutcome, type Backend } from '../workflow/index.ts'
import type { SourceContext } from './host.ts'
import type { WorkflowRun } from './workflow-store.ts'
import { nodeOf, nodeThread, nodeTrigger, SOURCE } from './workflow-trigger.ts'

/** Every failure a node's Ticket gives starts with this, so a resumed run answers it from the journal as the same null. */
export const NODE_FAILURE = 'workflow node '
/** Whether a resumed run tries a journaled failure again: never a node's own, else as the interpreter decides. */
export const retriedOnResume = (reason: string): boolean => !reason.startsWith(NODE_FAILURE) && retryableFailure(reason)

const stripFence = (text: string): string => /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text.trim()
/** A structured reply: one JSON value, inside one code fence at most; anything else is text, which the interpreter treats as no object. */
export function parseJsonReply(text: string): { object?: unknown; text?: string } {
  try { return { object: JSON.parse(stripFence(text)) } } catch { return { text } }
}
/**
 * The whole summary of a completed Ticket whose worker gave no final answer, as the dshd Executor words it for a unit that
 * exited 0 without one. It is not a result: the node has no answer.
 */
export const NO_ANSWER = /^Unit [a-z0-9][a-z0-9_-]* exited 0\.$/
/**
 * What a node's Ticket answers once it settled, or undefined while it has not: the summary of its `ready` report, verbatim,
 * once it ended completed; no answer when that summary only says the unit exited 0, which the interpreter, as for any empty
 * answer, tries again while attempts remain and otherwise journals as the node's null; or a failure once the Ticket ended
 * otherwise or its worker reported failed or blocked.
 */
export function settle(ticket: Ticket | undefined, structured: boolean): AgentOutcome | undefined {
  if (!ticket) return undefined
  const report = latestAssignment(ticket)?.report
  const outcome = ticket.ended?.outcome
  if (outcome === 'completed' && report?.state === 'ready') {
    if (NO_ANSWER.test(report.summary)) return { agentId: ticket.id }
    return { ...structured ? parseJsonReply(report.summary) : { text: report.summary }, agentId: ticket.id }
  }
  const state = outcome ?? (report?.state === 'failed' || report?.state === 'blocked' ? report.state : undefined)
  if (state === undefined) return undefined
  return { error: `${NODE_FAILURE}${state}: ${(report?.summary ?? ticket.ended?.reason ?? '').slice(0, 500)}`, agentId: ticket.id }
}
type Tickets = Pick<SourceContext, 'threads' | 'tickets' | 'triggers'>
/** The Ticket accepted from `trigger`, which subscribes to the Trigger's Thread. */
export function ticketOf(source: Pick<Tickets, 'threads' | 'tickets'>, trigger: string, thread: string): Ticket | undefined {
  const subscribed = source.threads.get(thread)?.subscriptions ?? []
  return subscribed.map(id => source.tickets.get(id)).find(ticket => ticket?.origin.triggerIds.includes(trigger))
}
/** Where a node's Trigger is while no Ticket was accepted from it. */
export type Untaken = 'offered' | 'held' | 'unavailable'
/**
 * Where a node's Trigger is while no Ticket was accepted from it: `offered` while it is queued for or in an Eval, `since` the
 * Eval that holds it started; `unavailable` once its Eval ended without an assessment, as when the main Session did not answer
 * in time; else `held`, which the main Session or a person decided. The last two come with their Decision when the Store has
 * it. Neither is offered again until the Trigger is requeued. An Eval whose candidate never reaches the main Session does not
 * expire, so a node can stay offered as long as the main Session is away.
 */
export function untaken(source: Pick<Tickets, 'threads' | 'triggers'>, trigger: string, thread: string): { state: Untaken; decision?: Decision; since?: string } {
  const queue = source.threads.get(thread)
  if (queue?.evaluating?.triggerIds.includes(trigger)) return { state: 'offered', since: queue.evaluating.startedAt }
  if (queue?.pending.includes(trigger)) return { state: 'offered' }
  const decision = source.triggers.decision(trigger)
  return { state: decision?.kind === 'unavailable' ? 'unavailable' : 'held', ...decision && { decision } }
}
/**
 * A waiting node whose Trigger came to be held or unavailable, or offered `since` longer than the waiter's threshold, or left
 * that state (`state` undefined) at the latest poll.
 */
export interface Waited { trigger: string; state?: 'held' | 'unavailable' | 'offered'; decision?: Decision; since?: string }

/**
 * Waits for the Tickets of nodes: one timer, every `pollMs` as it reads at each poll, reads each waiting node's Thread and its
 * Ticket until it settles, and tells `observed` when a waiting node comes to be held or unavailable, or offered in one Eval for
 * longer than `offeredMs` as it reads at each poll, or leaves that state. It never decides or expires anything. Once stopped,
 * what still waits never settles, so a run parked at stop writes nothing more and resumes from its journal.
 */
export class TicketWaiter {
  private readonly waiting = new Map<string, { thread: string; structured: boolean; settled: (outcome: AgentOutcome) => void; state?: Waited['state']; seen?: string }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  constructor(private readonly source: Tickets, private readonly pollMs: () => number, private readonly observed: (node: Waited) => void = () => {},
    private readonly offeredMs: () => number = () => Infinity) {}
  settled(trigger: string, thread: string, structured: boolean): Promise<AgentOutcome> {
    const now = settle(ticketOf(this.source, trigger, thread), structured)
    if (now) return Promise.resolve(now)
    return new Promise(settled => {
      if (this.stopped) return
      this.waiting.set(trigger, { thread, structured, settled })
      this.arm()
    })
  }
  /** How many nodes wait. */
  get size(): number { return this.waiting.size }
  /** How many waiting nodes were held, unavailable, or offered past the threshold, at the latest poll. */
  count(state: NonNullable<Waited['state']>): number { return [...this.waiting.values()].filter(item => item.state === state).length }
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.waiting.clear() }
  private arm(): void {
    if (this.timer || this.stopped || !this.waiting.size) return
    this.timer = setTimeout(() => { this.timer = undefined; this.poll() }, this.pollMs())
  }
  private poll(): void {
    const changed: Waited[] = []
    for (const [trigger, item] of [...this.waiting]) {
      const ticket = ticketOf(this.source, trigger, item.thread)
      const outcome = settle(ticket, item.structured)
      if (outcome) { this.waiting.delete(trigger); item.settled(outcome) }
      const now = outcome || ticket ? undefined : untaken(this.source, trigger, item.thread)
      const overdue = now?.since !== undefined && Date.now() - Date.parse(now.since) > this.offeredMs()
      const state = now?.state === 'offered' && !overdue ? undefined : now?.state
      // A node held again, or unavailable again, after a requeue the polls did not see is a new Decision, and one overdue in a
      // later Eval a new offer, so it is told again.
      const seen = state === 'offered' ? now?.since : state && now?.decision?.id
      if (state === item.state && seen === item.seen) continue
      item.state = state; item.seen = seen
      changed.push({ trigger, ...state && { state, ...now?.decision && { decision: now.decision }, ...now?.since !== undefined && { since: now.since } } })
    }
    for (const node of changed) this.observed(node)
    this.arm()
  }
}

/**
 * Runs each attempt of a call as a Trigger of the workflow Source. It never decides: the main Session accepts, holds or ignores
 * the Trigger as any inferred candidate, and the Ticket it accepts runs on whatever Executor the deployment has. A resumed call
 * raises the same Trigger, which the Engine answers `duplicate`, and waits for the Ticket it already has.
 */
export class TicketBackend implements Backend {
  readonly name = 'ticket'
  constructor(private readonly host: { source: SourceContext; run: WorkflowRun; waiter: TicketWaiter; signal: AbortSignal }) {}
  async run(call: AgentCall): Promise<AgentOutcome> {
    const { source, run, waiter, signal } = this.host
    // A stopped Source parks the call: it never answers, so its run writes nothing more and resumes from its journal.
    if (signal.aborted) return new Promise(() => {})
    const trigger = nodeTrigger(run, call)
    const node = nodeOf(call)
    const thread = threadKey({ source: SOURCE, id: nodeThread(run.id, node) })
    const received = await source.receive(trigger)
    // A filtered Trigger has no Thread: the Source was off when it arrived, now or before a resume.
    if (received === 'filtered' || !source.threads.get(thread)) {
      return { error: `${NODE_FAILURE}filtered: the workflow Source did not take the node in; it is off or uninstalled` }
    }
    const label = call.opts.label === undefined ? node : String(call.opts.label)
    source.threads.describe(thread, { label: `${run.name} · ${label}`, facts: { run: { label: { zh: '工作流运行', en: 'Workflow run' }, value: run.id } } })
    if (signal.aborted) return new Promise(() => {})
    return waiter.settled(trigger.id, thread, call.opts.schema !== undefined)
  }
}
