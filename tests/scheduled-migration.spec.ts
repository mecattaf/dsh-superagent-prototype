/**
 * Proves C4.7: opening a schema-11 database migrates it to schema 12 with the correct tables,
 * views, and KV entries, and sched_* writes inside atomic() roll back together with the domain change.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import {
  upsertWorkflow, insertOccurrence, occurrence, occurrencesByState,
  updateOccurrence, insertAttempt, updateAttempt, attemptsOf,
  type SchedWorkflow, type SchedOccurrence, type SchedAttempt,
} from '../src/scheduled/store.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'sched-migration-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/**
 * Build a schema-11 database using the same code path the existing build used:
 * create a fresh Store (which produces schema 12 now), then manually reset the schema
 * version to 11 and drop the sched_* objects so the next open runs the 11→12 step.
 */
function schema11(path: string): void {
  // Spin up a fresh db through the Store constructor (runs all table creation).
  // Then tear out the sched_* additions and reset schema to 11 so we can test the migration.
  new Store(path).close()
  const db = new DatabaseSync(path)
  db.exec(`
    DROP VIEW IF EXISTS sched_attempts_v1;
    DROP VIEW IF EXISTS sched_history_v1;
    DROP INDEX IF EXISTS sched_occ_state;
    DROP TABLE IF EXISTS sched_attempts;
    DROP TABLE IF EXISTS sched_occurrences;
    DROP TABLE IF EXISTS sched_workflows;
    DELETE FROM kv WHERE key = 'scheduled.census.last';
  `)
  db.prepare("UPDATE kv SET value='11' WHERE key='schema'").run()
  db.close()
}

it('schema version reads 12 after opening a schema-11 database', () => {
  const path = join(directory, 'db.sqlite')
  schema11(path)
  const store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(12)
  expect(SCHEMA_VERSION).toBe(12)
  store.close()
})

it('all three sched_* tables and both views exist with the correct columns after migration', () => {
  const path = join(directory, 'db.sqlite')
  schema11(path)
  const store = new Store(path)

  const tableNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sched_%' ORDER BY name").all().map(r => String(r.name))
  expect(tableNames).toEqual(['sched_attempts', 'sched_occurrences', 'sched_workflows'])

  const viewNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name LIKE 'sched_%' ORDER BY name").all().map(r => String(r.name))
  expect(viewNames).toEqual(['sched_attempts_v1', 'sched_history_v1'])

  const indexNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='sched_occ_state'").all().map(r => String(r.name))
  expect(indexNames).toEqual(['sched_occ_state'])

  // Spot-check column names on each table.
  const cols = (table: string) => store.db.prepare(`SELECT name FROM pragma_table_xinfo(?) ORDER BY cid`).all(table).map(r => String(r.name))
  expect(cols('sched_workflows')).toEqual(['id', 'agency', 'file', 'state', 'revision', 'problems', 'ticket_id', 'first_seen', 'changed_at'])
  expect(cols('sched_occurrences')).toEqual(['occurrence', 'workflow_id', 'kind', 'instant', 'missed', 'deadline', 'grp', 'state', 'reason', 'attempt', 'reruns', 'next_try_at', 'by', 'inputs', 'updated_at'])
  expect(cols('sched_attempts')).toEqual(['occurrence', 'attempt', 'rerun', 'instance', 'revision', 'invocation', 'started_at', 'ended_at', 'ending', 'exit_code', 'report'])

  store.close()
})

it('scheduled.census.last exists and is null after migration', () => {
  const path = join(directory, 'db.sqlite')
  schema11(path)
  const store = new Store(path)
  expect(store.get(KV.scheduled.censusLast)).toBe(null)
  store.close()
})

it('a fresh database is created at schema 12 directly with all sched_* objects', () => {
  const path = join(directory, 'fresh.sqlite')
  const store = new Store(path)
  expect(store.get(KV.store.schema)).toBe(12)
  const tableNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'sched_%' ORDER BY name").all().map(r => String(r.name))
  expect(tableNames).toEqual(['sched_attempts', 'sched_occurrences', 'sched_workflows'])
  const viewNames = store.db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name LIKE 'sched_%' ORDER BY name").all().map(r => String(r.name))
  expect(viewNames).toEqual(['sched_attempts_v1', 'sched_history_v1'])
  store.close()
})

it('sched_* writes through the typed accessors work and roll back with the outer atomic()', () => {
  const path = join(directory, 'db.sqlite')
  schema11(path)
  const store = new Store(path)

  const wf: SchedWorkflow = {
    id: 'master:daily-backup', agency: '/home/tom/.agency', file: '/home/tom/.agency/workflows/daily-backup.jsonc',
    state: 'valid', revision: 'abc123def456', problems: null, ticket_id: null,
    first_seen: '2026-11-01T00:00:00.000Z', changed_at: '2026-11-01T00:00:00.000Z',
  }
  const occ: SchedOccurrence = {
    occurrence: 'master:daily-backup@2026-11-11T00:00:00.000Z', workflow_id: 'master:daily-backup',
    kind: 'schedule', instant: '2026-11-11T00:00:00.000Z', missed: 0, deadline: null,
    grp: 'master:daily-backup', state: 'queued', reason: null, attempt: 0, reruns: 0,
    next_try_at: null, by: null, inputs: null, updated_at: '2026-11-11T00:00:00.000Z',
  }
  const att: SchedAttempt = {
    occurrence: 'master:daily-backup@2026-11-11T00:00:00.000Z', attempt: 1, rerun: 0,
    instance: 'dshd-abc', revision: 'abc123def456', invocation: null,
    started_at: '2026-11-11T00:00:01.000Z', ended_at: null, ending: null, exit_code: null, report: null,
  }

  // Write through accessors inside atomic() and confirm reads work.
  store.atomic(() => {
    upsertWorkflow(store, wf)
    const inserted = insertOccurrence(store, occ)
    expect(inserted).toBe(true)
    // Duplicate primary key returns false.
    expect(insertOccurrence(store, occ)).toBe(false)
    insertAttempt(store, att)
    updateAttempt(store, att.occurrence, att.attempt, att.rerun, { ended_at: '2026-11-11T00:00:30.000Z', exit_code: 0, ending: 'done' })
    updateOccurrence(store, occ.occurrence, { state: 'done', updated_at: '2026-11-11T00:00:30.000Z' })
  })

  const readOcc = occurrence(store, occ.occurrence)
  expect(readOcc).toBeDefined()
  expect(readOcc!.state).toBe('done')

  const byState = occurrencesByState(store, 'done')
  expect(byState).toHaveLength(1)
  expect(byState[0]!.occurrence).toBe(occ.occurrence)

  const attempts = attemptsOf(store, occ.occurrence)
  expect(attempts).toHaveLength(1)
  expect(attempts[0]!.exit_code).toBe(0)
  expect(attempts[0]!.ending).toBe('done')

  // Now confirm rollback: a sched_* write inside a failing atomic() is undone.
  const occ2: SchedOccurrence = { ...occ, occurrence: 'master:daily-backup@2026-11-12T00:00:00.000Z', state: 'queued', updated_at: '2026-11-12T00:00:00.000Z' }
  expect(() => store.atomic(() => {
    insertOccurrence(store, occ2)
    expect(occurrencesByState(store, 'queued')).toHaveLength(1)
    throw new Error('domain failure')
  })).toThrow('domain failure')

  // After the rollback, occ2 must not exist.
  expect(occurrence(store, occ2.occurrence)).toBeUndefined()
  expect(occurrencesByState(store, 'queued')).toHaveLength(0)

  store.close()
})

it('sched_history_v1 joins the latest rerun of each attempt', () => {
  const path = join(directory, 'db.sqlite')
  schema11(path)
  const store = new Store(path)

  const occ: SchedOccurrence = {
    occurrence: 'master:job@2026-11-11T00:00:00.000Z', workflow_id: 'master:job',
    kind: 'schedule', instant: '2026-11-11T00:00:00.000Z', missed: 0, deadline: null,
    grp: 'master:job', state: 'done', reason: null, attempt: 1, reruns: 1,
    next_try_at: null, by: null, inputs: null, updated_at: '2026-11-11T00:01:00.000Z',
  }
  store.atomic(() => {
    upsertWorkflow(store, { id: 'master:job', agency: '/home/tom/.agency', file: '/home/tom/.agency/workflows/job.jsonc', state: 'valid', revision: null, problems: null, ticket_id: null, first_seen: '2026-11-01T00:00:00.000Z', changed_at: '2026-11-01T00:00:00.000Z' })
    insertOccurrence(store, occ)
    // Two reruns of attempt 1.
    insertAttempt(store, { occurrence: occ.occurrence, attempt: 1, rerun: 0, instance: 'dshd-1', revision: 'rev1', invocation: null, started_at: '2026-11-11T00:00:01.000Z', ended_at: '2026-11-11T00:00:10.000Z', ending: 'interrupted', exit_code: null, report: null })
    insertAttempt(store, { occurrence: occ.occurrence, attempt: 1, rerun: 1, instance: 'dshd-2', revision: 'rev1', invocation: null, started_at: '2026-11-11T00:00:30.000Z', ended_at: '2026-11-11T00:01:00.000Z', ending: 'done', exit_code: 0, report: 'ok' })
  })

  const rows = store.db.prepare('SELECT * FROM sched_history_v1').all()
  expect(rows).toHaveLength(1)
  const row = rows[0] as Record<string, unknown>
  // Must pick the latest rerun (rerun=1).
  expect(row['instance']).toBe('dshd-2')
  expect(row['ended_at']).toBe('2026-11-11T00:01:00.000Z')
  expect(row['report']).toBe('ok')

  store.close()
})
