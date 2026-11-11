/** The watch effect (C5.11): poll, timeout, harvest, settle, lost instance. PROVE P5.10 (unit half). */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Later } from '../src/app/effects.ts'
import { DshdExecutor, type WatchPayload } from '../src/executor/dshd.ts'
import { attemptsOf, insertAttempt, insertOccurrence, occurrence as occurrenceRow } from '../src/scheduled/store.ts'
import { occ, quiet, shown } from './scheduled-fixtures.ts'

let dir: string
let store: Store
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-watch-')); store = new Store(join(dir, 'db.sqlite')) })
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
const KEY = 'master:nightly@2026-11-12T00:00:00.000Z'
const NAME = 'sch-master-nightly-20261112t0000z'
const NOW = new Date('2026-11-12T03:00:00Z')

type Reply = { code: number; stdout: string; stderr?: string }
function world(opts: { started: string; get: Reply; stop?: Reply; show?: () => Promise<unknown> }) {
  store.atomic(() => {
    insertOccurrence(store, occ({ occurrence: KEY, state: 'running', attempt: 1 }))
    insertAttempt(store, { occurrence: KEY, attempt: 1, rerun: 0, instance: NAME, revision: 'rev1', invocation: null, started_at: opts.started,
      ended_at: null, ending: null, exit_code: null, report: null })
  })
  const handlers = new Map<string, (payload: never) => Promise<void>>()
  const queue: { kind: string; key: string; payload: unknown }[] = []
  const calls: string[][] = []
  const exec = vi.fn(async (_file: string, args: string[]): Promise<Reply> => {
    calls.push(args)
    if (args[0] === 'get') return opts.get
    if (args[0] === 'stop') return opts.stop ?? { code: 0, stdout: '{"outcome":"stopped"}' }
    if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ name: NAME, invocationId: 'inv1', complete: true, streams: ['stdout'],
      lines: [JSON.stringify({ type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'All done.' })] }) }
    return { code: 0, stdout: '{}' }
  })
  const cli = { show: vi.fn(opts.show ?? (async () => shown({ outcome: { goal: 'ok', attempts: 1 } }))), env: vi.fn(), check: vi.fn(async () => ({ holds: false, exit: 1 })), gate: vi.fn() }
  new DshdExecutor({ engine: { assignmentStarted: vi.fn(), inputsDelivered: vi.fn(), report: vi.fn() } as never, store,
    effects: { enqueue: (kind: string, key: string, payload: unknown) => { queue.push({ kind, key, payload }) },
      handle: (kind: string, handler: (payload: never) => Promise<void>) => { handlers.set(kind, handler) } } as never,
    cli: cli as never, paused: () => false, closing: () => false, maxWorkers: () => 3, exec: exec as never, log: quiet, now: () => NOW })
  const payload: WatchPayload = { ticketId: 't1', assignmentId: 'a1', occurrence: KEY, attempt: 1, rerun: 0, name: NAME, root: dir }
  return { watch: () => handlers.get('watch')!(payload as never), calls, queue, cli }
}
const running = { code: 0, stdout: JSON.stringify({ state: 'running', lastRun: null }) }
const exited = (exitCode: number) => ({ code: 0, stdout: JSON.stringify({ state: 'stopped',
  lastRun: { ending: 'exited', child: { exitCode }, invocationId: 'inv1', endedAt: 1794452400 } }) })

describe('watch (C5.11)', () => {
  it('a run inside its timeout is polled again later and not stopped', async () => {
    const w = world({ started: '2026-11-12T02:50:00.000Z', get: running })
    await expect(w.watch()).rejects.toBeInstanceOf(Later)
    expect(w.calls.some(args => args[0] === 'stop')).toBe(false)
    expect(occurrenceRow(store, KEY)?.state).toBe('running')
  })
  it('a run past job.timeout is stopped once and settles failed, reason timeout, when no attempt is left', async () => {
    const w = world({ started: '2026-11-12T02:00:00.000Z', get: running })
    await w.watch()
    expect(w.calls.filter(args => args[0] === 'stop')).toEqual([['stop', '--json', NAME]])
    expect(occurrenceRow(store, KEY)).toMatchObject({ state: 'failed', reason: 'timeout' })
    expect(attemptsOf(store, KEY)[0].ended_at).not.toBeNull()
  })
  it('a workflow that cannot be shown mid-run leaves the run alone instead of timing it out (evaluation review)', async () => {
    const w = world({ started: '2026-11-12T01:00:00.000Z', get: running, show: async () => { throw new Error('scheduled show timed out') } })
    await expect(w.watch()).rejects.toBeInstanceOf(Later)
    expect(w.calls.some(args => args[0] === 'stop')).toBe(false)
  })
  it('a dshd stop that fails is retried, not settled', async () => {
    const w = world({ started: '2026-11-12T02:00:00.000Z', get: running, stop: { code: 1, stdout: '', stderr: '{"error":"busy"}' } })
    await expect(w.watch()).rejects.toThrow(/dshd stop .* exited 1/)
    expect(occurrenceRow(store, KEY)?.state).toBe('running')
  })
  it('a completed run is harvested from dshd read (complete, final line) and settles done with its report', async () => {
    const w = world({ started: '2026-11-12T02:50:00.000Z', get: exited(0) })
    await w.watch()
    expect(w.calls.some(args => args[0] === 'read')).toBe(true)
    expect(occurrenceRow(store, KEY)?.state).toBe('done')
    expect(attemptsOf(store, KEY)[0]).toMatchObject({ ending: 'exited', exit_code: 0, invocation: 'inv1', report: 'All done.' })
  })
  it('an instance dshd no longer knows is relaunched once as a rerun', async () => {
    const w = world({ started: '2026-11-12T02:50:00.000Z', get: { code: 3, stdout: '', stderr: '{"error":"not-found"}' } })
    await w.watch()
    expect(occurrenceRow(store, KEY)).toMatchObject({ state: 'queued', reason: 'instance not found' })
    expect(w.queue.filter(item => item.kind === 'sched-launch').map(item => (item.payload as { rerun?: boolean }).rerun)).toEqual([true])
  })
})
