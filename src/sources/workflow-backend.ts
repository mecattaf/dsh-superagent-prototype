/** The interpreter's Backend over the Engine: a call becomes a Trigger, and its answer is the result of the Ticket accepted from it. */
import { latestAssignment, threadKey, type Ticket } from '../core/index.ts'
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
 * What a node's Ticket answers once it settled, or undefined while it has not: the summary of its `ready` report once it ended
 * completed, or a failure once it ended otherwise or its worker reported failed or blocked.
 */
export function settle(ticket: Ticket | undefined, structured: boolean): AgentOutcome | undefined {
  if (!ticket) return undefined
  const report = latestAssignment(ticket)?.report
  const outcome = ticket.ended?.outcome
  if (outcome === 'completed' && report?.state === 'ready') {
    return { ...structured ? parseJsonReply(report.summary) : { text: report.summary }, agentId: ticket.id }
  }
  const state = outcome ?? (report?.state === 'failed' || report?.state === 'blocked' ? report.state : undefined)
  if (state === undefined) return undefined
  return { error: `${NODE_FAILURE}${state}: ${(report?.summary ?? ticket.ended?.reason ?? '').slice(0, 500)}`, agentId: ticket.id }
}
type Tickets = Pick<SourceContext, 'threads' | 'tickets'>
/** The Ticket accepted from `trigger`, which subscribes to the Trigger's Thread. */
function ticketOf(source: Tickets, trigger: string, thread: string): Ticket | undefined {
  const subscribed = source.threads.get(thread)?.subscriptions ?? []
  return subscribed.map(id => source.tickets.get(id)).find(ticket => ticket?.origin.triggerIds.includes(trigger))
}

/**
 * Waits for the Tickets of nodes: one timer, every `pollMs`, reads each waiting node's Thread and its Ticket until it settles.
 * Once stopped, what still waits never settles, so a run parked at stop writes nothing more and resumes from its journal.
 */
export class TicketWaiter {
  private readonly waiting = new Map<string, { thread: string; structured: boolean; settled: (outcome: AgentOutcome) => void }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  constructor(private readonly source: Tickets, private readonly pollMs: number) {}
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
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; this.waiting.clear() }
  private arm(): void {
    if (this.timer || this.stopped || !this.waiting.size) return
    this.timer = setTimeout(() => { this.timer = undefined; this.poll() }, this.pollMs)
  }
  private poll(): void {
    for (const [trigger, { thread, structured, settled }] of [...this.waiting]) {
      const outcome = settle(ticketOf(this.source, trigger, thread), structured)
      if (outcome) { this.waiting.delete(trigger); settled(outcome) }
    }
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
