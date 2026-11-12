import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { UserError, type Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import * as workflowPlugin from '../src/sources/workflow.ts'
import { TicketWaiter } from '../src/sources/workflow-backend.ts'
import { WorkflowFloor } from '../src/sources/workflow-floor.ts'
import { workflowTools } from '../src/sources/workflow-tools.ts'
import { FIXTURE, newDirectory, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
const received = (h: WorkflowHost) => h.receive.mock.calls.map(([trigger], index) => [(trigger as Trigger).meta.label, h.receive.mock.results[index]!.value])
let directories: string[] = [], hosts: WorkflowHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function start(directory = newDirectory(), options?: Parameters<typeof workflowHost>[1]) {
  if (!directories.includes(directory)) directories.push(directory)
  const host = workflowHost(directory, options)
  hosts.push(host)
  return { h: host, directory }
}
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }
const script = (name: string, body: string) => `export const meta = { name: '${name}', description: 'A test script' }\n${body}\n`

describe('orchestrator_workflow_start', () => {
  it('start is idempotent on trigger_id', async () => {
    const { h, directory } = start()
    await h.started
    const request = { script: FIXTURE, cwd: directory, args: { tag: 't' }, trigger_id: 'request-1' }
    const first = h.floor.startRun(request)
    expect(first).toMatchObject({ state: 'started', name: 'fixture-3' })
    expect(h.floor.startRun(request)).toEqual({ ...first, state: 'already-started' })
    expect(h.floor.status()).toHaveLength(1)
    expect(h.floor.startRun({ ...request, trigger_id: 'request-2' }).run_id).not.toBe(first.run_id)
  })
  it('start keys a run by its trigger, script, cwd and args, and a start with no trigger_id is a new run each time', async () => {
    const { h, directory } = start()
    await h.started
    const elsewhere = newDirectory(); directories.push(elsewhere)
    const edited = join(directory, 'edited.workflow.js')
    writeFileSync(edited, `${readFileSync(FIXTURE, 'utf8')}\n// edited\n`)
    const request = { script: FIXTURE, cwd: directory, args: { tag: 't' }, trigger_id: 'request-1' }
    const runs = [request, { ...request, args: { tag: 'u' } }, { ...request, script: edited }, { ...request, cwd: elsewhere }].map(item => h.floor.startRun(item))
    expect(runs.map(run => run.state)).toEqual(['started', 'started', 'started', 'started'])
    expect(new Set(runs.map(run => run.run_id)).size).toBe(4)
    const fresh = [h.floor.startRun({ script: FIXTURE, cwd: directory }), h.floor.startRun({ script: FIXTURE, cwd: directory })]
    expect(fresh.map(run => run.state)).toEqual(['started', 'started'])
    expect(fresh[0]!.run_id).not.toBe(fresh[1]!.run_id)
  })
  it('a run\'s pair is the request\'s, else the Source\'s pair, and an empty Source pair names none', async () => {
    const pairs = (h: WorkflowHost, run: string) => h.receive.mock.calls.map(([trigger]) => trigger as Trigger).filter(trigger => trigger.meta.run === run)
      .map(trigger => 'pair' in trigger.meta ? trigger.meta.pair : 'none')
    const { h, directory } = start()
    await h.started
    const none = h.floor.startRun({ script: FIXTURE, cwd: directory }).run_id
    const named = h.floor.startRun({ script: FIXTURE, cwd: directory, pair: 'p-request' }).run_id
    await until(() => h.offered().length === 4)
    expect([pairs(h, none), pairs(h, named)]).toEqual([['none', 'none'], ['p-request', 'p-request']])
    expect(h.run(none)).not.toHaveProperty('pair')
    const { h: h2, directory: other } = start(undefined, { config: { pair: 'p-source' } })
    await h2.started
    const configured = h2.floor.startRun({ script: FIXTURE, cwd: other }).run_id
    const overridden = h2.floor.startRun({ script: FIXTURE, cwd: other, pair: 'p-request' }).run_id
    await until(() => h2.offered().length === 4)
    expect([pairs(h2, configured), pairs(h2, overridden)]).toEqual([['p-source', 'p-source'], ['p-request', 'p-request']])
  })
  it('status without run_id lists the 20 newest runs, newest first, and refuses a run it does not have', async () => {
    const { h } = start()
    await h.started
    // Written oldest first under ids that sort the same way, so neither the order of writes nor of keys is newest first.
    for (let n = 0; n < 21; n++) {
      const id = `wf-${String(n).padStart(2, '0')}`
      h.context.state.set(KV.workflow.run(id), { id, name: 'old', scriptPath: '/old.workflow.js', scriptSha256: '', cwd: '/', state: 'completed',
        startedAt: new Date(Date.UTC(2026, 10, 12, 0, n)).toISOString(), seq: 0 })
    }
    expect(h.floor.status().map(run => run.run_id)).toEqual(Array.from({ length: 20 }, (_, n) => `wf-${String(20 - n).padStart(2, '0')}`))
    expect(() => h.floor.status('wf-missing')).toThrow('Unknown workflow run wf-missing')
  })
  it('a resumed run uses the pinned script, not the edited file', async () => {
    const { h: h1, directory } = start()
    await h1.started
    const path = join(directory, 'fixture.workflow.js')
    writeFileSync(path, readFileSync(FIXTURE, 'utf8'))
    h1.floor.startRun({ script: 'fixture.workflow.js', cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    await h1.stop()
    writeFileSync(path, readFileSync(FIXTURE, 'utf8').replaceAll('alpha', 'gamma'))
    const { h: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 2)
    expect(received(h2)).toEqual([['a1', 'duplicate'], ['a2', 'duplicate']])
  })
  it('nested workflow() resolves beside the script, then <cwd>/.claude/workflows, and is pinned', async () => {
    const { h: h1, directory } = start()
    await h1.started
    mkdirSync(join(directory, 'scripts')); mkdirSync(join(directory, '.claude', 'workflows'), { recursive: true })
    const parent = join(directory, 'scripts', 'parent.workflow.js')
    writeFileSync(parent, script('parent', 'return [await workflow("child"), await workflow("shared")]'))
    writeFileSync(join(directory, 'scripts', 'child.js'), script('child', 'return await agent("Child work.", { label: "child" })'))
    writeFileSync(join(directory, '.claude', 'workflows', 'shared.js'), script('shared', 'return await agent("Shared work.", { label: "shared" })'))
    const { run_id: run } = h1.floor.startRun({ script: parent, cwd: directory })
    await until(() => h1.offered().length === 1)
    h1.accept('child'); h1.report('child', 'child done')
    await until(() => h1.offered().some(candidate => h1.label(candidate.triggers[0]!.id) === 'shared'))
    await h1.stop()
    writeFileSync(join(directory, '.claude', 'workflows', 'shared.js'), script('shared', 'return await agent("Edited work.", { label: "shared" })'))
    const { h: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 1)
    expect(received(h2)).toEqual([['shared', 'duplicate']])
    h2.accept('shared'); h2.report('shared', 'shared done')
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: ['child done', 'shared done'] })
  })
  it('nested workflow() refuses a workflow() inside a child, as the interpreter nests one level only', async () => {
    const { h, directory } = start()
    await h.started
    writeFileSync(join(directory, 'top.workflow.js'), script('top', 'return await workflow("middle")'))
    writeFileSync(join(directory, 'middle.js'), script('middle', 'return await workflow("bottom")'))
    writeFileSync(join(directory, 'bottom.js'), script('bottom', 'return 1'))
    const { run_id: run } = h.floor.startRun({ script: 'top.workflow.js', cwd: directory })
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'failed', error: expect.stringContaining('nesting is limited') })
  })
  it('nested workflow() resolves a relative .js reference beside the calling script, not the run\'s cwd', async () => {
    const { h, directory } = start()
    await h.started
    mkdirSync(join(directory, 'scripts', 'lib'), { recursive: true })
    writeFileSync(join(directory, 'scripts', 'parent.workflow.js'), script('parent', 'return await workflow("./lib/child.js")'))
    writeFileSync(join(directory, 'scripts', 'lib', 'child.js'), script('child', 'return await agent("Child work.", { label: "child" })'))
    const { run_id: run } = h.floor.startRun({ script: 'scripts/parent.workflow.js', cwd: directory })
    await until(() => h.offered().length === 1)
    h.accept('child'); h.report('child', 'child done')
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: 'child done' })
  })
  it('a run whose kept script is gone fails on resume rather than read the file again', async () => {
    const { h: h1, directory } = start()
    await h1.started
    const { run_id: run, script_sha256: sha } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    await h1.stop()
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    store.delete(KV.workflow.script(sha))
    store.close()
    const { h: h2 } = start(directory)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'failed', result: null, error: `the script ${sha} it was started with is not kept` })
    expect(h2.receive).not.toHaveBeenCalled()
  })
  it('nested workflow() takes the child beside the script before the one of the same name in <cwd>/.claude/workflows', async () => {
    const { h, directory } = start()
    await h.started
    mkdirSync(join(directory, '.claude', 'workflows'), { recursive: true })
    writeFileSync(join(directory, 'parent.workflow.js'), script('parent', 'return await workflow("child")'))
    writeFileSync(join(directory, 'child.js'), script('child', 'return await agent("Work beside.", { label: "child" })'))
    writeFileSync(join(directory, '.claude', 'workflows', 'child.js'), script('child', 'return await agent("Shared work.", { label: "child" })'))
    h.floor.startRun({ script: 'parent.workflow.js', cwd: directory })
    await until(() => h.offered().length === 1)
    expect(h.receive.mock.calls.map(([trigger]) => (trigger as Trigger).text)).toEqual(['Work beside.'])
  })
  it('start refuses a relative or missing cwd and an invalid meta, and a script it cannot read', async () => {
    const { h, directory } = start()
    await h.started
    writeFileSync(join(directory, 'bad.js'), 'return 1\n')
    expect(() => h.floor.startRun({ script: FIXTURE, cwd: 'relative' })).toThrow(new UserError('workflowCwd', { cwd: 'relative' }))
    expect(() => h.floor.startRun({ script: FIXTURE, cwd: join(directory, 'missing') })).toThrow('cwd must be an absolute path to an existing directory')
    expect(() => h.floor.startRun({ script: FIXTURE, cwd: FIXTURE })).toThrow('cwd must be an absolute path to an existing directory')
    expect(() => h.floor.startRun({ script: 'missing.js', cwd: directory })).toThrow('Cannot read the workflow script')
    expect(() => h.floor.startRun({ script: 'bad.js', cwd: directory })).toThrow('must export a valid meta')
    expect(h.floor.status()).toEqual([])
  })
  it('the tools refuse once the Source stopped and while setup is pending, which resumes no run', async () => {
    const { h: h1, directory } = start()
    await h1.started
    const { run_id: run } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    h1.floor.stop()
    expect(() => h1.floor.startRun({ script: FIXTURE, cwd: directory })).toThrow('not running')
    expect(() => h1.floor.status(run)).toThrow('not running')
    await h1.stop()
    const { h: h2 } = start(directory, { configured: () => false })
    await h2.started
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h2.floor.active).toBe(0)
    expect(h2.receive).not.toHaveBeenCalled()
    expect(() => h2.floor.status(run)).toThrow('not running')
  })
  it('a floor stopped before setup ends drives no run once setup ends', async () => {
    const { h: h1, directory } = start()
    await h1.started
    h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    await h1.stop()
    let ready!: () => void
    const { h: h2 } = start(directory, { ready: new Promise<void>(resolve => { ready = resolve }) })
    h2.floor.stop()
    ready()
    await h2.started
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h2.floor.active).toBe(0)
    expect(h2.receive).not.toHaveBeenCalled()
  })
  it('a run that ends as its floor stops records no end, and the next floor drives it to its end', async () => {
    const { h: h1, directory } = start()
    await h1.started
    writeFileSync(join(directory, 'quick.workflow.js'), script('quick', 'return 7'))
    const { run_id: run } = h1.floor.startRun({ script: 'quick.workflow.js', cwd: directory })
    h1.floor.stop()
    await until(() => h1.floor.active === 0)
    expect(h1.run(run)).toMatchObject({ state: 'running' })
    await h1.stop()
    const { h: h2 } = start(directory)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: 7 })
  })
})

describe('the workflow tools\' refusals', () => {
  /** What a tool call that throws settles to: DSH renders a thrown tool as `Error: <message>`, the text the brain reads. */
  const refusal = async (call: Promise<unknown>) => {
    const error = await call.then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(UserError)
    return `Error: ${(error as UserError).message}`
  }
  it('answers each refusal as a UserError whose text says what to change, as the host\'s own tools do', async () => {
    const { h, directory } = start()
    await h.started
    writeFileSync(join(directory, 'bad.js'), 'return 1\n')
    const [startTool, statusTool] = workflowTools(h.floor)
    const signal = new AbortController().signal
    const begin = (args: Record<string, unknown>) => startTool!.execute(startTool!.schema.parse(args), signal)
    const missing = join(directory, 'missing')
    expect(await refusal(begin({ script: FIXTURE, cwd: missing })))
      .toBe(`Error: cwd must be an absolute path to an existing directory, which ${missing} is not`)
    expect(await refusal(begin({ script: 'missing.js', cwd: directory })))
      .toMatch(new RegExp(`^Error: Cannot read the workflow script ${join(directory, 'missing.js')} \\(ENOENT: .*\\); name an existing script, absolute or relative to cwd$`))
    expect(await refusal(begin({ script: 'bad.js', cwd: directory })))
      .toMatch(new RegExp(`^Error: The workflow script ${join(directory, 'bad.js')} must export a valid meta \\(.*export const meta.*\\)$`))
    expect(await refusal(statusTool!.execute({ run_id: 'wf-none' }, signal)))
      .toBe('Error: Unknown workflow run wf-none; orchestrator_workflow_status without run_id lists the newest runs')
    h.floor.stop()
    for (const call of [begin({ script: FIXTURE, cwd: directory }), statusTool!.execute({}, signal)]) {
      expect(await refusal(call)).toBe('Error: The workflow Source is not running: it is off, stopping or waiting for setup; retry once it runs')
    }
  })
})

describe('the plugin entry', () => {
  it('waits without the orchestrator service, as where the engine is off, and registers its kind once the service exists, until disposed', async () => {
    const start = vi.spyOn(WorkflowFloor.prototype, 'start')
    const directory = newDirectory(); directories.push(directory)
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
    const deps = { store, sources, ready: new Promise<void>(() => {}), configured: () => false } as unknown as SourceContextDeps
    const ctx = new Context()
    const fiber = ctx.plugin(workflowPlugin, {})
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(start).not.toHaveBeenCalled()
    ctx.reflect.provide('orchestrator', { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) })
    await vi.waitFor(() => { expect(sources.kind('workflow')).toBeDefined() })
    expect(start).toHaveBeenCalledOnce()
    await fiber.dispose()
    expect(sources.kind('workflow')).toBeUndefined()
    start.mockRestore()
    store.close()
  })
  it('a start that fails becomes the Source\'s health, not an unhandled rejection', async () => {
    const start = vi.spyOn(WorkflowFloor.prototype, 'start').mockRejectedValue(new Error('setup broke'))
    const directory = newDirectory(); directories.push(directory)
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const deps = { store, sources, ready: Promise.resolve(), configured: () => true } as unknown as SourceContextDeps
    const ctx = new Context()
    ctx.reflect.provide('orchestrator', { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) })
    const fiber = ctx.plugin(workflowPlugin, {})
    await vi.waitFor(() => { expect(board.all.workflow).toMatchObject({ state: 'error', detail: 'Error: setup broke' }) })
    await fiber.dispose()
    start.mockRestore()
    store.close()
  })
  it('defaults to a poll every 2000 ms, 16 calls in flight, one attempt per call and no pair', () => {
    const config = workflowPlugin.Config({})
    expect([config.pollMs.get(), config.concurrency, config.maxAttempts, config.pair]).toEqual([2000, 16, 1, ''])
  })
  it('reads pollMs at each poll, so a value committed in place applies without a remount', () => {
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const config = workflowPlugin.Config({ pollMs: 500 })
      const nothing = { threads: { get: () => undefined }, tickets: { get: () => undefined, open: () => [] }, state: { get: () => undefined, set: () => {} },
        triggers: { decision: () => undefined } }
      const waiter = new TicketWaiter(nothing as never, () => config.pollMs.get())
      void waiter.settled('wf:run:node-a1', 'workflow:run:node', false)
      expect(timers.mock.calls.at(-1)?.[1]).toBe(500)
      commit(config.pollMs, 1000)
      vi.advanceTimersByTime(500)
      expect(timers.mock.calls.at(-1)?.[1]).toBe(1000)
      waiter.stop()
    } finally { timers.mockRestore(); vi.useRealTimers() }
  })
  it('tells observed that a held node left that state when its Ticket ends between two polls, so the health counts it no more', async () => {
    vi.useFakeTimers()
    try {
      const trigger = 'wf:run:node-a1', thread = 'workflow:run:node'
      const decision = { id: 'd1', kind: 'ignore', reason: [{ code: 'x' }], at: '2026-11-12T01:00:00.000Z' }
      const source = { threads: { get: () => ({ pending: [], subscriptions: [] }) }, tickets: { get: () => undefined, open: () => [] },
        state: { get: () => undefined, set: () => {} }, triggers: { decision: () => decision } }
      const observed = vi.fn()
      const waiter = new TicketWaiter(source as never, () => 5, observed)
      const answer = waiter.settled(trigger, thread, false)
      vi.advanceTimersByTime(5)
      expect(observed).toHaveBeenLastCalledWith({ trigger, state: 'held', decision })
      expect(waiter.count('held')).toBe(1)
      // A requeue, an accept and the Ticket's end all came before the next poll, which would have seen the Ticket.
      const ticket = { id: 't1', origin: { triggerId: trigger, triggerIds: [trigger] }, ended: { outcome: 'completed' },
        assignments: [{ report: { state: 'ready', summary: 'DONE' } }] }
      waiter.ended(ticket as never)
      expect(await answer).toEqual({ text: 'DONE', agentId: 't1' })
      expect(observed).toHaveBeenCalledTimes(2)
      expect(observed).toHaveBeenLastCalledWith({ trigger })
      expect(waiter.count('held')).toBe(0)
      waiter.stop()
    } finally { vi.useRealTimers() }
  })
  it('refuses configuration keys it does not use before registering anything, so a misspelt key never runs on the default', () => {
    const start = vi.spyOn(WorkflowFloor.prototype, 'start')
    const ctx = new Context()
    expect(() => workflowPlugin.apply(ctx, workflowPlugin.Config({ pollMS: 500, maxAttempt: 2 } as never))).toThrow('keys it does not use: pollMS, maxAttempt')
    expect(start).not.toHaveBeenCalled()
    start.mockRestore()
  })
})
