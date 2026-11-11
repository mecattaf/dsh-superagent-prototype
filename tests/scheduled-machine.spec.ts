/** Another machine's census pauses intake (C4.12, the intake half). PROVE P4.9. */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { intakeOnce } from '../src/scheduled/intake.ts'
import { ensureSpool } from '../src/scheduled/spool.ts'
import { censusOf, quiet, record, shown, spoolFile } from './scheduled-fixtures.ts'

let dir: string
let spool: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-machine-')); spool = join(dir, 'spool'); ensureSpool(spool); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

describe('machine id (C4.12)', () => {
  it('a census from another machine pauses intake: it stays first in incoming/ and nothing after it is taken', async () => {
    const show = vi.fn(async () => shown() as never)
    const deps = { spoolDir: spool, store, receive: () => 'stored' as const, show, agencies: [{ id: 'master', root: dir, enabled: true }],
      log: quiet, now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' }
    spoolFile(spool, 'census@20261112T0000Z.json', censusOf(dir, [{}], { machineId: 'm2' }))
    spoolFile(spool, 'master~nightly@1.json', record(dir, '2026-11-12T00:00:00.000Z'))
    expect((await intakeOnce(deps)).paused).toBe('machine_changed')
    expect(readdirSync(join(spool, 'incoming')).sort()).toEqual(['census@20261112T0000Z.json', 'master~nightly@1.json'])
    expect(show).not.toHaveBeenCalled()
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sched_occurrences').get()).toEqual({ n: 0 })
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sched_workflows').get()).toEqual({ n: 0 })
  })
  it('a census from this machine is taken', async () => {
    const deps = { spoolDir: spool, store, receive: () => 'stored' as const, show: async () => shown() as never,
      agencies: [{ id: 'master', root: dir, enabled: true }], log: quiet, now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' }
    spoolFile(spool, 'census@20261112T0000Z.json', censusOf(dir, [{}]))
    expect((await intakeOnce(deps)).paused).toBeUndefined()
    expect(readdirSync(join(spool, 'incoming'))).toEqual([])
  })
})
