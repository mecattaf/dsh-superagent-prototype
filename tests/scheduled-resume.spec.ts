/**
 * Tests for src/scheduled/resume.ts – the three resume cases.
 */
import { describe, it, expect } from 'vitest'
import { planResume, type OpenAttemptRow, type GetResult } from '../src/scheduled/resume.ts'

/** Helper: build an OpenAttemptRow with defaults. */
function row(overrides: Partial<OpenAttemptRow> = {}): OpenAttemptRow {
  return {
    occurrence: 'master:test@20261111t0000z',
    attempt: 1,
    rerun: 0,
    instance: 'sch-master-test-20261111t0000z',
    revision: 'rev-abc',
    invocation: null,
    started_at: '2026-11-11T00:00:00Z',
    occurrenceState: 'running',
    ...overrides,
  }
}

/** Returns a getInstance function that maps names to fixed results. */
function getInstance(map: Record<string, GetResult>): (name: string) => Promise<GetResult> {
  return async (name: string) => map[name] ?? 'not-found'
}

describe('planResume – instance known → watch', () => {
  it('returns watch when dshd get returns an object', async () => {
    const r = row({ instance: 'inst-a' })
    const results = await planResume(
      [r],
      getInstance({ 'inst-a': { state: 'running' } }),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.action.kind).toBe('watch')
    expect(results[0]?.row.instance).toBe('inst-a')
  })

  it('returns watch for stopped instances too (not not-found)', async () => {
    const r = row({ instance: 'inst-b' })
    const results = await planResume(
      [r],
      getInstance({ 'inst-b': { state: 'stopped', lastRun: { ending: 'exited' } } }),
    )
    expect(results[0]?.action.kind).toBe('watch')
  })
})

describe('planResume – first not-found → relaunch', () => {
  it('rerun=0: relaunch as r1', async () => {
    const r = row({ instance: 'inst-c', rerun: 0 })
    const results = await planResume([r], getInstance({}))
    expect(results[0]?.action.kind).toBe('relaunch')
    if (results[0]?.action.kind === 'relaunch') {
      expect(results[0].action.rerun).toBe(1)
    }
  })
})

describe('planResume – second not-found → settle failed', () => {
  it('rerun=1: settle instance-lost', async () => {
    const r = row({ instance: 'inst-d', rerun: 1 })
    const results = await planResume([r], getInstance({}))
    expect(results[0]?.action.kind).toBe('settle')
    if (results[0]?.action.kind === 'settle') {
      expect(results[0].action.state).toBe('failed')
      expect(results[0].action.reason).toBe('instance-lost')
    }
  })

  it('rerun=2 also settles failed (second not-found)', async () => {
    const r = row({ instance: 'inst-e', rerun: 2 })
    const results = await planResume([r], getInstance({}))
    expect(results[0]?.action.kind).toBe('settle')
  })
})

describe('planResume – multiple rows', () => {
  it('handles mixed outcomes per row', async () => {
    const rows = [
      row({ instance: 'known', rerun: 0 }),
      row({ occurrence: 'occ2', instance: 'missing-first', rerun: 0 }),
      row({ occurrence: 'occ3', instance: 'missing-second', rerun: 1 }),
    ]
    const results = await planResume(
      rows,
      getInstance({ known: { state: 'running' } }),
    )
    expect(results).toHaveLength(3)
    expect(results[0]?.action.kind).toBe('watch')
    expect(results[1]?.action.kind).toBe('relaunch')
    expect(results[2]?.action.kind).toBe('settle')
  })

  it('empty rows → empty results', async () => {
    const results = await planResume([], getInstance({}))
    expect(results).toHaveLength(0)
  })
})
