/** The spool contract on the floor side (C4.8 hand-off, C4.9 rejects): PROVE P4.8. */
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { intakeOnce, type Log } from '../src/scheduled/intake.ts'
import { ensureSpool, listIncoming, parseRecord } from '../src/scheduled/spool.ts'
import { censusOf, quiet, record, recorder, shown, spoolFile } from './scheduled-fixtures.ts'

let dir: string
let spool: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-spool-')); spool = join(dir, 'spool'); ensureSpool(spool); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const deps = (log: Log = quiet) => ({ spoolDir: spool, store, receive: () => 'stored' as const, show: async () => shown(),
  agencies: [{ id: 'master', root: dir, enabled: true }], log, now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' })
/** The heartbeat's hand-off: write under tmp/, then link() into incoming/ (DESIGN 5.3). */
function handOff(name: string, body: unknown): void {
  const tmp = join(spool, 'tmp', `.${name}.tmp`)
  writeFileSync(tmp, JSON.stringify(body))
  linkSync(tmp, join(spool, 'incoming', name))
  rmSync(tmp)
}
const count = () => (store.db.prepare('SELECT COUNT(*) AS n FROM sched_occurrences').get() as { n: number }).n

describe('spool hand-off (C4.8)', () => {
  it('two link() calls into a temp spool give one sched_occurrences row each, and both files move to done/', async () => {
    handOff('master~nightly@20261112T0000Z.json', record(dir, '2026-11-12T00:00:00.000Z'))
    handOff('master~nightly@20261113T0000Z.json', record(dir, '2026-11-13T00:00:00.000Z'))
    expect(await intakeOnce(deps())).toMatchObject({ processed: 2, rejected: 0 })
    expect(count()).toBe(2)
    expect(readdirSync(join(spool, 'incoming'))).toEqual([])
    expect(readdirSync(join(spool, 'done')).sort()).toEqual(['master~nightly@20261112T0000Z.json', 'master~nightly@20261113T0000Z.json'])
  })
  it('the same record linked again after intake adds no row', async () => {
    handOff('master~nightly@20261112T0000Z.json', record(dir, '2026-11-12T00:00:00.000Z'))
    await intakeOnce(deps())
    handOff('master~nightly@20261112T0000Z.json', record(dir, '2026-11-12T00:00:00.000Z'))
    await intakeOnce(deps())
    expect(count()).toBe(1)
  })
})

describe('rejects (C4.9)', () => {
  it('a file with v 2 lands in rejected/ with a mode-0600 .error sidecar and one reject line', async () => {
    const r = recorder()
    spoolFile(spool, 'master~nightly@future.json', { ...record(dir, '2026-11-12T00:00:00.000Z'), v: 2 })
    expect(await intakeOnce(deps(r.log as never))).toMatchObject({ processed: 0, rejected: 1 })
    expect(readdirSync(join(spool, 'rejected')).sort()).toEqual(['master~nightly@future.json', 'master~nightly@future.json.error'])
    const sidecar = join(spool, 'rejected', 'master~nightly@future.json.error')
    expect(readFileSync(sidecar, 'utf8')).toContain('unsupported spool version')
    expect(statSync(sidecar).mode & 0o777).toBe(0o600)
    expect(r.lines.filter(([event]) => event === 'reject')).toHaveLength(1)
    expect(count()).toBe(0)
  })
  it('rejects a lower major version, an unknown kind, a v 1 record that fails the schema, and text that is not JSON', async () => {
    spoolFile(spool, 'a.json', { ...record(dir, '2026-11-12T00:00:00.000Z'), v: 0 })
    spoolFile(spool, 'b.json', { ...record(dir, '2026-11-12T00:00:00.000Z'), kind: 'event' })
    spoolFile(spool, 'c.json', { v: 1, kind: 'schedule', workflow: 'master:nightly' })
    spoolFile(spool, 'd.json', 'not json')
    expect(await intakeOnce(deps())).toMatchObject({ processed: 0, rejected: 4 })
    expect(readdirSync(join(spool, 'rejected')).filter(name => name.endsWith('.error')).sort()).toEqual(['a.json.error', 'b.json.error', 'c.json.error', 'd.json.error'])
    expect(count()).toBe(0)
  })
  it('parseRecord accepts each v 1 kind', () => {
    expect(parseRecord(JSON.stringify(record(dir, '2026-11-12T00:00:00.000Z'))).ok).toBe(true)
    expect(parseRecord(JSON.stringify(censusOf(dir, [{}]))).ok).toBe(true)
  })
})

describe('order (C4.8)', () => {
  it('lists census files first, then name order, and skips temporary and hidden names', () => {
    spoolFile(spool, 'master~b@1.json', {})
    spoolFile(spool, 'master~a@1.json', {})
    spoolFile(spool, 'census@20261112T0100Z.json', {})
    spoolFile(spool, 'census@20261112T0000Z.json', {})
    spoolFile(spool, '.hidden.json', {})
    spoolFile(spool, 'master~c@1.json.tmp', {})
    expect(listIncoming(spool)).toEqual(['census@20261112T0000Z.json', 'census@20261112T0100Z.json', 'master~a@1.json', 'master~b@1.json'])
  })
  it('reconciles the census before the occurrence that follows it in the same pass', async () => {
    spoolFile(spool, 'master~nightly@20261112T0000Z.json', record(dir, '2026-11-12T00:00:00.000Z'))
    spoolFile(spool, 'census@20261112T0000Z.json', censusOf(dir, [{ enabled: false }]))
    await intakeOnce(deps())
    // The census ran first: the workflow row exists (from the census) by the time the occurrence is read.
    expect(store.db.prepare('SELECT state FROM sched_workflows WHERE id=?').get('master:nightly')).toEqual({ state: 'disabled' })
  })
})
