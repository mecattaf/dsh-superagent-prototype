/** C9.5, C9.6, C5.17: floor upkeep prunes only what retention allows, reports anomalies, and never resets a failed unit. */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { insertAttempt, insertOccurrence, upsertWorkflow } from '../src/scheduled/store.ts'
import { upkeep } from '../src/scheduled/upkeep.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-upkeep-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function seed(store: Store) {
  upsertWorkflow(store, { id: 'master:n', agency: 'master', file: join(dir, '.agency/workflows/n.jsonc'), state: 'valid', revision: 'r', problems: '[]',
    ticket_id: null, first_seen: '2026-10-01T00:00:00.000Z', changed_at: '2026-10-01T00:00:00.000Z' })
  upsertWorkflow(store, { id: 'master:bad', agency: 'master', file: join(dir, '.agency/workflows/bad.jsonc'), state: 'invalid', revision: null, problems: '[]',
    ticket_id: null, first_seen: '2026-10-01T00:00:00.000Z', changed_at: '2026-10-01T00:00:00.000Z' })
  const occ = (occurrence: string, state: string, updated = '2026-10-20T00:00:00.000Z', deadline: string | null = null) => insertOccurrence(store, {
    occurrence, workflow_id: 'master:n', kind: 'schedule', instant: updated, missed: 0, deadline, grp: 'master:n', state, reason: null, attempt: 1,
    reruns: 0, next_try_at: null, by: null, inputs: null, updated_at: updated })
  occ('master:n@old', 'done'); occ('master:n@held', 'held'); occ('master:n@new', 'done', '2026-11-10T00:00:00.000Z')
  occ('master:n@late', 'queued', '2026-11-10T00:00:00.000Z', '2026-11-10T11:00:00.000Z')
  occ('master:n@ancient', 'done', '2025-09-01T00:00:00.000Z')
  for (const [occurrence, instance, ended] of [['master:n@old', 'sch-master-n-old', '2026-10-20T01:00:00.000Z'], ['master:n@held', 'sch-master-n-held', '2026-10-20T01:00:00.000Z'],
    ['master:n@new', 'sch-master-n-new', '2026-11-10T01:00:00.000Z']] as const) {
    insertAttempt(store, { occurrence, attempt: 1, rerun: 0, instance, revision: 'r', invocation: null, started_at: ended, ended_at: ended, ending: 'exited', exit_code: 0, report: null })
  }
}

it('dry run lists and removes nothing; a real run removes old final instances, their run dirs, old spool files and old rows; reports anomalies', async () => {
  const store = new Store(join(dir, 'db.sqlite'))
  seed(store)
  for (const name of ['sch-master-n-old', 'sch-master-n-held', 'sch-master-n-new']) mkdirSync(join(dir, '.agency', 'runs', name), { recursive: true })
  for (const sub of ['done', 'rejected']) mkdirSync(join(dir, 'state', 'spool', sub), { recursive: true })
  const oldFile = join(dir, 'state', 'spool', 'done', 'old.json'); writeFileSync(oldFile, '{}'); utimesSync(oldFile, new Date('2026-09-01'), new Date('2026-09-01'))
  writeFileSync(join(dir, 'state', 'spool', 'rejected', 'bad.json'), '{}')
  const calls: string[][] = []
  const dshd = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'ls') return { code: 0, stdout: JSON.stringify({ instances: [
      { name: 'sch-master-n-old', state: 'stopped', remedy: null }, { name: 'sch-master-n-held', state: 'stopped', remedy: null },
      { name: 'sch-master-n-new', state: 'failed', remedy: null }, { name: 'now-master-x-orphan', state: 'stopped', remedy: null },
      { name: 'floor', state: 'running', remedy: null }] }) }
    return { code: 0, stdout: '{"outcome":"removed"}' }
  }
  const now = new Date('2026-11-12T00:00:00Z'), quiet = () => {}
  const dry = await upkeep({ store, stateDir: join(dir, 'state'), dshd, dryRun: true, now, log: quiet })
  expect(dry.removed).toMatchObject({ instances: ['sch-master-n-old'], spoolFiles: 1, rows: 1 })
  expect(calls.filter(args => args[0] === 'rm')).toEqual([])
  expect(existsSync(oldFile)).toBe(true)
  const real = await upkeep({ store, stateDir: join(dir, 'state'), dshd, dryRun: false, now, log: quiet })
  expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '--json', 'sch-master-n-old']])
  expect(readdirSync(join(dir, '.agency', 'runs')).sort()).toEqual(['sch-master-n-held', 'sch-master-n-new'])
  expect(existsSync(oldFile)).toBe(false)
  expect(store.db.prepare(`SELECT COUNT(*) AS n FROM sched_occurrences WHERE occurrence='master:n@ancient'`).get()).toEqual({ n: 0 })
  expect(real.anomalies).toMatchObject({ orphanInstances: ['now-master-x-orphan'], failedUnits: ['sch-master-n-new'], pastDeadline: ['master:n@late'],
    rejectedSpool: ['bad.json'], invalidWorkflows: ['master:bad'] })
  // Never a reset-failed: only ls and rm reach dshd.
  expect(new Set(calls.map(args => args[0]))).toEqual(new Set(['ls', 'rm']))
  store.close()
})
