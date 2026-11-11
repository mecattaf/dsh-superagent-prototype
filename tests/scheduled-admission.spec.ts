/** The admission gate (C5.5), DESIGN 7.5 steps 1-6, each with a stub `scheduled gate|check`. PROVE P5.5. */
import { describe, expect, it, vi } from 'vitest'
import { admit, type AdmissionInput } from '../src/scheduled/admission.ts'
import { occ, recorder } from './scheduled-fixtures.ts'

const now = new Date('2026-11-12T00:05:00Z')
const cli = (opts: { holds?: boolean; deferred?: string | null; checkThrows?: boolean; gateThrows?: boolean } = {}) => ({
  check: vi.fn(async () => { if (opts.checkThrows) throw new Error('timeout'); return { holds: !!opts.holds, exit: opts.holds ? 0 : 1 } }),
  gate: vi.fn(async () => { if (opts.gateThrows) throw new Error('timeout'); return { deferred: opts.deferred ?? null } }),
})
const input = (patch: Partial<AdmissionInput> = {}): AdmissionInput => ({ occurrence: occ(), census: { state: 'valid' }, now, cli: cli(),
  runningGroups: new Set(), freeSlots: 3, hasCheck: true, log: () => {}, ...patch })

describe('admission (C5.5)', () => {
  it('step 1: removed, invalid and disabled', async () => {
    expect(await admit(input({ census: undefined }))).toEqual({ decision: 'cancelled', reason: 'removed' })
    expect(await admit(input({ census: { state: 'removed' } }))).toEqual({ decision: 'cancelled', reason: 'removed' })
    expect(await admit(input({ census: { state: 'invalid' } }))).toEqual({ decision: 'held', reason: 'invalid' })
    expect(await admit(input({ census: { state: 'disabled' } }))).toEqual({ decision: 'cancelled', reason: 'disabled' })
  })
  it('step 2: a passed deadline is missed', async () => {
    expect(await admit(input({ occurrence: occ({ deadline: '2026-11-12T00:05:00.000Z' }) }))).toEqual({ decision: 'missed', reason: 'window closed' })
  })
  it('step 3: an outcome check that holds is satisfied, and the gate is not run', async () => {
    const stub = cli({ holds: true })
    expect(await admit(input({ cli: stub }))).toEqual({ decision: 'satisfied', reason: 'check holds' })
    expect(stub.gate).not.toHaveBeenCalled()
    // Without outcome.check the step is skipped.
    const none = cli({ holds: true })
    expect((await admit(input({ cli: none, hasCheck: false }))).decision).toBe('launch')
    expect(none.check).not.toHaveBeenCalled()
  })
  it('step 4: a running concurrency group waits', async () => {
    expect((await admit(input({ runningGroups: new Set(['master:nightly']) }))).decision).toBe('wait-group')
  })
  it('step 5: a gate that defers is deferred with its reason; a CLI error defers too', async () => {
    expect(await admit(input({ cli: cli({ deferred: 'busy: fleet-update' }) }))).toEqual({ decision: 'deferred', reason: 'busy: fleet-update' })
    expect(await admit(input({ cli: cli({ gateThrows: true }) }))).toEqual({ decision: 'deferred', reason: 'cli-error' })
    expect(await admit(input({ cli: cli({ checkThrows: true }) }))).toEqual({ decision: 'deferred', reason: 'cli-error' })
  })
  it('step 6: with three slots busy a fourth admitted item waits for a slot; with one free it launches', async () => {
    const maxWorkers = 3
    const running = 3
    expect(await admit(input({ freeSlots: maxWorkers - running }))).toEqual({ decision: 'later', reason: 'no free worker slot' })
    expect(await admit(input({ freeSlots: maxWorkers - 2 }))).toEqual({ decision: 'launch' })
  })
  it('passes the attempt number to check and gate, and logs one line per decision', async () => {
    const stub = cli({ deferred: 'idle-unknown' })
    const r = recorder()
    await admit(input({ cli: stub, occurrence: occ({ attempt: 1 }), log: r.log as never }))
    expect(stub.check).toHaveBeenCalledWith('master:nightly', 'master:nightly@2026-11-12T00:00:00.000Z', 2)
    expect(stub.gate).toHaveBeenCalledWith('master:nightly', 'master:nightly@2026-11-12T00:00:00.000Z', 2)
    expect(r.lines).toEqual([['defer', { occ: 'master:nightly@2026-11-12T00:00:00.000Z', decision: 'deferred', reason: 'idle-unknown' }]])
  })
  it('a manual occurrence of a paused workflow is admitted and skips the check', async () => {
    const stub = cli({ holds: true })
    expect((await admit(input({ cli: stub, census: { state: 'disabled' }, occurrence: occ({ kind: 'manual', deadline: null }) }))).decision).toBe('launch')
    expect(stub.check).not.toHaveBeenCalled()
  })
})
