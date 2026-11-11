/**
 * DshdExecutor: runs each attempt of a scheduled occurrence as one dshd headless instance (DESIGN 7.5, 7.6).
 *
 * Effects: `sched-launch` admits and launches (key = Assignment id), `watch` follows a launched instance until it ends,
 * harvests it and settles the occurrence (key = instance name). The census hook re-admits waiting occurrences hourly.
 * Engine facts: a launch starts the Assignment and delivers the occurrence's Input; a final occurrence reports `ready`
 * (done) or `failed` then `dropped`, which ends the Ticket and keeps later standing Inputs for its next wake (core c0-c4).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { latestAssignment, liveTicket, runningAssignment, type Assignment, type Executor, type Ticket } from '../core/index.ts'
import type { EngineForExecutor } from '../core/engine.ts'
import { Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import { admit } from '../scheduled/admission.ts'
import { harvest } from '../scheduled/harvest.ts'
import { agencyOf, FINAL, readmittable, type ShownWorkflow } from '../scheduled/intake.ts'
import type { CensusRecord } from '../scheduled/spool.ts'
import { launchRun, renderTask, runArgv, runEnv, writeTaskOnce, type ExecFunction } from '../scheduled/launch.ts'
import { floorLog as defaultLog, type FloorEvent, type FloorField } from '../scheduled/log.ts'
import { instanceName, labels } from '../scheduled/names.ts'
import { settle, type SettleResult, type Verdict as SettleVerdict } from '../scheduled/settle.ts'
import { attemptsOf, insertAttempt, occurrence as occurrenceRow, updateAttempt, updateOccurrence, upsertWorkflow, workflow as workflowRow,
  type SchedOccurrence } from '../scheduled/store.ts'
import { verdictOf, type DshdGet } from '../scheduled/verdict.ts'

export interface SchedCliPort {
  show(id: string): Promise<unknown>
  env(id: string, occ: string, attempt: number | string): Promise<Record<string, string>>
  check(id: string, occ: string, attempt: number | string): Promise<{ holds: boolean; exit: number | null; output?: unknown }>
  gate(id: string, occ: string, attempt: number | string): Promise<{ deferred: string | null }>
}
export interface DshdExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'report'>
  readonly store: Store
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly cli: SchedCliPort
  paused(): boolean
  closing(): boolean
  /** Worker slots for scheduled runs (`executor.maxWorkers`). */
  maxWorkers(): number
  /** The dshd binary; default `/run/current-system/sw/bin/dshd`. */
  dshd?: string
  /** Runs dshd (and anything else the executor spawns); injectable for tests. */
  exec?: ExecFunction
  /** The floor's own environment, from which `runEnv` keeps only the allowlisted names. */
  baseEnv?: Record<string, string | undefined>
  /** `CLAUDE_CONFIG_DIR` for runs, only when Settings name a seat. */
  seatConfigDir?: () => string | null
  now?: () => Date
  log?: (event: FloorEvent, fields?: Record<string, FloorField>) => void
  /** Tells the main Session about missed, unmet, failed, held and interrupted occurrences. */
  notify?: (text: string) => void
}
export interface SchedLaunchPayload { ticketId: string; assignmentId: string; occurrence?: string; rerun?: boolean }
export interface WatchPayload { ticketId: string; assignmentId: string; occurrence: string; attempt: number; rerun: number; name: string; root: string }

declare module '../app/effects.ts' {
  interface EffectPayloads {
    /** Admit and launch one attempt of a scheduled occurrence; the key is the Assignment ID. */
    'sched-launch': SchedLaunchPayload
    /** Follow one dshd instance until it ends, then harvest and settle; the key is the instance name. */
    watch: WatchPayload
  }
}

const DSHD = '/run/current-system/sw/bin/dshd'
/** The schema's longest job.timeout: the bound on a run whose workflow cannot be shown mid-run (evaluation review, C5.11). */
const UNSHOWN_TIMEOUT_MS = 24 * 3600_000
const iso = (date: Date) => date.toISOString()
/** The agency root of a workflow file `<root>/.agency/workflows/[proposed/]<stem>.jsonc`. */
export const rootOfFile = (file: string): string => file.replace(/\/\.agency\/workflows\/(?:proposed\/)?[^/]+\.jsonc$/u, '')
const stemOf = (workflowId: string) => workflowId.slice(workflowId.lastIndexOf(':') + 1)
const agencyIdOf = (workflowId: string) => workflowId.slice(0, workflowId.lastIndexOf(':'))
export const isScheduled = (ticket: Ticket): boolean => (ticket.mandate?.basis as { via?: string } | undefined)?.via === 'schedule'

/** Runs scheduled Tickets' occurrences as dshd instances: admit, launch, watch, harvest, settle (DESIGN 7.5, 7.6). */
export class DshdExecutor implements Executor {
  private readonly log: NonNullable<DshdExecutorHost['log']>
  private readonly now: () => Date
  constructor(private readonly host: DshdExecutorHost) {
    this.log = host.log ?? defaultLog
    this.now = host.now ?? (() => new Date())
    host.effects.handle('sched-launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : 1, retry: [30_000, 300_000] })
    host.effects.handle('watch', payload => this.watch(payload), { limit: () => 8, retry: [30_000, 30_000], quiet: true })
  }
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('sched-launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** A headless run takes no Inputs mid-run; an answer to a held occurrence starts a new attempt that carries it. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const held = this.host.store.db.prepare(`SELECT occurrence FROM sched_occurrences WHERE state='held' AND reason='blocked'
      AND workflow_id=? ORDER BY updated_at DESC LIMIT 1`).get(this.workflowOf(ticket) ?? '') as { occurrence: string } | undefined
    if (held) this.host.effects.enqueue('sched-launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id, occurrence: held.occurrence, rerun: true })
  }
  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    const workflowId = this.workflowOf(ticket)
    if (!workflowId) return
    const open = this.host.store.db.prepare(`SELECT a.instance FROM sched_attempts a JOIN sched_occurrences o ON o.occurrence=a.occurrence
      WHERE o.workflow_id=? AND a.ended_at IS NULL`).all(workflowId) as unknown as { instance: string }[]
    for (const { instance } of open) {
      this.stopped.add(instance)
      void this.dshd(['stop', '--json', instance]).catch(() => {})
      this.log('settle', { name: instance, action: 'stop', reason })
    }
  }
  /** Instances stopped by a person's stop of the Ticket; their watch settles them `cancelled`. */
  private readonly stopped = new Set<string>()

  /** Census hook: re-admit deferred occurrences and due retries, and re-run the check of awaiting ones (DESIGN 7.2). */
  async onCensus(_census: CensusRecord): Promise<void> {
    const at = this.now()
    for (const occ of readmittable(this.host.store, at)) {
      const ticket = this.ticketOfWorkflow(occ.workflow_id)
      const assignment = ticket && latestAssignment(ticket)
      if (!ticket || !liveTicket(ticket) || !assignment || assignment.state === 'ended') continue
      // One effect per occurrence: the queue upserts on its key, so a shared key would keep only the last one.
      this.host.effects.enqueue('sched-launch', `${assignment.id}:${occ.occurrence}`, { ticketId: ticket.id, assignmentId: assignment.id, occurrence: occ.occurrence })
    }
    const awaiting = this.host.store.db.prepare(`SELECT * FROM sched_occurrences WHERE state='awaiting'`).all() as unknown as SchedOccurrence[]
    for (const occ of awaiting) {
      try {
        const checked = await this.host.cli.check(occ.workflow_id, occ.occurrence, occ.attempt)
        if (!checked.holds) continue
        this.host.store.atomic(() => { updateOccurrence(this.host.store, occ.occurrence, { state: 'done', reason: 'check holds at census', updated_at: iso(at) }) })
        this.finish(undefined, occ.workflow_id, 'done', 'The outcome check holds now.')
      } catch (error) { this.log('error', { occ: occ.occurrence, error: String(error) }) }
    }
  }

  /** On floor start: every open attempt without a durable `watch` row gets one (DESIGN 7.6 resume). */
  resume(pendingWatch: (name: string) => boolean): void {
    const open = this.host.store.db.prepare(`SELECT a.*, o.workflow_id FROM sched_attempts a JOIN sched_occurrences o ON o.occurrence=a.occurrence
      WHERE a.ended_at IS NULL`).all() as unknown as { occurrence: string; attempt: number; rerun: number; instance: string; workflow_id: string }[]
    for (const row of open) {
      if (pendingWatch(row.instance)) continue
      const ticket = this.ticketOfWorkflow(row.workflow_id)
      const assignment = ticket && (runningAssignment(ticket) ?? latestAssignment(ticket))
      const wf = workflowRow(this.host.store, row.workflow_id)
      if (!ticket || !assignment || !wf) continue
      this.host.effects.enqueue('watch', row.instance, { ticketId: ticket.id, assignmentId: assignment.id, occurrence: row.occurrence,
        attempt: row.attempt, rerun: row.rerun, name: row.instance, root: rootOfFile(wf.file) })
    }
  }

  private workflowOf(ticket: Ticket): string | undefined {
    const basis = ticket.mandate?.basis as { workflow?: string } | undefined
    if (basis?.workflow) return basis.workflow
    const row = this.host.store.db.prepare('SELECT id FROM sched_workflows WHERE ticket_id=?').get(ticket.id) as { id: string } | undefined
    return row?.id
  }
  private ticketOfWorkflow(workflowId: string): Ticket | undefined {
    const wf = workflowRow(this.host.store, workflowId)
    return wf?.ticket_id ? this.host.store.tickets.get(wf.ticket_id) : undefined
  }
  private async dshd(args: string[]): Promise<{ code: number; stdout: string }> {
    const exec = this.host.exec ?? defaultExec
    return await exec(this.host.dshd ?? DSHD, args, { env: process.env as Record<string, string | undefined> })
  }

  /**
   * The occurrence the ticket runs next: its origin Trigger's while that one still waits (an accepted Ticket's first
   * occurrence is its origin, not an Input), then the first undelivered standing Input's.
   */
  private nextInput(ticket: Ticket): { inputId?: string; occurrence: string } | undefined {
    const waiting = (occurrence: unknown): occurrence is string => {
      if (typeof occurrence !== 'string') return false
      const row = occurrenceRow(this.host.store, occurrence)
      return !!row && row.state !== 'running' && !FINAL.has(row.state)
    }
    const origin = (this.host.store.triggers.get(ticket.origin.triggerId)?.meta as { occurrence?: unknown } | undefined)?.occurrence
    if (waiting(origin)) return { occurrence: origin }
    for (const id of ticket.undelivered) {
      const input = ticket.inputs.find(item => item.id === id)
      if (input?.kind !== 'trigger' || !input.standing) continue
      const occurrence = (this.host.store.triggers.get(input.triggerId)?.meta as { occurrence?: unknown } | undefined)?.occurrence
      if (typeof occurrence === 'string') return { inputId: input.id, occurrence }
    }
    return undefined
  }
  private inputOf(ticket: Ticket, occurrence: string): string | undefined {
    return ticket.inputs.find(input => {
      if (input.kind !== 'trigger') return false
      const trigger = this.host.store.triggers.get(input.triggerId)
      return (trigger?.meta as { occurrence?: unknown } | undefined)?.occurrence === occurrence
    })?.id
  }
  /** Starts the Assignment if still pending and delivers the occurrence's Input, so the Ticket does not run it twice. */
  private take(ticketId: string, assignmentId: string, inputId: string | undefined): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (assignment?.state === 'pending') this.host.engine.assignmentStarted(ticketId, assignmentId)
    if (inputId) this.host.engine.inputsDelivered(ticketId, assignmentId, [inputId])
  }
  /**
   * Ends the Ticket for a final occurrence: `ready` for done, `blocked` for held, else `dropped`. The Ticket comes from the
   * caller when it has one: `sched_workflows.ticket_id` is unset until a census has listed the workflow.
   */
  private finish(ticketId: string | undefined, workflowId: string, state: string, summary: string, question?: string): void {
    const ticket = (ticketId ? this.host.store.tickets.get(ticketId) : undefined) ?? this.ticketOfWorkflow(workflowId)
    if (!ticket || !liveTicket(ticket)) return
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.state === 'ended') return
    // Another occurrence of this workflow is running on the same Ticket: a report now would end the Ticket, and ending it
    // stops every open attempt of the workflow, that run included. Its own settle reports for the Ticket instead
    // (evaluation review, C5.5 and C5.12).
    const busy = this.host.store.db.prepare(`SELECT o.occurrence FROM sched_occurrences o WHERE o.workflow_id=? AND (o.state='running'
      OR EXISTS (SELECT 1 FROM sched_attempts a WHERE a.occurrence=o.occurrence AND a.ended_at IS NULL)) LIMIT 1`).get(workflowId) as { occurrence: string } | undefined
    if (busy) {
      this.log('defer', { workflow: workflowId, decision: 'ticket-busy', running: busy.occurrence, report: state })
      return
    }
    try {
      this.host.store.atomic(() => {
        if (assignment.state === 'pending') this.host.engine.assignmentStarted(ticket.id, assignment.id)
        if (state === 'done' || state === 'satisfied') this.host.engine.report(ticket.id, { state: 'ready', summary })
        else if (state === 'held') this.host.engine.report(ticket.id, { state: 'blocked', summary, question: question ?? summary })
        else {
          // `dropped`, not `failed` first: a failed report strips the Ticket's undelivered standing Inputs (assignments.ts
          // report), which would strand the workflow's occurrences already waiting on it (finding 6, 12 Nov review).
          this.host.engine.report(ticket.id, { state: 'dropped', summary: `Occurrence ${state}: ${summary} The workflow waits for its next occurrence.`.slice(0, 2000) })
        }
      })
    } catch (error) { this.log('error', { workflow: workflowId, report: state, error: String(error) }) }
    if (['missed', 'unmet', 'failed', 'held', 'interrupted'].includes(state)) this.host.notify?.(`Scheduled ${workflowId}: ${state}. ${summary}`)
  }

  private async launchQueued(payload: SchedLaunchPayload): Promise<void> {
    if (this.host.closing()) throw new Error('the floor is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    const store = this.host.store
    const ticket = store.tickets.get(payload.ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || !assignment || assignment.id !== payload.assignmentId || assignment.state === 'ended') return
    const picked = payload.occurrence ? { occurrence: payload.occurrence, inputId: this.inputOf(ticket, payload.occurrence) } : this.nextInput(ticket)
    if (!picked) {
      this.log('defer', { ticket: ticket.id, decision: 'nothing-to-run' })
      if (assignment.state === 'pending') this.finish(ticket.id, this.workflowOf(ticket) ?? '', 'cancelled', 'Nothing left to run.')
      return
    }
    const occ = occurrenceRow(store, picked.occurrence)
    if (!occ) { this.log('error', { occ: picked.occurrence, error: 'no sched_occurrences row' }); return }
    const at = this.now()
    store.atomic(() => { store.db.prepare('UPDATE sched_workflows SET ticket_id=? WHERE id=?').run(ticket.id, occ.workflow_id) })
    if (FINAL.has(occ.state)) {
      this.take(ticket.id, assignment.id, picked.inputId)
      this.finish(ticket.id, occ.workflow_id, occ.state, `Occurrence ${occ.occurrence} is ${occ.state}${occ.reason ? `: ${occ.reason}` : ''}.`)
      return
    }
    if (occ.state === 'running' || (occ.state === 'held' && !payload.rerun)) return
    const shown = await this.host.cli.show(occ.workflow_id).catch((error: unknown) => ({ error: String(error) })) as ShownWorkflow | { error: string }
    if ('error' in shown || !shown.spec) {
      store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'held', reason: 'invalid', updated_at: iso(at) }) })
      this.log('held', { occ: occ.occurrence, reason: 'invalid' })
      return
    }
    // A manual run can arrive before any census lists its workflow (run now on a file just written): the show at hand
    // proves the file, so record the workflow from it; the next census reconciles the row (finding 1, 12 Nov review).
    if (!workflowRow(store, occ.workflow_id) && typeof shown.path === 'string') {
      store.atomic(() => {
        upsertWorkflow(store, { id: occ.workflow_id, agency: agencyOf(occ.workflow_id), file: shown.path as string,
          state: shown.spec?.enabled ? 'valid' : 'disabled', revision: shown.revision ?? null, problems: '[]', ticket_id: ticket.id,
          first_seen: iso(at), changed_at: iso(at) })
      })
    }
    const running = store.db.prepare(`SELECT grp FROM sched_occurrences WHERE state='running'`).all() as unknown as { grp: string }[]
    const decision = payload.rerun ? { decision: running.some(row => row.grp === occ.grp) ? 'wait-group' : 'launch' as const }
      : await admit({ occurrence: occ, census: workflowRow(store, occ.workflow_id), now: at, cli: this.host.cli as never,
        runningGroups: new Set(running.map(row => row.grp)), freeSlots: this.host.maxWorkers() - running.length,
        hasCheck: !!shown.spec.outcome?.check, log: this.log })
    switch (decision.decision) {
      case 'cancelled': case 'missed': case 'satisfied':
        store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: decision.decision, reason: (decision as { reason?: string }).reason ?? null, updated_at: iso(at) }) })
        this.take(ticket.id, assignment.id, picked.inputId)
        this.finish(ticket.id, occ.workflow_id, decision.decision, `Occurrence ${occ.occurrence}: ${decision.decision}.`)
        return
      case 'held':
        store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'held', reason: (decision as { reason?: string }).reason ?? 'invalid', updated_at: iso(at) }) })
        return
      case 'wait-group':
        return
      case 'deferred':
        store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'deferred', reason: (decision as { reason?: string }).reason ?? null, updated_at: iso(at) }) })
        return
      case 'later':
        throw new Later('No free worker slot')
    }
    await this.launch(ticket, assignment, occ, shown, picked.inputId, !!payload.rerun)
  }

  private async launch(ticket: Ticket, assignment: Assignment, occ: SchedOccurrence, shown: ShownWorkflow, inputId: string | undefined, rerun: boolean): Promise<void> {
    const store = this.host.store
    const at = this.now()
    const wf = workflowRow(store, occ.workflow_id)
    const root = wf ? rootOfFile(wf.file) : (typeof shown.path === 'string' ? rootOfFile(shown.path) : '')
    if (!root) { this.log('error', { occ: occ.occurrence, error: 'no agency root' }); return }
    const attempt = rerun ? Math.max(1, occ.attempt) : occ.attempt + 1
    const previous = attemptsOf(store, occ.occurrence)
    const ulid = occ.kind === 'manual' ? occ.occurrence.slice(occ.occurrence.lastIndexOf(':') + 1) : undefined
    const name = instanceName({ agency: agencyIdOf(occ.workflow_id), stem: stemOf(occ.workflow_id), instant: occ.instant,
      kind: occ.kind === 'manual' ? 'manual' : 'scheduled', ...ulid ? { ulid } : {}, rerun: previous.length })
    const runDir = join(root, '.agency', 'runs', name)
    const spec = shown.spec
    const cut = rerun ? previous.at(-1) : undefined
    const text = renderTask({
      spec: { id: occ.workflow_id, name: spec.name, revision: shown.revision, prompt: spec.job?.prompt ?? '' },
      occurrence: { key: occ.occurrence, instant: occ.instant, missed: occ.missed, ...occ.deadline ? { deadline: occ.deadline } : {} },
      attempt,
      history: previous.map(row => ({ attempt: row.attempt, instance: row.instance, ending: row.ending, report: row.report })),
      interrupted: cut ? `Attempt ${cut.attempt} (${cut.instance}) was cut; its journal: journalctl --user -u dshd@${cut.instance}.service` : null,
    })
    if (writeTaskOnce(runDir, text) === 'different') {
      store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'held', reason: 'task.md differs (bug)', updated_at: iso(at) }) })
      this.log('held', { occ: occ.occurrence, name, reason: 'task-md-differs' })
      return
    }
    const sched = await this.host.cli.env(occ.workflow_id, occ.occurrence, attempt)
    const env = runEnv({ base: this.host.baseEnv ?? process.env, sched, seatConfigDir: this.host.seatConfigDir?.() ?? null })
    const permissions = spec.permissions as { mode?: string; add_dirs?: string[] } | undefined
    const argv = runArgv({ name, root, mode: permissions?.mode ?? 'workspace-write', addDirs: permissions?.add_dirs ?? [],
      labels: labels({ agency: root, workflow: occ.workflow_id, occurrence: occ.occurrence, attempt, revision: shown.revision }) as unknown as Record<string, string> })
    const result = await launchRun({ argv, env, ...this.host.exec ? { exec: this.host.exec } : {} })
    if (result.outcome === 'retry') throw new Later(`dshd unavailable: ${result.detail}`)
    if (result.outcome === 'held') {
      store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'held', reason: result.detail.slice(0, 300), updated_at: iso(at) }) })
      this.log('held', { occ: occ.occurrence, name, reason: result.detail })
      this.finish(ticket.id, occ.workflow_id, 'held', `dshd refused ${name}: ${result.detail}`)
      return
    }
    if (result.outcome === 'failed') {
      // dshd did not start the run (start-failed, exit 1, an unknown answer): no attempt exists to watch (finding 5).
      store.atomic(() => { updateOccurrence(store, occ.occurrence, { state: 'failed', reason: `launch: ${result.detail}`.slice(0, 300), updated_at: iso(at) }) })
      this.log('settle', { occ: occ.occurrence, name, state: 'failed', reason: result.detail })
      this.take(ticket.id, assignment.id, inputId)
      this.finish(ticket.id, occ.workflow_id, 'failed', `dshd could not start ${name}: ${result.detail}`)
      return
    }
    store.atomic(() => {
      insertAttempt(store, { occurrence: occ.occurrence, attempt, rerun: previous.length, instance: name, revision: shown.revision,
        invocation: null, started_at: iso(at), ended_at: null, ending: null, exit_code: null, report: null })
      updateOccurrence(store, occ.occurrence, { state: 'running', reason: null, attempt, ...rerun ? { reruns: occ.reruns + 1 } : {}, updated_at: iso(at) })
      this.take(ticket.id, assignment.id, inputId)
      this.host.effects.enqueue('watch', name, { ticketId: ticket.id, assignmentId: assignment.id, occurrence: occ.occurrence, attempt,
        rerun: previous.length, name, root })
    })
    this.log('launch', { occ: occ.occurrence, name, attempt, result: result.outcome })
  }

  private async watch(payload: WatchPayload): Promise<void> {
    const store = this.host.store
    const occ = occurrenceRow(store, payload.occurrence)
    if (!occ) return
    const got = await this.dshd(['get', '--json', payload.name])
    if (got.code === 3) return this.lost(payload, occ)
    if (got.code !== 0) throw new Error(`dshd get ${payload.name} exited ${got.code}`)
    const get = JSON.parse(got.stdout) as DshdGet & { lastRun?: { invocationId?: string; startedAt?: number; endedAt?: number; ending?: string; child?: { exitCode?: number } } }
    let verdict = verdictOf(get) as string
    if (verdict === 'running') {
      const shown = await this.host.cli.show(occ.workflow_id).catch(() => undefined) as ShownWorkflow | undefined
      // A workflow that cannot be shown now (removed, invalid, a CLI timeout) leaves its running attempt alone (DESIGN
      // 7.2), up to the schema's longest timeout; the validator fills job.timeout_ms (3 h by default) otherwise.
      const timeout = shown?.spec?.job?.timeout_ms ?? UNSHOWN_TIMEOUT_MS
      const started = attemptsOf(store, occ.occurrence).find(row => row.instance === payload.name)?.started_at
      if (!started || Date.parse(started) + timeout > this.now().getTime()) throw new Later('still running')
      const stopped = await this.dshd(['stop', '--json', payload.name])
      if (stopped.code !== 0) throw new Error(`dshd stop ${payload.name} exited ${stopped.code}`)
      verdict = 'timeout'
    }
    const harvested = await harvest({ name: payload.name, runDir: join(payload.root, '.agency', 'runs', payload.name),
      exec: async (_cmd, args) => await this.dshd(args),
      readFile: path => { try { return readFileSync(path, 'utf8') } catch { return null } },
      // Slice 1: dshd keeps the final answer; the DSH session log fallback is not wired yet.
      sessionLog: async () => '' })
    let check: { holds: boolean } | null = null
    const shown = await this.host.cli.show(occ.workflow_id).catch(() => undefined) as ShownWorkflow | undefined
    if (verdict === 'completed' && shown?.spec?.outcome?.check) {
      try { check = await this.host.cli.check(occ.workflow_id, occ.occurrence, payload.attempt) } catch { check = { holds: false } }
    }
    const attempts = shown?.spec?.outcome?.attempts ?? 1
    const at = this.now()
    const result: SettleResult = settle({ verdict: verdict as SettleVerdict, report: harvested.report, check,
      attemptsLeft: payload.attempt < attempts, windowOpen: !occ.deadline || Date.parse(occ.deadline) > at.getTime(),
      reruns: occ.reruns, stoppedBy: this.stopped.delete(payload.name) ? 'tom' : null, endedAt: get.lastRun?.endedAt ?? Math.floor(at.getTime() / 1000) })
    const report = harvested.report ? JSON.stringify(harvested.report) : harvested.answer
    store.atomic(() => {
      updateAttempt(store, payload.occurrence, payload.attempt, payload.rerun, { ended_at: iso(at), ending: get.lastRun?.ending ?? verdict,
        exit_code: typeof get.lastRun?.child?.exitCode === 'number' ? get.lastRun.child.exitCode : null,
        report: report ? report.slice(0, 8192) : null, invocation: get.lastRun?.invocationId ?? harvested.invocationId ?? null })
      updateOccurrence(store, payload.occurrence, { state: result.occurrence, reason: result.reason ?? null,
        next_try_at: result.nextTryAt ? result.nextTryAt.toISOString() : null,
        updated_at: iso(at) })
    })
    this.log('watch-end', { occ: payload.occurrence, name: payload.name, verdict })
    this.log('settle', { occ: payload.occurrence, state: result.occurrence, reason: result.reason ?? null })
    if (result.rerun) {
      this.host.effects.enqueue('sched-launch', `${payload.assignmentId}:rerun`, { ticketId: payload.ticketId, assignmentId: payload.assignmentId, occurrence: payload.occurrence, rerun: true })
      return
    }
    if (result.occurrence === 'queued') return
    const summary = harvested.report?.summary ?? (harvested.answer ? harvested.answer.slice(0, 1500) : `Run ${payload.name}: ${verdict}.`)
    this.finish(payload.ticketId, occ.workflow_id, result.occurrence, summary, result.attention)
  }

  /** dshd no longer knows the instance: relaunch once as a rerun, then settle `failed` (DESIGN 7.6 resume). */
  private lost(payload: WatchPayload, occ: SchedOccurrence): void {
    const store = this.host.store
    const at = this.now()
    if (payload.rerun === 0 && occ.reruns === 0) {
      store.atomic(() => {
        updateAttempt(store, payload.occurrence, payload.attempt, payload.rerun, { ended_at: iso(at), ending: 'not-found' })
        updateOccurrence(store, payload.occurrence, { state: 'queued', reason: 'instance not found', updated_at: iso(at) })
      })
      this.host.effects.enqueue('sched-launch', `${payload.assignmentId}:rerun`, { ticketId: payload.ticketId, assignmentId: payload.assignmentId, occurrence: payload.occurrence, rerun: true })
      return
    }
    store.atomic(() => {
      updateAttempt(store, payload.occurrence, payload.attempt, payload.rerun, { ended_at: iso(at), ending: 'not-found' })
      updateOccurrence(store, payload.occurrence, { state: 'failed', reason: 'instance-lost', updated_at: iso(at) })
    })
    this.finish(payload.ticketId, occ.workflow_id, 'failed', `Instance ${payload.name} was lost twice.`)
  }
}

/** Routes scheduled Tickets (Mandate basis `schedule`) to dshd and every other Ticket to the in-process executor. */
export class RoutingExecutor implements Executor {
  constructor(private readonly scheduled: Executor, private readonly other: Executor) {}
  start(ticket: Ticket, assignment: Assignment): void { (isScheduled(ticket) ? this.scheduled : this.other).start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { (isScheduled(ticket) ? this.scheduled : this.other).deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { (isScheduled(ticket) ? this.scheduled : this.other).stop(ticket, assignment, reason) }
}

const defaultExec: ExecFunction = async (file, args, { env }) => {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    // A process killed by a signal (a timeout) has no exit code: never read it as success.
    child.on('close', (code, signal) => { resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }) })
  })
}
