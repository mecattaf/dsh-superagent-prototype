/** dshd executor: runs each Assignment as one dshd headless unit and settles it from the way the unit ended. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { DshdPair, Machine } from '../deployment.ts'
import type { Store } from '../app/store.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Sessions } from '../app/sessions.ts'
import { reportRelay } from '../app/notices.ts'
import { inherited } from '../infra/environment.ts'
import type { HealthEntry } from '../infra/health.ts'
import { KV } from '../kv.ts'
import { LIMITS } from '../limits.ts'
import { WorkerSlots, batchOf, inputMessage, sourceTrigger, ticketExecution } from './dsh.ts'
import { DshdCli, DshdUnavailable, invocationOf, type DshdPort, type DshdRead, type DshdRecipe, type DshdStatus } from './dshd-cli.ts'
import type { ExecutorPort } from './port.ts'

declare module '../app/effects.ts' {
  interface EffectPayloads {
    /** Follow a dshd unit until it ends and settle its Assignment; the key is the Assignment ID. */
    'dshd-watch': { ticketId: string; assignmentId: string }
    /** Stop the dshd unit of an Assignment the domain ended; the key is the Assignment ID. */
    'dshd-stop': { ticketId: string; assignmentId: string; reason: string }
  }
}

const now = (): string => new Date().toISOString()
/** How an Assignment's unit ended, read from `dshd get` (see `verdictOf`). */
export type Verdict = 'running' | 'completed' | 'task-failed' | 'killed' | 'never-ran' | 'stopped' | 'cut' | 'lost' | 'superseded' | 'unknown'
/** The persisted owner of one Assignment's unit: where and as what it runs, and the recipe every launch attempt reuses. */
export interface DshdBinding {
  executor: 'dshd'
  /** `os.hostname()` of the process that launched the unit; only that host observes it. */
  host: string
  /** dshd instance name; the unit is `dshd@<name>.service`. */
  name: string
  pair: string
  state: 'launching' | 'running' | 'ended'
  launchedAt: string
  /** Frozen at the first launch attempt: a re-run is byte-identical, so dshd's same-name rule makes it idempotent. */
  recipe: DshdRecipe
  /** The Inputs the brief carries. */
  inputIds: string[]
  instanceId?: string
  /** The systemd invocation of the run this binding started. */
  invocationId?: string
  /** The worker's DSH Session, from the unit's `session` event once read. */
  sessionId?: string
  ended?: { at: string; verdict: Verdict; exitCode?: number; signal?: number; ending?: string | null }
}
/** The binding of each Assignment the dshd executor launched, by Assignment ID. */
export const BINDING = KV.dshd.binding
/** Label keys dsh-superagent sets on every unit. */
const LABEL = { orchestrator: 'superagent.orchestrator', ticket: 'superagent.ticket', assignment: 'superagent.assignment', pair: 'superagent.pair' }
const EXTRA_LABEL = /^superagent\.[a-z0-9._-]+$/
/** dshd's instance name rule (`invalid-name`). */
const UNIT_NAME = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/
const RUNNING = new Set(['running', 'starting', 'stopping'])
const UNCERTAIN = new Set(['masked', 'orphaned', 'inconsistent', 'unknown'])
/** Tries of a launch while dshd is unavailable (exit 7) before the Assignment is recorded failed. */
const UNAVAILABLE_TRIES = 3
/** Longest worker answer the summary of a unit that did not complete carries; a completed unit's answer is its whole result. */
const FINAL_CHARS = 3800
const RETRIED = 'A person retried this ticket. Continue the assignment from the current directory and what it holds now.'
const DSHD_WORKER_NOTE = 'You are one headless task that dsh-superagent started. Work in the current directory. Nothing reaches you after this '
  + 'message and there is no report tool: when the work is done, end with a short final answer. Your session log is the record. '
  + 'If the task asks for a JSON-only reply, your final answer is that JSON value and nothing else.'

/** The unit name of the `k`th Assignment (1-based) of a Ticket: `<prefix>-<execution name>-a<k>`, or `<prefix>-t<ticket id>-a<k>` when that name is unusable. */
export function unitName(prefix: string, executionName: string | undefined, ticketId: string, k: number): string {
  const named = `${prefix}-${executionName ?? ''}-a${k}`
  return executionName && UNIT_NAME.test(named) ? named : `${prefix}-t${ticketId.slice(0, 12)}-a${k}`
}
/** How a unit ended, from `dshd get`: `lastRun.ending` decides once the unit no longer runs. */
export function verdictOf(status: Pick<DshdStatus, 'state' | 'lastRun'>): Verdict {
  if (RUNNING.has(status.state)) return 'running'
  if (UNCERTAIN.has(status.state)) return 'unknown'
  if (status.state === 'interrupted') return 'cut'
  const run = status.lastRun
  if (!run) return 'never-ran'
  const child = run.child ?? {}
  if (run.ending === 'exited') return child.exitCode === 0 ? 'completed' : 'task-failed'
  if (run.ending === 'failed') return child.signal !== undefined ? 'killed' : child.exitCode !== undefined ? 'task-failed' : 'never-ran'
  if (run.ending === 'stopped') return 'stopped'
  if (run.ending === 'stopped-without-intent' || run.ending === 'interrupted' || status.state === 'previous-boot') return 'cut'
  return 'unknown'
}
/** A Trigger as a dshd worker reads it: who wrote what, and when, in full. */
const triggerCard = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text })
/**
 * The whole first and only message of a unit: the Ticket, its assignment and source Trigger in full, the waiting Inputs, and
 * how the worker ends. Every Assignment gets it whole, since each unit is a fresh process with a fresh Session.
 */
export function composeBrief(ticket: Ticket, k: number, origin: Trigger | undefined, batch: Trigger[], inputs: string[]): string {
  const assignment = ticket.execution?.assignment
  const previous = ticket.assignments.at(k - 2)
  // The framing comes first and the request last, so a schema the request ends with is the last thing the worker reads.
  return JSON.stringify({ note: DSHD_WORKER_NOTE, ticket_id: ticket.id, title: ticket.title, attempt: k, ...(assignment ? { assignment } : {}),
    ...(inputs.length ? { inputs } : {}), ...(batch.length ? { batch: batch.map(triggerCard) } : {}),
    ...(k > 1 && previous?.endedReason === 'retried' ? { retried: RETRIED } : {}), ...(origin ? { trigger: triggerCard(origin) } : {}) })
}
/**
 * The Report summary of a settled unit. A completed unit's is its final answer verbatim, the Ticket's result, which a workflow
 * node parses as JSON; any other end says how the unit ended, then its answer and where its record is.
 */
function summaryOf(name: string, verdict: Verdict, end: { exitCode?: number; signal?: number }, final?: string, sessionId?: string): string {
  if (verdict === 'completed') return final ?? `Unit ${name} exited 0.`
  const answer = final === undefined ? undefined : `${final.slice(0, FINAL_CHARS)}${final.length > FINAL_CHARS ? '…' : ''}`
  const pointer = `Unit ${name}; session ${sessionId ?? 'unknown'}.`
  const how = `Unit ${name} ended ${verdict}${end.exitCode !== undefined ? ` (exit ${end.exitCode})` : ''}${end.signal ? ` (signal ${end.signal})` : ''}.`
  return `${how}${answer ? `\n\n${answer}` : ''}\n\n${pointer}`
}
const SessionEvent = (line: string): Record<string, unknown> | undefined => {
  try { const value: unknown = JSON.parse(line); return value && typeof value === 'object' ? value as Record<string, unknown> : undefined }
  catch { return undefined /* A line dshd-run or dsh wrote that is not a headless event. */ }
}
/** The Session ID of the first `session` event and the text of the last `final` event a headless `--json` run printed. */
export function eventsOf(read: Pick<DshdRead, 'lines'>): { sessionId?: string; final?: string } {
  let sessionId: string | undefined, final: string | undefined
  for (const event of read.lines.map(SessionEvent)) {
    if (event?.type === 'session' && sessionId === undefined && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event?.type === 'final' && typeof event.text === 'string') final = event.text
  }
  return { ...(sessionId !== undefined ? { sessionId } : {}), ...(final !== undefined ? { final } : {}) }
}
/** A launch that cannot succeed as configured, such as an unknown pair or a missing directory; it is recorded failed and not retried. */
class LaunchRefused extends Error {}

/** Host dependencies used by `DshdExecutor`. */
export interface DshdExecutorHost {
  /** DSH Cordis context, whose subprocess service runs the dshd CLI. */
  readonly context: Context
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'report' | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'get' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches, watches and stops run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir' | 'dshd'>
  /** The main Session's ID, which labels every unit as this orchestrator's. */
  readonly masterId: string
  readonly lifetime: AbortSignal
  /** Relays each settled unit's report to the main Session. */
  readonly sessions: Pick<Sessions, 'relay'>
  closing(): boolean
  /** Whether processing is paused, which holds launches. */
  paused(): boolean
  /** The dshd client; `DshdCli` over the context's subprocess service by default. */
  readonly dshd?: DshdPort
  readonly hostname?: () => string
}

/**
 * Executes each Assignment as one dshd headless unit (`dshd@<name>.service`) in the Ticket's directory, under the profile of its
 * provider-harness pair. Launches go through the `launch` effect and `WorkerSlots`; a `dshd-watch` effect follows each unit until
 * it ends, and its end settles the Assignment: exit 0 reports ready, any other end failed, and a unit a reboot cut restarts as
 * upstream restarts interrupted work. A unit outlives this process, so a restart adopts the units that still run.
 */
export class DshdExecutor implements ExecutorPort {
  private readonly slots: WorkerSlots
  private readonly dshd: DshdPort
  private readonly hostname: () => string
  /** Launch attempts made so far while dshd was unavailable, by Assignment ID. */
  private readonly unavailable = new Map<string, number>()
  /** Launches under way, by Assignment ID, with their pair, which per-pair limits and stops consult. */
  private readonly launching = new Map<string, string>()
  constructor(private readonly host: DshdExecutorHost) {
    this.dshd = host.dshd ?? new DshdCli(host.context.subprocess, host.machine.dshd.command)
    this.hostname = host.hostname ?? osHostname
    this.slots = new WorkerSlots(() => this.runningTickets().map(({ ticket }) => ticket.id), () => host.store.settings().executor.maxWorkers)
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // A headless unit takes no Input after its brief; rows an in-process Executor queued before a switch are drained.
    host.effects.handle('delivery', async () => {}, { quiet: true })
    host.effects.handle('dshd-watch', payload => this.watch(payload), { limit: () => LIMITS.maxWorkers.max, retry: [2000, 60_000] })
    host.effects.handle('dshd-stop', payload => this.stopQueued(payload), { limit: () => 4, retry: [2000, 60_000] })
  }
  /** The Ticket's execution attributes, with the directory its unit runs in (see `cwdOf`). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const execution = ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir)
    return { ...ticket, execution: { ...execution, directory: this.cwdOf(ticket) ?? execution.directory } }
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** A headless unit reads only its brief: Inputs that arrive while it runs wait, and its end hands them back to Eval. */
  deliver(_ticket: Ticket, _assignment: Assignment): void {}
  /** Queues the stop of the Assignment's unit, which the domain already ended. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.unavailable.delete(assignment.id)
    this.host.effects.enqueue('dshd-stop', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /** Nothing to listen to: the workers run outside this process. */
  install(): void {}
  /**
   * Reconciles open Tickets oldest first after a start. A running Assignment whose unit may still run is adopted and watched
   * again; one that ran in this process before a switch from the dsh executor is interrupted, as upstream does; pending ones launch.
   */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) {
        const binding = this.host.store.get(BINDING(running.id))
        if (!binding) this.host.engine.assignmentInterrupted(ticket.id, running.id)
        else if (binding.state !== 'ended') this.watchLater(ticket.id, running.id)
      } else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Units keep running when this process stops; the dshd calls under way end with the host's lifetime. */
  async shutdown(): Promise<void> {}
  dispose(): void {}
  /** Number of open Tickets whose unit runs. */
  activeCount(): number { return this.runningTickets().length }
  /** Open Tickets whose running Assignment's unit runs, with that binding; a unit that ended frees its slot whatever was reported. */
  private runningTickets(): { ticket: Ticket; binding: DshdBinding }[] {
    return this.host.store.tickets.open().flatMap(ticket => {
      const running = runningAssignment(ticket)
      const binding = running && this.host.store.get(BINDING(running.id))
      return binding?.state === 'running' ? [{ ticket, binding }] : []
    })
  }
  /**
   * The directory a Ticket's unit runs in: its origin Trigger's `meta.cwd` when that is an absolute path, else the configured
   * `cwd`; undefined leaves upstream's directory under the Execution directory.
   */
  private cwdOf(ticket: Ticket): string | undefined {
    const cwd = sourceTrigger(this.host, ticket)?.meta.cwd
    if (typeof cwd === 'string' && isAbsolute(cwd)) return cwd
    return this.host.machine.dshd.cwd || undefined
  }
  /** The pair a Ticket runs on: its origin Trigger's `meta.pair`, else the default pair. */
  private pairOf(ticket: Ticket): { name: string; pair: DshdPair } {
    const { pairs, defaultPair } = this.host.machine.dshd
    const named = sourceTrigger(this.host, ticket)?.meta.pair
    const name = typeof named === 'string' ? named : defaultPair
    const pair = Object.hasOwn(pairs, name) ? pairs[name] : undefined
    if (!pair) throw new LaunchRefused(`unknown pair ${name}`)
    return { name, pair }
  }
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    if (this.host.closing()) throw new Error('dsh-superagent is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    const stored = this.host.store.get(BINDING(assignmentId))
    let pair: { name: string; pair?: DshdPair }
    try { pair = stored ? { name: stored.pair, pair: this.host.machine.dshd.pairs[stored.pair] } : this.pairOf(ticket) }
    catch (error) { this.launchFailed(ticketId, assignmentId, error); return }
    const max = pair.pair?.maxWorkers
    const ofPair = this.runningTickets().filter(({ binding }) => binding.pair === pair.name).length
      + [...this.launching.values()].filter(name => name === pair.name).length
    if (max !== undefined && ofPair >= max) throw new Later(`No slot for pair ${pair.name}`)
    this.slots.reserve(ticketId, 'launch')
    this.launching.set(assignmentId, pair.name)
    try { await this.launch(ticket, assignment, stored); this.unavailable.delete(assignmentId) }
    catch (error) {
      if (this.host.closing() || error instanceof Later) throw error
      if (error instanceof DshdUnavailable) {
        const tries = (this.unavailable.get(assignmentId) ?? 0) + 1
        this.unavailable.set(assignmentId, tries)
        if (tries < UNAVAILABLE_TRIES) throw error
      }
      this.unavailable.delete(assignmentId)
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.launching.delete(assignmentId); this.slots.free(ticketId) }
  }
  private async launch(ticket: Ticket, assignment: Assignment, stored: DshdBinding | undefined): Promise<void> {
    const binding = stored ?? await this.bindingOf(ticket, assignment)
    const { recipe } = binding
    if (!await stat(recipe.cwd).then(info => info.isDirectory(), () => false)) throw new LaunchRefused(`cwd ${recipe.cwd} does not exist`)
    const result = await this.dshd.run(recipe, this.host.lifetime)
    let status: DshdStatus | 'not-found'
    if (!('refused' in result)) status = result
    else if (result.refused === 'task-already-ran') status = await this.dshd.get(recipe.name, this.host.lifetime)
    else throw new LaunchRefused(`dshd refused ${recipe.name}: ${result.refused}: ${result.message}`)
    if (status === 'not-found') throw new LaunchRefused(`dshd refused ${recipe.name}: task-already-ran, then no longer knew it`)
    this.bind(ticket.id, assignment.id, binding, status)
  }
  /**
   * Builds the recipe of an Assignment's first launch attempt and stores it as its binding before dshd runs anything, so every
   * later attempt reuses it byte for byte. A brief longer than `briefArgvMaxChars` goes to a file under `stateDir/briefs`,
   * which no unit can have read yet, as none runs without the binding.
   */
  private async bindingOf(ticket: Ticket, assignment: Assignment): Promise<DshdBinding> {
    const { machine: { dshd, stateDir }, store } = this.host
    const { name: pair, pair: config } = this.pairOf(ticket)
    const k = ticket.assignments.findIndex(item => item.id === assignment.id) + 1
    const name = unitName(dshd.prefix, ticket.execution?.name, ticket.id, k)
    const cwd = ticket.execution?.directory ?? ''
    if (!this.cwdOf(ticket) && cwd) await mkdir(cwd, { recursive: true })
    const inputIds = [...ticket.undelivered]
    const inputs = inputIds.flatMap(id => {
      const input = ticket.inputs.find(item => item.id === id)
      const message = input && inputMessage(input, this.inputCard(input))
      return message === undefined ? [] : [message]
    })
    const brief = composeBrief(ticket, k, sourceTrigger(this.host, ticket), batchOf(this.host, ticket), inputs)
    let task = brief
    if (brief.length > dshd.briefArgvMaxChars) {
      const file = join(stateDir, 'briefs', `${assignment.id}.json`)
      await mkdir(join(stateDir, 'briefs'), { recursive: true, mode: 0o700 })
      await writeFile(file, brief, { mode: 0o600 })
      task = `Read and follow the task in ${file}.`
    }
    const extra = sourceTrigger(this.host, ticket)?.meta.labels
    const labels: Record<string, string> = {}
    for (const [label, value] of Object.entries(extra && typeof extra === 'object' ? extra : {})) {
      if (EXTRA_LABEL.test(label) && typeof value === 'string' && value.length <= 256 && !value.includes('\n')) labels[label] = value
    }
    Object.assign(labels, { [LABEL.orchestrator]: this.host.masterId, [LABEL.ticket]: ticket.id, [LABEL.assignment]: assignment.id, [LABEL.pair]: pair })
    const env = { ...inherited(dshd.passEnv), ...dshd.env, ...config.env }
    const binding: DshdBinding = { executor: 'dshd', host: this.hostname(), name, pair, state: 'launching', launchedAt: now(),
      recipe: { name, cwd, labels, profile: config.profile, args: [...dshd.args], task, env }, inputIds }
    store.atomic(() => { store.set(BINDING(assignment.id), binding) })
    return binding
  }
  /** A Trigger Input as the brief carries it, in full. */
  private inputCard(input: TicketInput): object | undefined {
    const trigger = input.kind === 'trigger' ? this.host.store.triggers.get(input.triggerId) : undefined
    return trigger && triggerCard(trigger)
  }
  /**
   * Records that the unit runs and, while the Assignment is still the Ticket's pending one, starts it with the Inputs its brief
   * carries and queues the watch, in one transaction; a unit whose Assignment ended meanwhile is stopped.
   */
  private bind(ticketId: string, assignmentId: string, binding: DshdBinding, status: DshdStatus): void {
    const { store, engine } = this.host
    const invocationId = invocationOf(status)
    const bound: DshdBinding = { ...binding, state: 'running', ...(status.id ? { instanceId: status.id } : {}), ...(invocationId ? { invocationId } : {}) }
    store.atomic(() => {
      store.set(BINDING(assignmentId), bound)
      const ticket = store.tickets.get(ticketId)
      const assignment = ticket && latestAssignment(ticket)
      if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') {
        this.host.effects.enqueue('dshd-stop', assignmentId, { ticketId, assignmentId, reason: 'The Assignment ended while its unit started' })
        return
      }
      engine.assignmentStarted(ticketId, assignmentId)
      if (binding.inputIds.length) {
        engine.inputsDelivered(ticketId, assignmentId, binding.inputIds)
        // The brief is the unit's first step, so its Inputs count as read from now, before the end's report.
        engine.inputsRead(ticketId, binding.inputIds)
      }
      this.watchLater(ticketId, assignmentId)
    })
  }
  private watchLater(ticketId: string, assignmentId: string): void {
    this.host.effects.enqueue('dshd-watch', assignmentId, { ticketId, assignmentId })
  }
  /** Follows a bound unit with `dshd wait` until it ends, then settles its Assignment from `dshd get` and its events. */
  private async watch({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    let binding = this.host.store.get(BINDING(assignmentId))
    if (!binding || binding.state !== 'running') return
    const { name } = binding
    this.sameHost(binding)
    const signal = this.host.lifetime
    let status = await this.dshd.get(name, signal)
    if (status === 'not-found') return this.settle(ticketId, assignmentId, binding, 'lost')
    if (status.labels[LABEL.orchestrator] !== this.host.masterId) return this.settle(ticketId, assignmentId, binding, 'superseded')
    if (!binding.invocationId && invocationOf(status)) {
      binding = { ...binding, invocationId: invocationOf(status)! }
      this.host.store.set(BINDING(assignmentId), binding)
    }
    if (invocationOf(status) !== binding.invocationId) return this.settle(ticketId, assignmentId, binding, 'superseded')
    if (RUNNING.has(status.state)) {
      const waited = await this.dshd.wait(name, this.host.machine.dshd.watchSeconds, signal)
      if (waited !== 'not-found' && waited.outcome === 'still-running') throw new Later(`Unit ${name} still runs`)
      status = await this.dshd.get(name, signal)
      if (status === 'not-found') return this.settle(ticketId, assignmentId, binding, 'lost')
      if (invocationOf(status) !== binding.invocationId) return this.settle(ticketId, assignmentId, binding, 'superseded')
    }
    const verdict = verdictOf(status)
    if (verdict === 'running') throw new Later(`Unit ${name} still runs`)
    if (verdict === 'unknown') throw new Error(`Unit ${name} is ${status.state}: dsh-superagent keeps its Assignment until dshd can tell how it ended`)
    const read = await this.dshd.read(name, signal)
    const events = read !== 'not-found' && read.invocationId === binding.invocationId ? eventsOf(read) : {}
    const child = status.lastRun?.child ?? {}
    this.settle(ticketId, assignmentId, binding, verdict, { ...child, ending: status.lastRun?.ending ?? null }, events)
  }
  /**
   * Records how the unit ended on its binding and, while its Assignment still runs the open Ticket, tells the Engine in the same
   * transaction: a report, or for a cut unit upstream's restart, and relays the report to the main Session.
   */
  private settle(ticketId: string, assignmentId: string, binding: DshdBinding, verdict: Verdict,
    end: { exitCode?: number; signal?: number; ending?: string | null } = {}, events: { sessionId?: string; final?: string } = {}): void {
    const { store, engine } = this.host
    store.atomic(() => {
      store.set(BINDING(assignmentId), { ...binding, state: 'ended', ended: { at: now(), verdict, ...end },
        ...(events.sessionId ? { sessionId: events.sessionId } : {}) })
      const ticket = store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) return
      if (verdict === 'cut') { engine.assignmentInterrupted(ticketId, assignmentId); return }
      const sessionId = events.sessionId ?? binding.sessionId
      const report = { state: verdict === 'completed' ? 'ready' as const : 'failed' as const, summary: summaryOf(binding.name, verdict, end, events.final, sessionId) }
      const relay = reportRelay(engine.report(ticketId, report), report)
      // The relay names the unit and its Session, which a completed summary leaves out.
      if (relay) this.host.sessions.relay(relay.id, JSON.stringify({ ...JSON.parse(relay.text) as object, unit: binding.name, session: sessionId ?? null }))
    })
  }
  /**
   * Stops the unit of an Assignment the domain ended, only while its current run is the one this binding started; the domain
   * already ended the Assignment, so nothing is reported.
   */
  private async stopQueued({ assignmentId }: { ticketId: string; assignmentId: string; reason: string }): Promise<void> {
    const binding = this.host.store.get(BINDING(assignmentId))
    // A launch under way checks the Assignment again when it binds, and queues the stop again then.
    if (!binding || binding.state === 'ended' || (binding.state === 'launching' && this.launching.has(assignmentId))) return
    this.sameHost(binding)
    const signal = this.host.lifetime
    const status = await this.dshd.get(binding.name, signal)
    const ours = status !== 'not-found' && status.labels[LABEL.orchestrator] === this.host.masterId
      && (binding.invocationId ? invocationOf(status) === binding.invocationId : status.labels[LABEL.assignment] === assignmentId)
    let verdict: Verdict
    if (status === 'not-found') verdict = 'lost'
    else if (!ours) verdict = 'superseded'
    else if (RUNNING.has(status.state)) {
      // dshd has no compare-and-stop: a rerun between this get and the stop would be stopped too.
      await this.dshd.stop(binding.name, signal)
      verdict = 'stopped'
    } else verdict = verdictOf(status) === 'unknown' ? 'lost' : verdictOf(status)
    const current = this.host.store.get(BINDING(assignmentId)) ?? binding
    this.host.store.atomic(() => { this.host.store.set(BINDING(assignmentId), { ...current, state: 'ended', ended: { at: now(), verdict } }) })
  }
  /** A binding is observed only on the host that launched its unit: dshd units are local to one user manager. */
  private sameHost(binding: DshdBinding): void {
    if (binding.host !== this.hostname()) {
      throw new Error(`The unit ${binding.name} runs on ${binding.host}, and this process runs on ${this.hostname()}: only ${binding.host} can observe it`)
    }
  }
  /** Records a failed launch on its Ticket and relays it to the main Session; the Ticket waits for a person's message or a retry. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const { store, engine } = this.host
    const ticket = store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    const summary = error instanceof Error ? error.message : String(error)
    store.atomic(() => {
      const report = { state: 'failed' as const, summary }
      const relay = reportRelay(engine.report(ticketId, report), report)
      if (relay) this.host.sessions.relay(relay.id, relay.text)
    })
  }
}
