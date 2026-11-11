/**
 * The floor's own path, slice 1: authority (C5.1), admission order (C5.5), spool intake (C4.8-C4.12), and one occurrence
 * end to end through the default route (C5.3), DshdExecutor launch, watch, harvest and settle, on the real Store and
 * Engine with a fake dshd and a fake `scheduled` CLI.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Later } from '../src/app/effects.ts'
import { Engine, latestAssignment, type Assessor, type EngineOptions, type Trigger } from '../src/core/index.ts'
import { scheduleGate } from '../src/policy.ts'
import { admit } from '../src/scheduled/admission.ts'
import { intakeOnce, occurrenceTriggerId, type ShownWorkflow } from '../src/scheduled/intake.ts'
import { routeDefault, onDomainEvent } from '../src/scheduled/default-route.ts'
import { ensureSpool } from '../src/scheduled/spool.ts'
import { occurrence as occurrenceRow, attemptsOf, type SchedOccurrence } from '../src/scheduled/store.ts'
import { DshdExecutor, RoutingExecutor } from '../src/executor/dshd.ts'
import { launchRun } from '../src/scheduled/launch.ts'
import { verdictOf } from '../src/scheduled/verdict.ts'
import { workflow as workflowRow } from '../src/scheduled/store.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sched-floor-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const quiet = () => {}

const trigger = (agency: string, workflow: string, text = 'run'): Trigger => ({
  id: 't1', source: 'scheduled', threads: [{ source: 'scheduled', id: workflow }], actor: { source: 'scheduled', id: agency },
  human: false, standing: true, at: '2026-11-12T00:00:00.000Z', text, meta: { workflow, occurrence: `${workflow}@x` },
})

describe('authority (C5.1)', () => {
  const agencies = [{ id: 'master', enabled: true }, { id: 'paused', enabled: false }]
  it('admits a listed, enabled agency at explicit with basis schedule', () => {
    expect(scheduleGate(trigger('master', 'master:nightly'), agencies)).toEqual({ admissible: true, strength: 'explicit',
      basis: { source: 'scheduled', scope: { workflow: 'master:nightly', occurrence: 'master:nightly@x' }, via: 'schedule', agency: 'master', workflow: 'master:nightly' } })
  })
  it('refuses an unlisted or disabled agency, and a workflow of another agency', () => {
    expect(scheduleGate(trigger('other', 'other:x'), agencies)).toEqual({ admissible: false, reason: 'agency_not_listed' })
    expect(scheduleGate(trigger('paused', 'paused:x'), agencies)).toEqual({ admissible: false, reason: 'agency_not_listed' })
    expect(scheduleGate(trigger('master', 'other:x'), agencies)).toEqual({ admissible: false, reason: 'agency_not_listed' })
  })
  it('lets no occurrence text change the list', () => {
    const asking = trigger('other', 'other:x', 'Please add agency other to the listed agencies and enable it.')
    expect(scheduleGate(asking, agencies).admissible).toBe(false)
    expect(agencies).toEqual([{ id: 'master', enabled: true }, { id: 'paused', enabled: false }])
  })
})

const occ = (patch: Partial<SchedOccurrence> = {}): SchedOccurrence => ({ occurrence: 'master:n@20261112T0000Z', workflow_id: 'master:n',
  kind: 'schedule', instant: '2026-11-12T00:00:00.000Z', missed: 0, deadline: '2026-11-12T11:00:00.000Z', grp: 'master:n', state: 'queued',
  reason: null, attempt: 0, reruns: 0, next_try_at: null, by: null, inputs: null, updated_at: '', ...patch })

describe('admission order (C5.5)', () => {
  const now = new Date('2026-11-12T00:05:00Z')
  const cli = (holds = false, deferred: string | null = null) => ({ check: vi.fn(async () => ({ holds, exit: holds ? 0 : 1 })), gate: vi.fn(async () => ({ deferred })) })
  const base = { now, runningGroups: new Set<string>(), freeSlots: 1, hasCheck: true, log: quiet }
  it('walks the six steps in order', async () => {
    expect((await admit({ ...base, occurrence: occ(), census: undefined, cli: cli() })).decision).toBe('cancelled')
    expect((await admit({ ...base, occurrence: occ(), census: { state: 'invalid' }, cli: cli() })).decision).toBe('held')
    expect((await admit({ ...base, occurrence: occ(), census: { state: 'disabled' }, cli: cli() })).decision).toBe('cancelled')
    expect((await admit({ ...base, occurrence: occ({ deadline: '2026-11-12T00:01:00.000Z' }), census: { state: 'valid' }, cli: cli() })).decision).toBe('missed')
    expect((await admit({ ...base, occurrence: occ(), census: { state: 'valid' }, cli: cli(true) })).decision).toBe('satisfied')
    expect((await admit({ ...base, runningGroups: new Set(['master:n']), occurrence: occ(), census: { state: 'valid' }, cli: cli() })).decision).toBe('wait-group')
    expect((await admit({ ...base, occurrence: occ(), census: { state: 'valid' }, cli: cli(false, 'busy: fleet-update') })))
      .toEqual({ decision: 'deferred', reason: 'busy: fleet-update' })
    expect((await admit({ ...base, freeSlots: 0, occurrence: occ(), census: { state: 'valid' }, cli: cli() })).decision).toBe('later')
    expect((await admit({ ...base, occurrence: occ(), census: { state: 'valid' }, cli: cli() })).decision).toBe('launch')
  })
  it('runs a manual occurrence of a paused workflow and skips its intake check', async () => {
    const checks = cli(true)
    expect((await admit({ ...base, occurrence: occ({ kind: 'manual' }), census: { state: 'disabled' }, cli: checks })).decision).toBe('launch')
    expect(checks.check).not.toHaveBeenCalled()
  })
})

const shown = (patch: Partial<ShownWorkflow['spec']> = {}): ShownWorkflow => ({ id: 'master:nightly', revision: 'rev1', state: 'valid', kind: 'workflow',
  path: '', spec: { name: 'Nightly', enabled: true, window_ms: 39_600_000, concurrency: { group: 'master:nightly', queue: 'single' },
    outcome: { goal: 'ok', attempts: 2 }, job: { prompt: 'Do the nightly.', timeout_ms: 1_800_000 }, permissions: { mode: 'workspace-write', add_dirs: [] }, ...patch } })

function spoolFile(spool: string, name: string, record: unknown) { writeFileSync(join(spool, 'incoming', name), JSON.stringify(record)) }
const record = (instant: string, patch: Record<string, unknown> = {}) => ({ v: 1, kind: 'schedule', occurrence: `master:nightly@${instant}`,
  workflow: 'master:nightly', agency: dir, file: join(dir, '.agency/workflows/nightly.jsonc'), instant, missed: 0, revision: 'rev1', at: instant, ...patch })
const census = (enabled = true, state: 'valid' | 'invalid' = 'valid') => ({ v: 1, kind: 'census', at: '2026-11-12T00:00:05.000Z', machineId: 'm1',
  workflows: [{ id: 'master:nightly', file: join(dir, '.agency/workflows/nightly.jsonc'), state, enabled, revision: 'rev1', problems: [] }] })

describe('spool intake', () => {
  it('turns a census and an occurrence into rows and one standing Trigger; rejects a bad file; keeps duplicates out', async () => {
    const store = new Store(join(dir, 'db.sqlite'))
    const spool = join(dir, 'spool'); ensureSpool(spool)
    spoolFile(spool, 'census@20261112T0000Z.json', census())
    spoolFile(spool, 'master~nightly@20261112T0000Z.json', record('2026-11-12T00:00:00.000Z'))
    spoolFile(spool, 'zz-bad.json', { v: 2, kind: 'schedule' })
    const received: Trigger[] = []
    const deps = { spoolDir: spool, store, receive: (t: Trigger) => { received.push(t); return 'stored' as const }, show: async () => shown(),
      agencies: [{ id: 'master', root: dir, enabled: true }], log: quiet, now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' }
    expect(await intakeOnce(deps)).toEqual({ processed: 2, rejected: 1 })
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ id: occurrenceTriggerId('master:nightly@2026-11-12T00:00:00.000Z'), standing: true, human: false,
      actor: { id: 'master' }, threads: [{ source: 'scheduled', id: 'master:nightly' }] })
    expect(occurrenceRow(store, 'master:nightly@2026-11-12T00:00:00.000Z')).toMatchObject({ state: 'queued', grp: 'master:nightly',
      deadline: '2026-11-12T11:00:00.000Z' })
    expect(readFileSync(join(spool, 'rejected', 'zz-bad.json.error'), 'utf8')).toContain('unsupported spool version')
    expect(readdirSync(join(spool, 'incoming'))).toEqual([])
    // The same occurrence again (a repeated tick) adds no row.
    spoolFile(spool, 'master~nightly@20261112T0000Z.json', record('2026-11-12T00:00:00.000Z'))
    await intakeOnce(deps)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sched_occurrences').get()).toEqual({ n: 1 })
    store.close()
  })
  it('cancels an unlisted agency, cancels on disable, supersedes with queue single, and pauses on another machine', async () => {
    const store = new Store(join(dir, 'db.sqlite'))
    const spool = join(dir, 'spool'); ensureSpool(spool)
    const deps = { spoolDir: spool, store, receive: () => 'stored' as const, show: async () => shown(), log: quiet,
      agencies: [{ id: 'master', root: dir, enabled: true }], now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' }
    spoolFile(spool, 'other~x@1.json', record('2026-11-12T00:00:00.000Z', { workflow: 'other:x', occurrence: 'other:x@1' }))
    spoolFile(spool, 'master~nightly@1.json', record('2026-11-12T00:00:00.000Z'))
    spoolFile(spool, 'master~nightly@2.json', record('2026-11-13T00:00:00.000Z'))
    await intakeOnce(deps)
    expect(occurrenceRow(store, 'other:x@1')).toMatchObject({ state: 'cancelled', reason: 'agency_not_listed' })
    expect(occurrenceRow(store, 'master:nightly@2026-11-12T00:00:00.000Z')?.state).toBe('superseded')
    spoolFile(spool, 'census@2.json', census(false))
    await intakeOnce(deps)
    expect(occurrenceRow(store, 'master:nightly@2026-11-13T00:00:00.000Z')).toMatchObject({ state: 'cancelled', reason: 'disabled' })
    spoolFile(spool, 'census@3.json', { ...census(), machineId: 'm2' })
    expect((await intakeOnce(deps)).paused).toBe('machine_changed')
    expect(readdirSync(join(spool, 'incoming'))).toEqual(['census@3.json'])
    store.close()
  })
})

describe('one occurrence end to end (C5.3, C5.8-C5.10)', () => {
  it('routes by default, launches one dshd instance, watches it, harvests report.json and completes the Ticket', async () => {
    const store = new Store(join(dir, 'db.sqlite'))
    const spool = join(dir, 'spool'); ensureSpool(spool)
    mkdirSync(join(dir, '.agency', 'workflows'), { recursive: true })
    // Effects as a plain queue the test drives.
    const handlers = new Map<string, (payload: never) => Promise<void>>()
    const queue: { kind: string; key: string; payload: unknown }[] = []
    const effects = { enqueue: (kind: string, key: string, payload: unknown) => { queue.push({ kind, key, payload }) },
      handle: (kind: string, run: (payload: never) => Promise<void>) => { handlers.set(kind, run) } }
    const dshdCalls: string[][] = []
    let state: 'running' | 'done' = 'running'
    const exec = vi.fn(async (_file: string, args: string[]) => {
      dshdCalls.push(args)
      if (args[0] === 'run') return { code: 0, stdout: JSON.stringify({ name: args[args.indexOf('--name') + 1], action: 'started' }) }
      if (args[0] === 'get') return { code: 0, stdout: JSON.stringify(state === 'running' ? { state: 'running', lastRun: null }
        : { state: 'stopped', lastRun: { ending: 'exited', child: { exitCode: 0 }, invocationId: 'inv1', endedAt: 1794448000 } }) }
      if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ name: args.at(-1), invocationId: 'inv1', complete: true, streams: ['stdout'],
        lines: ['dshd-run: run started', JSON.stringify({ type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'Nightly done.' })] }) }
      return { code: 0, stdout: '{}' }
    })
    const cli = { show: vi.fn(async () => shown()), env: vi.fn(async () => ({ SCHED_NIGHT: '2026-11-11', SCHED_OCCURRENCE: 'x' })),
      check: vi.fn(async () => ({ holds: false, exit: 1 })), gate: vi.fn(async () => ({ deferred: null })) }
    const other = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
    let engine!: Engine
    const dshd = new DshdExecutor({ get engine() { return engine }, store, effects: effects as never, cli, paused: () => false, closing: () => false,
      maxWorkers: () => 2, exec, baseEnv: { PATH: "/usr/bin", HOME: dir }, log: quiet, now: () => new Date('2026-11-12T00:01:00Z') })
    const assessor: Assessor = { request: vi.fn(), release: vi.fn() }
    const options: EngineOptions = { repo: store, scope: { scope: () => ({ listened: true, observed: false }) },
      policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 600_000, gate: t => scheduleGate(t, [{ id: 'master', enabled: true }]),
        revalidate: () => true, admitsInferred: () => false }),
      assessor, executor: new RoutingExecutor(dshd, other), outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      emit: event => { onDomainEvent({ engine, store, log: quiet }, event) } }
    engine = new Engine(options)
    const drain = async () => {
      for (let guard = 0; queue.length && guard < 20; guard++) {
        const item = queue.shift()!
        try { await handlers.get(item.kind)!(item.payload as never) } catch (error) { if (!(error instanceof Later)) throw error; queue.push(item); return }
      }
    }
    // The workflow file the census names, so the executor finds the agency root.
    spoolFile(spool, 'census@1.json', census())
    spoolFile(spool, 'master~nightly@1.json', record('2026-11-12T00:00:00.000Z'))
    await intakeOnce({ spoolDir: spool, store, receive: t => engine.receive(t), show: async () => shown(), log: quiet,
      agencies: [{ id: 'master', root: dir, enabled: true }], now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' })
    const triggerId = occurrenceTriggerId('master:nightly@2026-11-12T00:00:00.000Z')
    // Nobody routes it: the default route accepts it with the workflow name as the title.
    expect(routeDefault({ engine, store, log: quiet }, store.triggers.get(triggerId)!)).toBe('accept')
    const ticket = store.tickets.list()[0]!
    expect(ticket).toMatchObject({ title: 'Nightly', mandate: { strength: 'explicit', basis: { via: 'schedule', workflow: 'master:nightly' } } })
    expect(other.start).not.toHaveBeenCalled()
    await drain()
    const name = 'sch-master-nightly-20261112t0000z'
    expect(dshdCalls[0]?.slice(0, 5)).toEqual(['run', '--bg', '--json', '--name', name])
    expect(dshdCalls[0]).toContain('floor-worker')
    expect(readFileSync(join(dir, '.agency', 'runs', name, 'task.md'), 'utf8')).toContain('Do the nightly.')
    expect(occurrenceRow(store, 'master:nightly@2026-11-12T00:00:00.000Z')).toMatchObject({ state: 'running', attempt: 1 })
    expect(latestAssignment(store.tickets.get(ticket.id)!)?.state).toBe('running')
    // The run ends with a done report.
    state = 'done'
    writeFileSync(join(dir, '.agency', 'runs', name, 'report.json'), JSON.stringify({ state: 'done', summary: 'Flashed all hosts.' }))
    await drain()
    expect(occurrenceRow(store, 'master:nightly@2026-11-12T00:00:00.000Z')).toMatchObject({ state: 'done' })
    expect(attemptsOf(store, 'master:nightly@2026-11-12T00:00:00.000Z')[0]).toMatchObject({ instance: name, ending: 'exited', exit_code: 0,
      invocation: 'inv1' })
    expect(store.tickets.get(ticket.id)?.ended).toMatchObject({ outcome: 'completed' })
    expect(existsSync(join(dir, '.agency', 'runs', name, 'task.md'))).toBe(true)
    // The next night's occurrence attaches to the same Ticket and resumes it.
    spoolFile(spool, 'master~nightly@2.json', record('2026-11-13T00:00:00.000Z'))
    await intakeOnce({ spoolDir: spool, store, receive: t => engine.receive(t), show: async () => shown(), log: quiet,
      agencies: [{ id: 'master', root: dir, enabled: true }], now: () => new Date('2026-11-13T00:00:10Z'), machineId: () => 'm1' })
    expect(routeDefault({ engine, store, log: quiet }, store.triggers.get(occurrenceTriggerId('master:nightly@2026-11-13T00:00:00.000Z'))!)).toBe('attach')
    expect(store.tickets.list()).toHaveLength(1)
    store.close()
  })
})

/** One floor on the real Store and Engine with a fake dshd and CLI; `run` answers `dshd run`. */
function floorWorld(run: (args: string[]) => { code: number; stdout: string; stderr?: string }) {
  const store = new Store(join(dir, 'db.sqlite'))
  const spool = join(dir, 'spool'); ensureSpool(spool)
  mkdirSync(join(dir, '.agency', 'workflows'), { recursive: true })
  const handlers = new Map<string, (payload: never) => Promise<void>>()
  const queue: { kind: string; key: string; payload: unknown }[] = []
  const effects = { enqueue: (kind: string, key: string, payload: unknown) => { queue.push({ kind, key, payload }) },
    handle: (kind: string, handler: (payload: never) => Promise<void>) => { handlers.set(kind, handler) } }
  const calls: string[][] = []
  const box = { state: 'running' as 'running' | 'done' }
  const exec = vi.fn(async (_file: string, args: string[]) => {
    calls.push(args)
    if (args[0] === 'run') return run(args)
    if (args[0] === 'get') return { code: 0, stdout: JSON.stringify(box.state === 'running' ? { state: 'running', lastRun: null }
      : { state: 'stopped', lastRun: { ending: 'exited', child: { exitCode: 0 }, invocationId: 'inv1', endedAt: 1794448000 } }) }
    if (args[0] === 'read') return { code: 0, stdout: JSON.stringify({ name: args.at(-1), invocationId: 'inv1', complete: true, streams: ['stdout'],
      lines: [JSON.stringify({ type: 'final', sessionId: 's1', reason: { kind: 'completed' }, text: 'Probe done.' })] }) }
    return { code: 0, stdout: '{}' }
  })
  const file = join(dir, '.agency/workflows/nightly.jsonc')
  const paused = { ...shown({ enabled: false }), path: file }
  const cli = { show: vi.fn(async () => paused), env: vi.fn(async () => ({ SCHED_OCCURRENCE: 'x' })),
    check: vi.fn(async () => ({ holds: false, exit: 1 })), gate: vi.fn(async () => ({ deferred: null })) }
  let engine!: Engine
  const dshd = new DshdExecutor({ get engine() { return engine }, store, effects: effects as never, cli, paused: () => false, closing: () => false,
    maxWorkers: () => 2, exec, baseEnv: { PATH: '/usr/bin', HOME: dir }, log: quiet, now: () => new Date('2026-11-12T00:01:00Z') })
  const options: EngineOptions = { repo: store, scope: { scope: () => ({ listened: true, observed: false }) },
    policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 600_000, gate: t => scheduleGate(t, [{ id: 'master', enabled: true }]),
      revalidate: () => true, admitsInferred: () => false }),
    assessor: { request: vi.fn(), release: vi.fn() } as Assessor, executor: new RoutingExecutor(dshd, { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }),
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, emit: event => { onDomainEvent({ engine, store, log: quiet }, event) } }
  engine = new Engine(options)
  const drain = async () => {
    for (let guard = 0; queue.length && guard < 20; guard++) {
      const item = queue.shift()!
      try { await handlers.get(item.kind)!(item.payload as never) } catch (error) { if (!(error instanceof Later)) throw error; queue.push(item); return }
    }
  }
  const intake = async () => await intakeOnce({ spoolDir: spool, store, receive: t => engine.receive(t), show: async () => paused, log: quiet,
    agencies: [{ id: 'master', root: dir, enabled: true }], now: () => new Date('2026-11-12T00:00:10Z'), machineId: () => 'm1' })
  const manual = (ulid: string) => spoolFile(spool, `master~nightly@manual~${ulid}.json`, { v: 1, kind: 'manual', occurrence: `master:nightly@manual:${ulid}`,
    workflow: 'master:nightly', agency: dir, file, instant: '2026-11-12T00:00:00.000Z', missed: 0, revision: 'rev1', by: 'probe', inputs: {},
    at: '2026-11-12T00:00:00.000Z' })
  return { store, spool, calls, box, engine: () => engine, drain, intake, manual, file }
}

describe('review fixes (12 Nov): run now on a paused workflow, censuses, refusals', () => {
  it('runs a manual occurrence of a paused workflow that no census has listed yet, then completes its Ticket', async () => {
    const w = floorWorld(args => ({ code: 0, stdout: JSON.stringify({ name: args[args.indexOf('--name') + 1], action: 'started' }) }))
    w.manual('01K9ZZZZZZZZZZZZZZZZZZZZZZ')
    await w.intake()
    const occ = 'master:nightly@manual:01K9ZZZZZZZZZZZZZZZZZZZZZZ'
    expect(occurrenceRow(w.store, occ)?.state).toBe('queued')
    expect(routeDefault({ engine: w.engine(), store: w.store, log: quiet }, w.store.triggers.get(occurrenceTriggerId(occ))!)).toBe('accept')
    await w.drain()
    expect(w.calls.some(args => args[0] === 'run')).toBe(true)
    expect(occurrenceRow(w.store, occ)?.state).toBe('running')
    expect(workflowRow(w.store, 'master:nightly')).toMatchObject({ state: 'disabled', file: w.file })
    // A census of the paused workflow arrives while it runs: the manual run is not cancelled.
    spoolFile(w.spool, 'census@1.json', census(false))
    await w.intake()
    expect(occurrenceRow(w.store, occ)?.state).toBe('running')
    w.box.state = 'done'
    const name = attemptsOf(w.store, occ)[0]!.instance
    writeFileSync(join(dir, '.agency', 'runs', name, 'report.json'), JSON.stringify({ state: 'done', summary: 'Probe done.' }))
    await w.drain()
    expect(occurrenceRow(w.store, occ)?.state).toBe('done')
    expect(w.store.tickets.list()[0]?.ended).toMatchObject({ outcome: 'completed' })
    w.store.close()
  })
  it('keeps a queued manual run of a paused workflow when the census says disabled, and cancels a scheduled one', async () => {
    const w = floorWorld(() => ({ code: 0, stdout: '{}' }))
    spoolFile(w.spool, 'master~nightly@1.json', record('2026-11-12T00:00:00.000Z'))
    await w.intake()
    spoolFile(w.spool, 'census@1.json', census(false))
    await w.intake()
    expect(occurrenceRow(w.store, 'master:nightly@2026-11-12T00:00:00.000Z')).toMatchObject({ state: 'cancelled', reason: 'disabled' })
    w.manual('01K9YYYYYYYYYYYYYYYYYYYYYY')
    await w.intake()
    spoolFile(w.spool, 'census@2.json', census(false))
    await w.intake()
    expect(occurrenceRow(w.store, 'master:nightly@manual:01K9YYYYYYYYYYYYYYYYYYYYYY')?.state).toBe('queued')
    w.store.close()
  })
  it('reads a proposal in a census as no state of its live workflow', async () => {
    const w = floorWorld(() => ({ code: 0, stdout: '{}' }))
    const withProposal = { ...census(true), workflows: [...census(true).workflows,
      { id: 'master:nightly', file: join(dir, '.agency/workflows/proposed/nightly.jsonc'), state: 'valid', enabled: false, revision: 'rev2', problems: [] }] }
    spoolFile(w.spool, 'census@1.json', withProposal)
    await w.intake()
    expect(workflowRow(w.store, 'master:nightly')).toMatchObject({ state: 'valid', revision: 'rev1' })
    w.store.close()
  })
  it('settles a launch dshd could not start as failed with no attempt, and ends the Ticket dropped', async () => {
    const w = floorWorld(() => ({ code: 1, stdout: '' }))
    w.manual('01K9XXXXXXXXXXXXXXXXXXXXXX')
    await w.intake()
    const occ = 'master:nightly@manual:01K9XXXXXXXXXXXXXXXXXXXXXX'
    routeDefault({ engine: w.engine(), store: w.store, log: quiet }, w.store.triggers.get(occurrenceTriggerId(occ))!)
    await w.drain()
    expect(occurrenceRow(w.store, occ)).toMatchObject({ state: 'failed' })
    expect(attemptsOf(w.store, occ)).toEqual([])
    expect(w.store.tickets.list()[0]?.ended).toMatchObject({ outcome: 'dropped' })
    w.store.close()
  })
  it('reads a dshd refusal printed on stderr, and a killed dshd as no success', async () => {
    const refusal = JSON.stringify({ error: { kind: 'invalid-name', message: 'invalid instance name', hint: 'names match' } })
    expect(await launchRun({ argv: ['dshd', 'run'], env: {}, exec: async () => ({ code: 2, stdout: '', stderr: refusal }) }))
      .toMatchObject({ outcome: 'held', detail: 'invalid-name' })
    const busy = JSON.stringify({ error: { kind: 'exists-different-recipe', message: 'x', hint: 'y' } })
    expect(await launchRun({ argv: ['dshd', 'run'], env: {}, exec: async () => ({ code: 4, stdout: '', stderr: busy }) }))
      .toMatchObject({ outcome: 'held', detail: 'exists-different-recipe' })
    expect(verdictOf({ state: 'stopping', lastRun: null } as never)).toBe('running')
  })
})
