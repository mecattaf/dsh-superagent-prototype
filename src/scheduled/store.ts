/** Typed row shapes and store accessors for the sched_* tables added in migration 11 → 12. */
import type { SQLInputValue } from 'node:sqlite'
import type { Store } from '../app/store.ts'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

/** A scheduled workflow discovered by the census. */
export interface SchedWorkflow {
  /** '<agency id>:<stem>' */
  id: string
  /** Agency root, real path. */
  agency: string
  /** The .jsonc file, real path. */
  file: string
  /** valid | invalid | disabled | removed */
  state: string
  /** 12 hex of sha256 of the workflow bytes, from the last census. */
  revision: string | null
  /** JSON list of problem strings, from the census. */
  problems: string | null
  /** The standing Ticket id, once accepted. */
  ticket_id: string | null
  /** ISO UTC of when the workflow was first seen. */
  first_seen: string
  /** ISO UTC of the last state change. */
  changed_at: string
}

/** A single scheduled or manual occurrence. */
export interface SchedOccurrence {
  /** '<wf>@<instant>' | '<wf>@manual:<ulid>' */
  occurrence: string
  workflow_id: string
  /** schedule | manual */
  kind: string
  /** ISO UTC; request time if manual. */
  instant: string
  missed: number
  /** instant + window, or null. */
  deadline: string | null
  /** Concurrency group. */
  grp: string
  /** State per section 7.3. */
  state: string
  reason: string | null
  attempt: number
  /** Count of reruns after interruptions. */
  reruns: number
  next_try_at: string | null
  /** Manual: requester. */
  by: string | null
  /** Manual: JSON inputs. */
  inputs: string | null
  updated_at: string
}

/** One attempt for a scheduled occurrence. */
export interface SchedAttempt {
  occurrence: string
  /** 1..3; a rerun keeps the number. */
  attempt: number
  rerun: number
  /** dshd instance name. */
  instance: string
  /** Revision from `scheduled show` at launch. */
  revision: string
  /** systemd InvocationID for journalctl. */
  invocation: string | null
  started_at: string
  ended_at: string | null
  /** dshd lastRun.ending */
  ending: string | null
  exit_code: number | null
  /** report.json or final answer, <= 8 KiB */
  report: string | null
}

// ---------------------------------------------------------------------------
// Workflow accessors
// ---------------------------------------------------------------------------

/** Insert or replace a workflow row. */
export function upsertWorkflow(store: Store, row: SchedWorkflow): void {
  store.db.prepare(`INSERT INTO sched_workflows (id, agency, file, state, revision, problems, ticket_id, first_seen, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET agency=excluded.agency, file=excluded.file, state=excluded.state,
      revision=excluded.revision, problems=excluded.problems, ticket_id=excluded.ticket_id,
      first_seen=excluded.first_seen, changed_at=excluded.changed_at`)
    .run(row.id, row.agency, row.file, row.state, row.revision, row.problems, row.ticket_id, row.first_seen, row.changed_at)
}

/** Read one workflow by id. */
export function workflow(store: Store, id: string): SchedWorkflow | undefined {
  const row = store.db.prepare('SELECT id, agency, file, state, revision, problems, ticket_id, first_seen, changed_at FROM sched_workflows WHERE id=?').get(id)
  return row ? (row as unknown as SchedWorkflow) : undefined
}

// ---------------------------------------------------------------------------
// Occurrence accessors
// ---------------------------------------------------------------------------

/** Insert a new occurrence row; returns false if the primary key already exists. */
export function insertOccurrence(store: Store, row: SchedOccurrence): boolean {
  const result = store.db.prepare(`INSERT OR IGNORE INTO sched_occurrences
    (occurrence, workflow_id, kind, instant, missed, deadline, grp, state, reason, attempt, reruns, next_try_at, by, inputs, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.occurrence, row.workflow_id, row.kind, row.instant, row.missed, row.deadline, row.grp, row.state, row.reason,
      row.attempt, row.reruns, row.next_try_at, row.by, row.inputs, row.updated_at)
  return Number(result.changes) > 0
}

/** Read one occurrence by its primary key. */
export function occurrence(store: Store, key: string): SchedOccurrence | undefined {
  const row = store.db.prepare('SELECT * FROM sched_occurrences WHERE occurrence=?').get(key)
  return row ? (row as unknown as SchedOccurrence) : undefined
}

/** List occurrences by state and optional concurrency group, ordered by instant. */
export function occurrencesByState(store: Store, state: string, grp?: string): SchedOccurrence[] {
  if (grp !== undefined) {
    return store.db.prepare('SELECT * FROM sched_occurrences WHERE state=? AND grp=? ORDER BY instant').all(state, grp) as unknown as SchedOccurrence[]
  }
  return store.db.prepare('SELECT * FROM sched_occurrences WHERE state=? ORDER BY instant').all(state) as unknown as SchedOccurrence[]
}

/** Update mutable fields on an existing occurrence row. */
export function updateOccurrence(store: Store, key: string, patch: Partial<Pick<SchedOccurrence, 'state' | 'reason' | 'attempt' | 'reruns' | 'next_try_at' | 'missed' | 'updated_at'>>): void {
  const sets: string[] = []
  const values: SQLInputValue[] = []
  for (const [col, val] of Object.entries(patch) as [string, SQLInputValue | undefined][]) {
    if (val === undefined) continue
    sets.push(`${col}=?`)
    values.push(val)
  }
  if (!sets.length) return
  values.push(key)
  store.db.prepare(`UPDATE sched_occurrences SET ${sets.join(', ')} WHERE occurrence=?`).run(...values)
}

// ---------------------------------------------------------------------------
// Attempt accessors
// ---------------------------------------------------------------------------

/** Insert a new attempt row; throws on duplicate (occurrence, attempt, rerun). */
export function insertAttempt(store: Store, row: SchedAttempt): void {
  store.db.prepare(`INSERT INTO sched_attempts
    (occurrence, attempt, rerun, instance, revision, invocation, started_at, ended_at, ending, exit_code, report)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.occurrence, row.attempt, row.rerun, row.instance, row.revision, row.invocation,
      row.started_at, row.ended_at, row.ending, row.exit_code, row.report)
}

/** Update terminal fields on an attempt after it finishes. */
export function updateAttempt(store: Store, occurrence: string, attempt: number, rerun: number,
  patch: Partial<Pick<SchedAttempt, 'ended_at' | 'ending' | 'exit_code' | 'report' | 'invocation'>>): void {
  const sets: string[] = []
  const values: SQLInputValue[] = []
  for (const [col, val] of Object.entries(patch) as [string, SQLInputValue | undefined][]) {
    if (val === undefined) continue
    sets.push(`${col}=?`)
    values.push(val)
  }
  if (!sets.length) return
  values.push(occurrence, attempt, rerun)
  store.db.prepare(`UPDATE sched_attempts SET ${sets.join(', ')} WHERE occurrence=? AND attempt=? AND rerun=?`).run(...values)
}

/** List all attempts for an occurrence, ordered by (attempt, rerun). */
export function attemptsOf(store: Store, occ: string): SchedAttempt[] {
  return store.db.prepare('SELECT * FROM sched_attempts WHERE occurrence=? ORDER BY attempt, rerun').all(occ) as unknown as SchedAttempt[]
}
