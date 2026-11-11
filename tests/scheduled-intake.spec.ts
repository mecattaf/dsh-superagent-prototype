/** Spool intake on the floor (C4.8): show once per file, the standing Trigger, dedup, refusals. PROVE P4.8. */
import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import { intakeOnce, occurrenceTriggerId, SHOW_RETRY_MS } from '../src/scheduled/intake.ts'
import { ensureSpool } from '../src/scheduled/spool.ts'
import { occurrence as occurrenceRow } from '../src/scheduled/store.ts'
import { censusOf, manual, quiet, record, shown, spoolFile } from './scheduled-fixtures.ts'

let dir: string
let spool: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-intake-')); spool = join(dir, 'spool'); ensureSpool(spool); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const AT = new Date('2026-11-12T00:00:10Z')
function world(show = vi.fn(async (_id: string) => shown() as never)) {
  const received: Trigger[] = []
  const deps = { spoolDir: spool, store, receive: (t: Trigger) => { received.push(t); return 'stored' as const }, show,
    agencies: [{ id: 'master', root: dir, enabled: true }], log: quiet, now: () => AT, machineId: () => 'm1' }
  return { received, show, deps }
}
const fresh = (path: string) => utimesSync(path, AT, AT)

describe('intake (C4.8)', () => {
  it('calls scheduled show once per occurrence file and never for a census', async () => {
    const w = world()
    spoolFile(spool, 'census@20261112T0000Z.json', censusOf(dir, [{}]))
    spoolFile(spool, 'master~nightly@1.json', record(dir, '2026-11-12T00:00:00.000Z'))
    spoolFile(spool, 'master~nightly@2.json', record(dir, '2026-11-13T00:00:00.000Z'))
    spoolFile(spool, 'master~nightly@manual~01K9ZZZZZZZZZZZZZZZZZZZZZZ.json', manual(dir, '01K9ZZZZZZZZZZZZZZZZZZZZZZ'))
    await intakeOnce(w.deps)
    expect(w.show).toHaveBeenCalledTimes(3)
    expect(w.show.mock.calls.map(call => call[0])).toEqual(['master:nightly', 'master:nightly', 'master:nightly'])
  })
  it('stores one standing Trigger under the deterministic id and a queued row, then moves the file to done/', async () => {
    const w = world()
    spoolFile(spool, 'master~nightly@1.json', record(dir, '2026-11-12T00:00:00.000Z'))
    await intakeOnce(w.deps)
    expect(w.received).toHaveLength(1)
    expect(w.received[0]).toMatchObject({ id: occurrenceTriggerId('master:nightly@2026-11-12T00:00:00.000Z'), source: 'scheduled',
      human: false, standing: true, actor: { id: 'master' } })
    expect(occurrenceRow(store, 'master:nightly@2026-11-12T00:00:00.000Z')).toMatchObject({ state: 'queued', kind: 'schedule', attempt: 0 })
    expect(readdirSync(join(spool, 'done'))).toEqual(['master~nightly@1.json'])
  })
  it('a repeat of the same occurrence stores no second row and still clears incoming/', async () => {
    const w = world()
    spoolFile(spool, 'master~nightly@1.json', record(dir, '2026-11-12T00:00:00.000Z'))
    await intakeOnce(w.deps)
    spoolFile(spool, 'master~nightly@1.json', record(dir, '2026-11-12T00:00:00.000Z'))
    await intakeOnce(w.deps)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sched_occurrences').get()).toEqual({ n: 1 })
    expect(readdirSync(join(spool, 'incoming'))).toEqual([])
  })
  it('an unlisted agency is cancelled without a show', async () => {
    const w = world()
    spoolFile(spool, 'other~x@1.json', record(dir, '2026-11-12T00:00:00.000Z', { workflow: 'other:x', occurrence: 'other:x@1' }))
    await intakeOnce(w.deps)
    expect(w.show).not.toHaveBeenCalled()
    expect(occurrenceRow(store, 'other:x@1')).toMatchObject({ state: 'cancelled', reason: 'agency_not_listed' })
    expect(w.received).toHaveLength(0)
  })
  it('refuses a run-now of a proposal, and of an invalid workflow', async () => {
    const proposal = world(vi.fn(async () => shown({}, { kind: 'proposal' }) as never))
    spoolFile(spool, 'master~nightly@manual~01K9AAAAAAAAAAAAAAAAAAAAAA.json', manual(dir, '01K9AAAAAAAAAAAAAAAAAAAAAA'))
    await intakeOnce(proposal.deps)
    expect(occurrenceRow(store, 'master:nightly@manual:01K9AAAAAAAAAAAAAAAAAAAAAA')).toMatchObject({ state: 'refused', reason: 'proposal' })
    const invalid = world(vi.fn(async () => shown({}, { state: 'invalid' }) as never))
    spoolFile(spool, 'master~nightly@manual~01K9BBBBBBBBBBBBBBBBBBBBBB.json', manual(dir, '01K9BBBBBBBBBBBBBBBBBBBBBB'))
    await intakeOnce(invalid.deps)
    expect(occurrenceRow(store, 'master:nightly@manual:01K9BBBBBBBBBBBBBBBBBBBBBB')).toMatchObject({ state: 'refused', reason: 'invalid' })
  })
  it('a failing show leaves a fresh file for the next poll, and refuses a run-now only after SHOW_RETRY_MS', async () => {
    let fail = true
    const w = world(vi.fn(async () => (fail ? { error: 'timeout' } : shown()) as never))
    fresh(spoolFile(spool, 'master~nightly@manual~01K9CCCCCCCCCCCCCCCCCCCCCC.json', manual(dir, '01K9CCCCCCCCCCCCCCCCCCCCCC')))
    await intakeOnce(w.deps)
    expect(occurrenceRow(store, 'master:nightly@manual:01K9CCCCCCCCCCCCCCCCCCCCCC')).toBeUndefined()
    expect(readdirSync(join(spool, 'incoming'))).toHaveLength(1)
    fail = false
    await intakeOnce(w.deps)
    expect(occurrenceRow(store, 'master:nightly@manual:01K9CCCCCCCCCCCCCCCCCCCCCC')?.state).toBe('queued')
    fail = true
    const old = new Date(AT.getTime() - SHOW_RETRY_MS - 1000)
    utimesSync(spoolFile(spool, 'master~nightly@manual~01K9DDDDDDDDDDDDDDDDDDDDDD.json', manual(dir, '01K9DDDDDDDDDDDDDDDDDDDDDD')), old, old)
    await intakeOnce(w.deps)
    expect(occurrenceRow(store, 'master:nightly@manual:01K9DDDDDDDDDDDDDDDDDDDDDD')).toMatchObject({ state: 'refused' })
  })
})
