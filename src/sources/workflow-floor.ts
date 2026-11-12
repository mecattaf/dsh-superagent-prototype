/** Starts, drives, resumes and reports workflow runs: each run is the interpreter over its pinned script and a `TicketBackend`. */
import type { Volatile } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { key, threadKey, type Thread, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import { extractMeta, runWorkflow, type LoadedJournal, type RunResult, type WorkflowSource } from '../workflow/index.ts'
import { health, sourceContext, type SourceContext, type SourceHost } from './host.ts'
import { retriedOnResume, TicketBackend, ticketOf, TicketWaiter } from './workflow-backend.ts'
import { KvJournal, type WorkflowRun, type WorkflowState } from './workflow-store.ts'
import { nodeThread, nodeTriggerId, SOURCE } from './workflow-trigger.ts'

/** The workflow Source's machine settings, as the plugin's Config declares them; `pollMs` is read at each use. */
export interface FloorConfig { pollMs: Volatile<number>; concurrency: number; maxAttempts: number; pair: string }
export interface StartRequest { script: string; cwd: string; args?: unknown; pair?: string; trigger_id?: string }
export interface StartResult { run_id: string; state: 'started' | 'already-started'; script_sha256: string; name: string }
/**
 * Where a node is: `waiting` before its Trigger exists, `offered` while it waits for or is in an Eval, `held` once an Eval
 * decided it without a Ticket, `ticket` while its Ticket works, and `done` or `null` once its result or failure is journaled.
 * A node answered from the journal on a resume is `done` or `null` as its line says. Its latest Trigger and its Ticket, when
 * the Store has them, come with every state but `waiting`.
 */
export type NodeState = 'waiting' | 'offered' | 'held' | 'ticket' | 'done' | 'null'
export interface NodeStatus { node: string; label?: string; phase?: string; trigger_id?: string; ticket_id?: string; state: NodeState }
export interface RunStatus {
  run_id: string; name: string; state: WorkflowRun['state']; cwd: string; started_at: string; ended_at?: string; error?: string; nodes: NodeStatus[]
}
/** At most this many runs, the newest, answer a status request that names none; fixed, as it only bounds one answer and `run_id` reaches any older run. */
const STATUS_RUNS = 20

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const refused = (message: string): Error => new Error(`orchestrator_workflow_start: ${message}`)

/**
 * Resolves `workflow()` as the interpreter does, with the run's directory in place of the process's, and keeps each child it
 * reads in the Store, so a resumed run reads the child its first start read whatever the file holds now.
 */
export function pinnedResolver(store: WorkflowState, run: Pick<WorkflowRun, 'id' | 'cwd' | 'scriptPath'>) {
  return (ref: string, fromPath: string | undefined): WorkflowSource => {
    const pin = KV.workflow.nested(run.id, key(fromPath ?? '', ref).slice(0, 16))
    const pinned = store.state.get(pin)
    const text = pinned && store.state.get(KV.workflow.script(pinned.sha256))
    if (pinned && text !== undefined) return { source: text, path: pinned.path }
    const base = dirname(fromPath ?? run.scriptPath)
    const candidates = ref.endsWith('.js') ? [isAbsolute(ref) ? ref : resolve(base, ref)]
      : [join(base, `${ref}.js`), join(run.cwd, '.claude', 'workflows', `${ref}.js`)]
    for (const path of candidates) {
      let source: string
      try { source = readFileSync(path, 'utf8') } catch { continue /* Not readable at this candidate path; try the next. */ }
      const digest = sha256(source)
      store.atomic(() => { store.state.set(KV.workflow.script(digest), source); store.state.set(pin, { path, sha256: digest }) })
      return { source, path }
    }
    throw new Error(`workflow(): cannot resolve '${ref}' (looked in ${candidates.join(', ')})`)
  }
}

/** A node's Thread key and the Trigger id of its latest attempt, or undefined before its first. */
function latestAttempt(source: Pick<SourceContext, 'triggers'>, run: string, node: string, attempts: number) {
  for (let attempt = attempts; attempt >= 1; attempt--) {
    const trigger = nodeTriggerId(run, node, attempt)
    if (source.triggers.get(trigger)) return { trigger, thread: threadKey({ source: SOURCE, id: nodeThread(run, node) }) }
  }
  return undefined
}
function nodeState(thread: Thread | undefined, trigger: string, ticket: Ticket | undefined): NodeState {
  if (ticket) return 'ticket'
  return thread && (thread.pending.includes(trigger) || thread.evaluating?.triggerIds.includes(trigger)) ? 'offered' : 'held'
}

/**
 * The workflow Source at work: it starts runs on request, drives each one with the interpreter, journals it in the Store, and
 * after a restart resumes every run that had not ended, answering finished calls from the journal without raising them again.
 */
export class WorkflowFloor {
  private source: SourceContext | undefined
  private waiter: TicketWaiter | undefined
  private readonly stopped = new AbortController()
  private readonly driving = new Set<string>()
  constructor(private readonly host: SourceHost, private readonly config: FloorConfig) {}

  /** Waits for setup, then resumes every run that had not ended; it resolves once they are under way, not once they end. */
  async start(): Promise<void> {
    const source = this.source = sourceContext(this.host, { kind: SOURCE, health: [SOURCE] })
    this.waiter = new TicketWaiter(source, () => this.config.pollMs.get())
    // A stop while setup is still running ends the start at once, so the plugin's disposal never waits for setup.
    const stopped = new Promise<void>(resolve => { this.stopped.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    await Promise.race([source.ready, stopped])
    if (this.stopped.signal.aborted) return
    // Setup restarts dsh-superagent once it resolves the accounts; until then no run starts or resumes.
    if (!source.configured()) { source.report(SOURCE, health('paused', 'setupPending')); return }
    for (const run of this.runs()) if (run.state === 'running') this.drive(run)
    this.reportHealth()
  }
  /** Parks every waiting call: nothing more is journaled, and the runs resume on the next start. */
  stop(): void {
    this.stopped.abort()
    this.waiter?.stop()
  }
  /** Starts a run of a script in a directory, once per `trigger_id`; the script's text is kept, and a resume reads that text. */
  startRun(request: StartRequest): StartResult {
    const source = this.ready()
    if (!isAbsolute(request.cwd)) throw refused(`cwd must be an absolute path: ${request.cwd}`)
    let directory = false
    try { directory = statSync(request.cwd).isDirectory() } catch { /* A missing directory is refused below. */ }
    if (!directory) throw refused(`cwd is not a directory: ${request.cwd}`)
    const scriptPath = resolve(request.cwd, request.script)
    let text: string
    try { text = readFileSync(scriptPath, 'utf8') } catch (error) { throw refused(`cannot read the script ${scriptPath}: ${String(error)}`) }
    let name: string
    try { name = extractMeta(text).meta.name } catch (error) { throw refused(`the script's meta is invalid: ${String(error)}`) }
    const digest = sha256(text)
    const args = request.args
    const pair = request.pair ?? (this.config.pair || undefined)
    const id = request.trigger_id
      ? `wf-${key('workflow-run', request.trigger_id, digest, request.cwd, JSON.stringify(args ?? null)).slice(0, 12)}`
      : `wf-${randomBytes(6).toString('hex')}`
    const existing = source.state.get(KV.workflow.run(id))
    if (existing) return { run_id: id, state: 'already-started', script_sha256: existing.scriptSha256, name: existing.name }
    const run: WorkflowRun = { id, name, scriptPath, scriptSha256: digest, cwd: request.cwd, ...args !== undefined && { args },
      ...pair !== undefined && { pair }, ...request.trigger_id !== undefined && { requestedBy: request.trigger_id },
      state: 'running', startedAt: new Date().toISOString(), seq: 0 }
    source.atomic(() => { source.state.set(KV.workflow.script(digest), text); source.state.set(KV.workflow.run(id), run) })
    this.drive(run)
    this.reportHealth()
    return { run_id: id, state: 'started', script_sha256: digest, name }
  }
  /** The state of one run and of each of its nodes, or of the newest runs when `runId` names none. */
  status(runId?: string): RunStatus[] {
    const source = this.ready()
    if (runId !== undefined) {
      const run = source.state.get(KV.workflow.run(runId))
      if (!run) throw new Error(`orchestrator_workflow_status: no workflow run ${runId}`)
      return [this.runStatus(source, run)]
    }
    return this.runs().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, STATUS_RUNS).map(run => this.runStatus(source, run))
  }
  /** How many runs this process drives now. */
  get active(): number { return this.driving.size }

  private ready(): SourceContext {
    if (!this.source || !this.source.configured() || this.stopped.signal.aborted) throw new Error('The workflow Source is not running')
    return this.source
  }
  private runs(): WorkflowRun[] {
    const source = this.source!
    return source.state.keys(KV.workflow.run).flatMap(name => { const run = source.state.get(name); return run ? [run] : [] })
  }
  private drive(run: WorkflowRun): void {
    const source = this.source!, signal = this.stopped.signal
    const script = source.state.get(KV.workflow.script(run.scriptSha256))
    if (script === undefined) { this.finish(run.id, { status: 'failed', result: null, error: `the script ${run.scriptSha256} it was started with is not kept` }); return }
    const backend = new TicketBackend({ source, run, waiter: this.waiter!, signal })
    // A run that wrote its first line resumes from its journal, which writes no second `launched` line.
    const resumeFrom: LoadedJournal | undefined = run.seq > 0 ? KvJournal.load(source, run.id) : undefined
    this.driving.add(run.id)
    runWorkflow(script, {
      backend, runId: run.id, scriptPath: run.scriptPath, ...run.args !== undefined && { args: run.args },
      journal: new KvJournal(source, run.id, signal), ...resumeFrom && { resumeFrom },
      cacheIdentity: 'content', resumeFailures: 'replay', isRetryableFailure: retriedOnResume,
      concurrency: this.config.concurrency, maxAttempts: this.config.maxAttempts, resolveWorkflow: pinnedResolver(source, run),
    }).catch((error: unknown) => ({ status: 'failed' as const, result: null, error: String(error) }))
      .then(result => {
        this.driving.delete(run.id)
        if (signal.aborted) return
        this.finish(run.id, result)
        this.reportHealth()
      })
      // DSH ends its process on an unhandled rejection, so a run whose end cannot be recorded becomes the Source's health.
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: `run ${run.id} ended unrecorded: ${String(error)}` }) })
  }
  private finish(id: string, result: Pick<RunResult, 'status' | 'result' | 'error'>): void {
    const source = this.source!
    source.atomic(() => {
      const run = source.state.get(KV.workflow.run(id))
      if (!run) return
      source.state.set(KV.workflow.run(id), { ...run, state: result.status, result: result.result ?? null,
        ...result.error !== undefined && { error: result.error }, endedAt: new Date().toISOString() })
    })
  }
  private runStatus(source: SourceContext, run: WorkflowRun): RunStatus {
    const journal = KvJournal.load(source, run.id)
    const nodes = journal.startOrder.flatMap((started): NodeStatus[] => {
      const match = started.cid === undefined ? undefined : /^c1:([0-9a-f]{16})[0-9a-f]*#(\d+)$/.exec(started.cid)
      if (!match) return []
      const node = `${match[1]!}-o${match[2]!}`
      const head = { node, ...started.label !== undefined && { label: started.label }, ...started.phase !== undefined && { phase: started.phase } }
      const latest = latestAttempt(source, run.id, node, this.config.maxAttempts)
      const ticket = latest && ticketOf(source, latest.trigger, latest.thread)
      const traced = { ...head, ...latest && { trigger_id: latest.trigger }, ...ticket && { ticket_id: ticket.id } }
      if (journal.results.has(started.key)) return [{ ...traced, state: 'done' }]
      if (journal.lastFailed.has(started.key)) return [{ ...traced, state: 'null' }]
      if (!latest) return [{ ...head, state: 'waiting' }]
      return [{ ...traced, state: nodeState(source.threads.get(latest.thread), latest.trigger, ticket) }]
    })
    return { run_id: run.id, name: run.name, state: run.state, cwd: run.cwd, started_at: run.startedAt,
      ...run.endedAt !== undefined && { ended_at: run.endedAt }, ...run.error !== undefined && { error: run.error }, nodes }
  }
  private reportHealth(): void {
    const running = this.driving.size, waiting = this.waiter?.size ?? 0
    this.source?.report(SOURCE, { state: 'ready', detail: `${running} runs under way, ${waiting} nodes waiting for their tickets`, at: new Date().toISOString() })
  }
}
