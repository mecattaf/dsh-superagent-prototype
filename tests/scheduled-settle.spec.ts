/**
 * Tests for src/scheduled/settle.ts – every settle table row and every verdict.
 * Tests for src/scheduled/harvest.ts – harvest from dshd final, session fallback, report.json valid/blocked/invalid.
 */
import { describe, it, expect, vi } from 'vitest'
import { settle, type SettleInput } from '../src/scheduled/settle.ts'
import { harvest, type HarvestOptions } from '../src/scheduled/harvest.ts'

// ---------------------------------------------------------------------------
// settle.ts
// ---------------------------------------------------------------------------

/** Helper: build a SettleInput with sensible defaults. */
function si(overrides: Partial<SettleInput> = {}): SettleInput {
  return {
    verdict: 'completed',
    report: null,
    check: null,
    attemptsLeft: false,
    windowOpen: true,
    reruns: 0,
    stoppedBy: null,
    endedAt: 1_000_000,
    ...overrides,
  }
}

describe('settle – completed, check passes or none → done / ready', () => {
  it('no check at all', () => {
    const r = settle(si({ verdict: 'completed', check: null }))
    expect(r.occurrence).toBe('done')
    expect(r.assignment).toBe('ready')
    expect(r.notify).toBe(false)
  })

  it('check holds (exit 0)', () => {
    const r = settle(si({ verdict: 'completed', check: { holds: true } }))
    expect(r.occurrence).toBe('done')
    expect(r.assignment).toBe('ready')
    expect(r.notify).toBe(false)
  })
})

describe('settle – completed, check fails, attempts left and window open → queued', () => {
  it('queues with next_try_at and fails assignment', () => {
    const endedAt = 1_000_000 // seconds (unix)
    const r = settle(si({ verdict: 'completed', check: { holds: false }, attemptsLeft: true, windowOpen: true, endedAt }))
    expect(r.occurrence).toBe('queued')
    expect(r.assignment).toBe('failed')
    expect(r.nextTryAt).toBeInstanceOf(Date)
    // Should be 55 minutes after endedAt (seconds → ms)
    const expected = new Date(endedAt * 1000 + 55 * 60 * 1000)
    expect(r.nextTryAt?.getTime()).toBe(expected.getTime())
    expect(r.notify).toBe(false)
  })

  it('no attempts left → awaiting', () => {
    const r = settle(si({ verdict: 'completed', check: { holds: false }, attemptsLeft: false, windowOpen: true }))
    expect(r.occurrence).toBe('awaiting')
    expect(r.assignment).toBe('failed')
    expect(r.notify).toBe(false)
  })

  it('window closed, no attempts → awaiting (not queued)', () => {
    const r = settle(si({ verdict: 'completed', check: { holds: false }, attemptsLeft: true, windowOpen: false }))
    expect(r.occurrence).toBe('awaiting')
  })
})

describe('settle – report.json blocked → held', () => {
  it('held with attention and notify', () => {
    const r = settle(si({
      verdict: 'completed',
      report: { state: 'blocked', summary: 'Need auth', question: 'May I delete prod?' },
    }))
    expect(r.occurrence).toBe('held')
    expect(r.assignment).toBe(null)
    expect(r.attention).toBe('May I delete prod?')
    expect(r.notify).toBe(true)
  })

  it('blocked without question falls back to summary', () => {
    const r = settle(si({
      verdict: 'completed',
      report: { state: 'blocked', summary: 'Need authorisation' },
    }))
    expect(r.occurrence).toBe('held')
    expect(r.attention).toBe('Need authorisation')
  })
})

describe('settle – task-failed verdict', () => {
  it('no attempts left → failed', () => {
    const r = settle(si({ verdict: 'task-failed', attemptsLeft: false }))
    expect(r.occurrence).toBe('failed')
    expect(r.assignment).toBe('failed')
    expect(r.notify).toBe(true)
  })

  it('attempts left and window open → queued', () => {
    const r = settle(si({ verdict: 'task-failed', attemptsLeft: true, windowOpen: true }))
    expect(r.occurrence).toBe('queued')
    expect(r.assignment).toBe('failed')
    expect(r.nextTryAt).toBeInstanceOf(Date)
    expect(r.notify).toBe(false)
  })
})

describe('settle – killed verdict', () => {
  it('no attempts → failed + notify', () => {
    const r = settle(si({ verdict: 'killed', attemptsLeft: false }))
    expect(r.occurrence).toBe('failed')
    expect(r.notify).toBe(true)
  })

  it('attempts left → queued', () => {
    const r = settle(si({ verdict: 'killed', attemptsLeft: true, windowOpen: true }))
    expect(r.occurrence).toBe('queued')
  })
})

describe('settle – never-ran verdict', () => {
  it('no attempts → failed + notify', () => {
    const r = settle(si({ verdict: 'never-ran', attemptsLeft: false }))
    expect(r.occurrence).toBe('failed')
    expect(r.notify).toBe(true)
  })

  it('attempts left → queued', () => {
    const r = settle(si({ verdict: 'never-ran', attemptsLeft: true, windowOpen: true }))
    expect(r.occurrence).toBe('queued')
  })
})

describe('settle – timeout verdict', () => {
  it('no attempts → failed + notify', () => {
    const r = settle(si({ verdict: 'timeout', attemptsLeft: false }))
    expect(r.occurrence).toBe('failed')
    expect(r.notify).toBe(true)
  })

  it('attempts left → queued', () => {
    const r = settle(si({ verdict: 'timeout', attemptsLeft: true, windowOpen: true }))
    expect(r.occurrence).toBe('queued')
    expect(r.assignment).toBe('failed')
  })
})

describe('settle – cut by reboot (cut-reboot)', () => {
  it('first cut (reruns=0) → queued at once, rerun flag, no assignment, no notify', () => {
    const r = settle(si({ verdict: 'cut-reboot', reruns: 0 }))
    expect(r.occurrence).toBe('queued')
    expect(r.rerun).toBe(true)
    expect(r.assignment).toBe(null)
    expect(r.notify).toBe(false)
  })

  it('second cut (reruns>=1) → interrupted + notify', () => {
    const r = settle(si({ verdict: 'cut-reboot', reruns: 1 }))
    expect(r.occurrence).toBe('interrupted')
    expect(r.assignment).toBe('failed')
    expect(r.notify).toBe(true)
  })
})

describe('settle – cut by power loss (cut-power)', () => {
  it('first cut → queued + rerun', () => {
    const r = settle(si({ verdict: 'cut-power', reruns: 0 }))
    expect(r.occurrence).toBe('queued')
    expect(r.rerun).toBe(true)
    expect(r.notify).toBe(false)
  })

  it('second cut → interrupted + notify', () => {
    const r = settle(si({ verdict: 'cut-power', reruns: 1 }))
    expect(r.occurrence).toBe('interrupted')
    expect(r.notify).toBe(true)
  })
})

describe('settle – stopped by Tom', () => {
  it('stoppedBy=tom → cancelled / dropped', () => {
    const r = settle(si({ verdict: 'stopped', stoppedBy: 'tom' }))
    expect(r.occurrence).toBe('cancelled')
    expect(r.assignment).toBe('dropped')
    expect(r.notify).toBe(false)
  })
})

describe('settle – stopped by floor', () => {
  it('stoppedBy=floor → cancelled / dropped', () => {
    const r = settle(si({ verdict: 'stopped', stoppedBy: 'floor' }))
    expect(r.occurrence).toBe('cancelled')
    expect(r.assignment).toBe('dropped')
    expect(r.notify).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// harvest.ts
// ---------------------------------------------------------------------------

function makeHarvestOpts(overrides: Partial<HarvestOptions> = {}): HarvestOptions {
  return {
    name: 'sch-master-test-20261111t0000z',
    runDir: '/runs/test',
    exec: async () => ({ code: 0, stdout: '' }),
    readFile: () => null,
    sessionLog: async () => '',
    ...overrides,
  }
}

describe('harvest – dshd final line (source: dshd)', () => {
  it('extracts answer from last type:final line', async () => {
    const lines = [
      JSON.stringify({ type: 'start', invocationId: 'inv-abc' }),
      JSON.stringify({ type: 'text', text: 'partial' }),
      JSON.stringify({ type: 'final', text: 'The answer', sessionId: 'sess-123' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
    })
    const r = await harvest(opts)
    expect(r.source).toBe('dshd')
    expect(r.answer).toBe('The answer')
    expect(r.sessionId).toBe('sess-123')
  })

  it('takes the last final line when multiple exist', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'First', sessionId: 's1' }),
      JSON.stringify({ type: 'final', text: 'Second', sessionId: 's2' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
    })
    const r = await harvest(opts)
    expect(r.answer).toBe('Second')
    expect(r.sessionId).toBe('s2')
  })

  it('caps answer at 8 KiB on UTF-8 boundary', async () => {
    const longText = 'a'.repeat(10 * 1024)
    const lines = [
      JSON.stringify({ type: 'final', text: longText, sessionId: 'sx' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
    })
    const r = await harvest(opts)
    expect(Buffer.byteLength(r.answer, 'utf-8')).toBeLessThanOrEqual(8 * 1024)
    expect(r.source).toBe('dshd')
  })
})

describe('harvest – session fallback (source: session)', () => {
  it('falls back when complete is not true', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'Dshd text', sessionId: 'sess-fallback' }),
      // No complete: true
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      sessionLog: async () => 'Session log answer',
    })
    const r = await harvest(opts)
    expect(r.source).toBe('session')
    expect(r.answer).toBe('Session log answer')
  })

  it('falls back when no final line present', async () => {
    const lines = JSON.stringify({ complete: true })

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      sessionLog: async () => 'fallback text',
    })
    const r = await harvest(opts)
    // complete=true but no final line → still falls through since lastFinalLine is null
    expect(r.source).toBe('session')
  })
})

describe('harvest – report.json valid', () => {
  it('parses valid done report', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'ok', sessionId: 's' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const report = { state: 'done', summary: 'All good' }
    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      readFile: () => JSON.stringify(report),
    })
    const r = await harvest(opts)
    expect(r.report).toEqual({ state: 'done', summary: 'All good' })
  })

  it('parses valid blocked report with question', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'blocked', sessionId: 's' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const report = { state: 'blocked', summary: 'Need auth', question: 'May I delete?' }
    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      readFile: () => JSON.stringify(report),
    })
    const r = await harvest(opts)
    expect(r.report?.state).toBe('blocked')
    expect(r.report?.question).toBe('May I delete?')
  })
})

describe('harvest – report.json invalid', () => {
  it('invalid state value → report is null', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'x', sessionId: 's' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const stderrLines: string[] = []
    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      readFile: () => JSON.stringify({ state: 'oops', summary: 'x' }),
    })
    // Replace floorLog to suppress stderr in tests
    const r = await harvest(opts)
    expect(r.report).toBeNull()
  })

  it('unparseable JSON → report is null', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'x', sessionId: 's' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      readFile: () => 'not json at all',
    })
    const r = await harvest(opts)
    expect(r.report).toBeNull()
  })

  it('missing summary → report is null', async () => {
    const lines = [
      JSON.stringify({ type: 'final', text: 'x', sessionId: 's' }),
      JSON.stringify({ complete: true }),
    ].join('\n')

    const opts = makeHarvestOpts({
      exec: async () => ({ code: 0, stdout: lines }),
      readFile: () => JSON.stringify({ state: 'done' }),
    })
    const r = await harvest(opts)
    expect(r.report).toBeNull()
  })
})
