/** Census reconcile (C4.10, C4.11): removed, invalid, window end, supersede, disable. PROVE P4.9. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { reconcile, supersede } from '../src/scheduled/intake.ts'
import { CensusRecord } from '../src/scheduled/spool.ts'
import { insertOccurrence, occurrence as occurrenceRow, workflow as workflowRow } from '../src/scheduled/store.ts'
import { censusOf, occ, quiet } from './scheduled-fixtures.ts'

let dir: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-census-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const at = new Date('2026-11-12T01:00:00Z')
const census = (workflows: Parameters<typeof censusOf>[1]) => CensusRecord.parse(censusOf(dir, workflows))
const put = (patch: Parameters<typeof occ>[0]) => store.atomic(() => { insertOccurrence(store, occ(patch)) })
const state = (key: string) => occurrenceRow(store, key)

describe('census reconcile (C4.10)', () => {
  it('a census that omits a workflow marks it removed and cancels its waiting occurrences', () => {
    reconcile(store, census([{}]), at, quiet)
    put({ occurrence: 'q', state: 'queued' }); put({ occurrence: 'd', state: 'deferred' }); put({ occurrence: 'r', state: 'running' })
    reconcile(store, census([]), at, quiet)
    expect(workflowRow(store, 'master:nightly')?.state).toBe('removed')
    expect(state('q')).toMatchObject({ state: 'cancelled', reason: 'removed' })
    expect(state('d')).toMatchObject({ state: 'cancelled', reason: 'removed' })
    // A running attempt is left alone.
    expect(state('r')?.state).toBe('running')
  })
  it('an invalid workflow holds its queued occurrences with reason invalid and asks to notify once per revision', () => {
    reconcile(store, census([{}]), at, quiet)
    put({ occurrence: 'q', state: 'queued' })
    expect(reconcile(store, census([{ state: 'invalid', revision: 'rev2' }]), at, quiet).notify).toEqual(['master:nightly'])
    expect(state('q')).toMatchObject({ state: 'held', reason: 'invalid' })
    expect(reconcile(store, census([{ state: 'invalid', revision: 'rev2' }]), at, quiet).notify).toEqual([])
    expect(reconcile(store, census([{ state: 'invalid', revision: 'rev3' }]), at, quiet).notify).toEqual(['master:nightly'])
    // Valid again: the hold lifts.
    reconcile(store, census([{ revision: 'rev4' }]), at, quiet)
    expect(state('q')).toMatchObject({ state: 'queued', reason: null })
  })
  it('a window end turns waiting rows missed, and an attempted or awaiting one unmet', () => {
    reconcile(store, census([{}]), at, quiet)
    put({ occurrence: 'never-ran', state: 'queued', deadline: '2026-11-12T00:30:00.000Z' })
    put({ occurrence: 'deferred', state: 'deferred', deadline: '2026-11-12T00:30:00.000Z' })
    put({ occurrence: 'retrying', state: 'queued', attempt: 1, deadline: '2026-11-12T00:30:00.000Z' })
    put({ occurrence: 'awaiting', state: 'awaiting', attempt: 1, deadline: '2026-11-12T00:30:00.000Z' })
    put({ occurrence: 'open', state: 'queued', deadline: '2026-11-12T11:00:00.000Z' })
    reconcile(store, census([{}]), at, quiet)
    expect(state('never-ran')).toMatchObject({ state: 'missed', reason: 'window closed' })
    expect(state('deferred')).toMatchObject({ state: 'missed' })
    expect(state('retrying')).toMatchObject({ state: 'unmet' })
    expect(state('awaiting')).toMatchObject({ state: 'unmet' })
    expect(state('open')?.state).toBe('queued')
  })
  it('records the census time in KV scheduled.census.last', () => {
    reconcile(store, census([{}]), at, quiet)
    expect(store.db.prepare(`SELECT value FROM kv WHERE key='scheduled.census.last'`).get()).toBeTruthy()
  })
})

describe('supersede and disable (C4.11)', () => {
  it('queue single: a newer occurrence supersedes the older queued one of its group; a running one stays', () => {
    put({ occurrence: 'old', state: 'queued' }); put({ occurrence: 'run', state: 'running' }); put({ occurrence: 'new', state: 'queued' })
    supersede(store, 'master:nightly', 'new', at, quiet)
    expect(state('old')).toMatchObject({ state: 'superseded' })
    expect(state('run')?.state).toBe('running')
    expect(state('new')?.state).toBe('queued')
  })
  it('disabled cancels queued and deferred scheduled occurrences, leaves a running one and a manual one alone', () => {
    reconcile(store, census([{}]), at, quiet)
    put({ occurrence: 'q', state: 'queued' }); put({ occurrence: 'd', state: 'deferred' }); put({ occurrence: 'r', state: 'running' })
    put({ occurrence: 'm', state: 'queued', kind: 'manual' })
    reconcile(store, census([{ enabled: false }]), at, quiet)
    expect(workflowRow(store, 'master:nightly')?.state).toBe('disabled')
    expect(state('q')).toMatchObject({ state: 'cancelled', reason: 'disabled' })
    expect(state('d')).toMatchObject({ state: 'cancelled', reason: 'disabled' })
    expect(state('r')?.state).toBe('running')
    expect(state('m')?.state).toBe('queued')
  })
})
