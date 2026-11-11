/**
 * Spool intake for the `scheduled` Source (DESIGN 7.2): occurrence and manual files become one standing Trigger plus one
 * `sched_occurrences` row; census files reconcile `sched_workflows` and re-admit waiting occurrences. The census is the
 * floor's only clock for scheduling decisions.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { key, type ReceiveResult, type Trigger } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { KV } from '../kv.ts'
import { floorLog as defaultLog, type FloorEvent, type FloorField } from './log.ts'
import { listIncoming, moveDone, parseRecord, reject, type CensusRecord, type ManualRecord, type OccurrenceRecord } from './spool.ts'
import { insertOccurrence, occurrence as occurrenceRow, updateOccurrence, upsertWorkflow, workflow as workflowRow, type SchedOccurrence } from './store.ts'

export interface Agency { id: string; root: string; enabled: boolean }
/** What `scheduled show <id> --json` prints (only the fields the floor reads). */
export interface ShownWorkflow {
  id: string
  revision: string
  state?: string
  kind?: string
  spec: {
    name: string
    enabled: boolean
    window_ms?: number | null
    concurrency?: { group?: string; queue?: 'single' | 'all' | string }
    on?: { dispatch?: { inputs?: Record<string, unknown> } }
    outcome?: { goal?: string; check?: unknown; attempts?: number }
    job?: { prompt?: string; cwd?: string; timeout_ms?: number }
    [key: string]: unknown
  }
  [key: string]: unknown
}
export type Show = (id: string) => Promise<ShownWorkflow | { error: string }>
export type Log = (event: FloorEvent, fields?: Record<string, FloorField>) => void

export interface IntakeDeps {
  spoolDir: string
  store: Store
  receive: (trigger: Trigger) => ReceiveResult | Promise<ReceiveResult>
  show: Show
  agencies: Agency[]
  /** Called once per census file after the built-in reconcile (the executor re-admits waiting occurrences there). */
  census?: (record: CensusRecord) => void | Promise<void>
  /** The machine id recorded by the heartbeat; a census naming another pauses intake (C4.12). */
  machineId?: () => string | undefined
  now?: () => Date
  log?: Log
}

export interface IntakeResult { processed: number; rejected: number; paused?: 'machine_changed' }

/** Final occurrence states (DESIGN 7.3); everything else still waits on the floor. */
export const FINAL = new Set(['done', 'satisfied', 'missed', 'superseded', 'cancelled', 'unmet', 'failed', 'interrupted', 'refused', 'ignored'])

/** The deterministic Trigger id of an occurrence, so a repeated spool file is `duplicate`. */
export const occurrenceTriggerId = (occurrence: string): string => key('scheduled', occurrence)

/** The agency id a spool record belongs to (the workflow id before its colon). */
export const agencyOf = (workflowId: string): string => workflowId.slice(0, workflowId.lastIndexOf(':'))

/** Builds the standing Trigger for an occurrence (DESIGN 7.2 step 3); `text` carries name, goal and prompt. */
export function occurrenceTrigger(record: OccurrenceRecord | ManualRecord, shown: ShownWorkflow): Trigger {
  const agencyId = agencyOf(record.workflow)
  const spec = shown.spec
  const text = [`Scheduled ${record.kind === 'manual' ? 'run now' : 'occurrence'} of ${record.workflow}: ${spec.name}`,
    ...spec.outcome?.goal ? [`Goal: ${spec.outcome.goal}`] : [],
    ...spec.job?.prompt ? ['', spec.job.prompt] : []].join('\n')
  const { v: _v, ...fields } = record
  return {
    id: occurrenceTriggerId(record.occurrence), source: 'scheduled', threads: [{ source: 'scheduled', id: record.workflow }],
    actor: { source: 'scheduled', id: agencyId }, human: false, standing: true, at: record.kind === 'manual' ? record.at : record.instant,
    text, meta: { ...fields, name: spec.name, revision: shown.revision ?? record.revision ?? null },
  }
}

const iso = (date: Date) => date.toISOString()

/** Processes every file waiting in `incoming/`, in order. Never throws for one bad file. */
export async function intakeOnce(deps: IntakeDeps): Promise<IntakeResult> {
  const log = deps.log ?? defaultLog
  const now = deps.now ?? (() => new Date())
  const result: IntakeResult = { processed: 0, rejected: 0 }
  // A file is moved aside at most once; a failure to move it is logged and never stops the pass (second review, 12 Nov).
  const setAside = (name: string, error: string): void => {
    try { reject(deps.spoolDir, name, error) } catch (moveError) { log('error', { file: name, reject: String(moveError) }) }
    log('reject', { file: name, error })
    result.rejected++
  }
  for (const name of listIncoming(deps.spoolDir)) {
    let text: string
    try { text = readFileSync(join(deps.spoolDir, 'incoming', name), 'utf8') } catch (error) {
      // Gone meanwhile: nothing to do. Unreadable (a directory, no permission): set aside, never retried each poll.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') setAside(name, `unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
      continue
    }
    const parsed = parseRecord(text)
    if (!parsed.ok) {
      setAside(name, parsed.error)
      continue
    }
    const record = parsed.record
    if (record.kind === 'census') {
      const recorded = deps.machineId?.()
      if (recorded && record.machineId && recorded !== record.machineId) {
        log('error', { census: name, reason: 'machine_changed', recorded, census_machine: record.machineId })
        result.paused = 'machine_changed'
        return result
      }
      reconcile(deps.store, record, now(), log)
      await deps.census?.(record)
      moveDone(deps.spoolDir, name)
      log('census', { file: name, workflows: record.workflows.length })
      result.processed++
      continue
    }
    let handedOffMs: number | undefined
    try { handedOffMs = statSync(join(deps.spoolDir, 'incoming', name)).mtimeMs } catch { /* gone: the move below fails and logs */ }
    try {
      await occurrenceFile(deps, record, now(), log, handedOffMs)
      moveDone(deps.spoolDir, name)
      result.processed++
    } catch (error) {
      // A failure that is not the file's fault (a busy database, a show timeout) leaves the file for the next poll.
      log('error', { file: name, error: String(error) })
    }
  }
  return result
}

/** How long a failing `scheduled show` is retried, poll after poll, before the occurrence is held or refused (evaluation review, C4.8). */
export const SHOW_RETRY_MS = 600_000

async function occurrenceFile(deps: IntakeDeps, record: OccurrenceRecord | ManualRecord, at: Date, log: Log, handedOffMs?: number): Promise<void> {
  const store = deps.store
  const agencyId = agencyOf(record.workflow)
  const listed = deps.agencies.find(agency => agency.id === agencyId && agency.enabled)
  const base: Omit<SchedOccurrence, 'state' | 'reason' | 'grp' | 'deadline'> = {
    occurrence: record.occurrence, workflow_id: record.workflow, kind: record.kind, instant: record.kind === 'manual' ? record.at : record.instant,
    missed: record.missed, attempt: 0, reruns: 0, next_try_at: null, by: record.by ?? null,
    inputs: record.kind === 'manual' ? JSON.stringify(record.inputs ?? {}) : null, updated_at: iso(at),
  }
  if (!listed) {
    store.atomic(() => { insertOccurrence(store, { ...base, grp: record.workflow, deadline: null, state: 'cancelled', reason: 'agency_not_listed' }) })
    log('intake', { occ: record.occurrence, state: 'cancelled', reason: 'agency_not_listed' })
    return
  }
  const shown = await deps.show(record.workflow)
  if ('error' in shown) {
    // Most show failures pass (a timeout, a busy host): leave the file for the next poll, for up to SHOW_RETRY_MS
    // after its hand-off; only then is the occurrence held (scheduled) or refused (manual).
    if (handedOffMs !== undefined && at.getTime() >= handedOffMs && at.getTime() - handedOffMs < SHOW_RETRY_MS) throw new Error(`scheduled show failed, retried next poll: ${shown.error}`)
    if (record.kind === 'manual') {
      store.atomic(() => { insertOccurrence(store, { ...base, grp: record.workflow, deadline: null, state: 'refused', reason: `show: ${shown.error}`.slice(0, 300) }) })
      log('intake', { occ: record.occurrence, state: 'refused', reason: 'show-failed' })
      return
    }
    // The workflow vanished or became invalid between the tick and now: hold it; the census decides its fate.
    store.atomic(() => { insertOccurrence(store, { ...base, grp: record.workflow, deadline: null, state: 'held', reason: 'invalid' }) })
    log('held', { occ: record.occurrence, reason: 'invalid' })
    return
  }
  if (record.kind === 'manual') {
    const refusal = shown.kind === 'proposal' ? 'proposal' : shown.state === 'invalid' ? 'invalid' : manualInputsProblem(shown, record.inputs ?? {})
    if (refusal) {
      store.atomic(() => { insertOccurrence(store, { ...base, grp: record.workflow, deadline: null, state: 'refused', reason: refusal }) })
      log('intake', { occ: record.occurrence, state: 'refused', reason: refusal })
      return
    }
  }
  const spec = shown.spec
  const grp = spec.concurrency?.group ?? record.workflow
  const deadline = record.kind === 'schedule' && spec.window_ms ? new Date(Date.parse(record.instant) + spec.window_ms).toISOString() : null
  const trigger = occurrenceTrigger(record, shown)
  const outcome = await deps.receive(trigger)
  store.atomic(() => {
    const inserted = insertOccurrence(store, { ...base, grp, deadline, state: 'queued', reason: null })
    if (inserted && spec.concurrency?.queue === 'single') supersede(store, grp, record.occurrence, at, log)
  })
  log('intake', { occ: record.occurrence, kind: record.kind, receive: outcome, grp })
}

function manualInputsProblem(shown: ShownWorkflow, inputs: Record<string, unknown>): string | undefined {
  const declared = shown.spec.on?.dispatch?.inputs ?? {}
  for (const name of Object.keys(inputs)) if (!(name in declared)) return `unknown input ${name}`
  return undefined
}

/** With `queue: single`, a newer queued occurrence turns older queued ones of the group `superseded` (C4.11). */
export function supersede(store: Store, grp: string, newest: string, at: Date, log: Log = defaultLog): void {
  const current = occurrenceRow(store, newest)
  if (!current) return
  const queued = store.db.prepare(`SELECT occurrence, instant FROM sched_occurrences WHERE grp=? AND state='queued' AND occurrence<>?`)
    .all(grp, newest) as unknown as { occurrence: string; instant: string }[]
  for (const older of queued) {
    if (older.instant > current.instant) continue
    updateOccurrence(store, older.occurrence, { state: 'superseded', reason: `by ${newest}`, updated_at: iso(at) })
    log('settle', { occ: older.occurrence, state: 'superseded', by: newest })
  }
}

/**
 * The census reconcile (DESIGN 7.2 "Census file", C4.10, C4.11): upsert `sched_workflows`; an absent workflow is
 * `removed`; `disabled`/`removed` cancel queued and deferred occurrences (a running attempt is left alone); `invalid`
 * holds queued ones; window ends turn waiting rows `missed` (never started) or `unmet` (checks failed).
 */
export function reconcile(store: Store, census: CensusRecord, at: Date, log: Log = defaultLog): { notify: string[] } {
  const notify: string[] = []
  store.atomic(() => {
    const seen = new Set<string>()
    for (const entry of census.workflows) {
      // A proposal carries its live workflow's id (discover.mjs); it is not that workflow (finding 3).
      if (/\/\.agency\/workflows\/proposed\//u.test(entry.file)) continue
      seen.add(entry.id)
      const before = workflowRow(store, entry.id)
      const state = entry.state === 'invalid' ? 'invalid' : entry.enabled ? 'valid' : 'disabled'
      const changed = !before || before.state !== state || before.revision !== entry.revision
      upsertWorkflow(store, { id: entry.id, agency: agencyOf(entry.id), file: entry.file, state, revision: entry.revision,
        problems: JSON.stringify(entry.problems ?? []), ticket_id: before?.ticket_id ?? null, first_seen: before?.first_seen ?? iso(at),
        changed_at: changed ? iso(at) : before!.changed_at })
      if (state === 'invalid' && changed) {
        notify.push(entry.id)
        log('invalid', { workflow: entry.id, rev: entry.revision })
      }
      if (state === 'disabled') cancelWaiting(store, entry.id, 'disabled', at, log)
      if (state === 'invalid') holdQueued(store, entry.id, at, log)
      if (state === 'valid') unholdInvalid(store, entry.id, at)
    }
    const known = store.db.prepare(`SELECT id FROM sched_workflows WHERE state<>'removed'`).all() as unknown as { id: string }[]
    for (const { id } of known) {
      if (seen.has(id)) continue
      store.db.prepare(`UPDATE sched_workflows SET state='removed', changed_at=? WHERE id=?`).run(iso(at), id)
      cancelWaiting(store, id, 'removed', at, log)
    }
    windowEnds(store, at, log)
    store.set(KV.scheduled.censusLast, census.at)
  })
  return { notify }
}

function cancelWaiting(store: Store, workflowId: string, reason: string, at: Date, log: Log): void {
  // Disabled stops scheduled occurrences only: run now works on a paused workflow (DESIGN 7.3; finding 2).
  const kinds = reason === 'disabled' ? ` AND kind<>'manual'` : ''
  const rows = store.db.prepare(`SELECT occurrence FROM sched_occurrences WHERE workflow_id=? AND state IN ('queued','deferred','held')${kinds}`)
    .all(workflowId) as unknown as { occurrence: string }[]
  for (const row of rows) {
    updateOccurrence(store, row.occurrence, { state: 'cancelled', reason, updated_at: iso(at) })
    log('settle', { occ: row.occurrence, state: 'cancelled', reason })
  }
}

function holdQueued(store: Store, workflowId: string, at: Date, log: Log): void {
  const rows = store.db.prepare(`SELECT occurrence FROM sched_occurrences WHERE workflow_id=? AND state IN ('queued','deferred')`)
    .all(workflowId) as unknown as { occurrence: string }[]
  for (const row of rows) {
    updateOccurrence(store, row.occurrence, { state: 'held', reason: 'invalid', updated_at: iso(at) })
    log('held', { occ: row.occurrence, reason: 'invalid' })
  }
}

function unholdInvalid(store: Store, workflowId: string, at: Date): void {
  store.db.prepare(`UPDATE sched_occurrences SET state='queued', reason=NULL, updated_at=? WHERE workflow_id=? AND state='held' AND reason='invalid'`)
    .run(iso(at), workflowId)
}

function windowEnds(store: Store, at: Date, log: Log): void {
  const rows = store.db.prepare(`SELECT occurrence, state, attempt FROM sched_occurrences
    WHERE deadline IS NOT NULL AND deadline <= ? AND state IN ('queued','deferred','awaiting')`).all(iso(at)) as unknown as SchedOccurrence[]
  for (const row of rows) {
    const state = row.state === 'awaiting' || row.attempt > 0 ? 'unmet' : 'missed'
    updateOccurrence(store, row.occurrence, { state, reason: 'window closed', updated_at: iso(at) })
    log('settle', { occ: row.occurrence, state, reason: 'window closed' })
  }
}

/** Occurrences the census re-admits: deferred ones, and queued ones whose retry time has come (DESIGN 7.2). */
export function readmittable(store: Store, at: Date): SchedOccurrence[] {
  return store.db.prepare(`SELECT * FROM sched_occurrences WHERE state='deferred'
    OR (state='queued' AND (next_try_at IS NULL OR next_try_at <= ?)) ORDER BY kind='manual' DESC, deadline IS NULL, deadline, instant`)
    .all(iso(at)) as unknown as SchedOccurrence[]
}
