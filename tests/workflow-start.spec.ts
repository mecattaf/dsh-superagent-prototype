import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import * as workflowPlugin from '../src/sources/workflow.ts'
import { TicketWaiter } from '../src/sources/workflow-backend.ts'
import { WorkflowFloor } from '../src/sources/workflow-floor.ts'
import { FIXTURE, newDirectory, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
const received = (h: WorkflowHost) => h.receive.mock.calls.map(([trigger], index) => [(trigger as Trigger).meta.label, h.receive.mock.results[index]!.value])
let directories: string[] = [], hosts: WorkflowHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function start(directory = newDirectory()) {
  if (!directories.includes(directory)) directories.push(directory)
  const host = workflowHost(directory)
  hosts.push(host)
  return { h: host, directory }
}
/** Simulate the Cordis loader updating a volatile configuration reference in place. */
const commit = (reference: unknown, value: unknown) => { (reference as Record<symbol, (value: unknown) => void>)[Symbol.for('cosmokit.volatile.write')]!(value) }
const script = (name: string, body: string) => `export const meta = { name: '${name}', description: 'A test script' }\n${body}\n`

describe('orchestrator_workflow_start', () => {
  it('starts one run per trigger_id: the same request again returns the run it started', async () => {
    const { h, directory } = start()
    await h.started
    const request = { script: FIXTURE, cwd: directory, args: { tag: 't' }, trigger_id: 'request-1' }
    const first = h.floor.startRun(request)
    expect(first).toMatchObject({ state: 'started', name: 'fixture-3' })
    expect(h.floor.startRun(request)).toEqual({ ...first, state: 'already-started' })
    expect(h.floor.status()).toHaveLength(1)
    expect(h.floor.startRun({ ...request, trigger_id: 'request-2' }).run_id).not.toBe(first.run_id)
  })
  it('resumes a run with the script it started with, not the file as it is now', async () => {
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
  it('resolves workflow() beside the script, then in <cwd>/.claude/workflows, and resumes with the children it read', async () => {
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
  it('refuses a workflow() inside a child, as the interpreter nests one level only', async () => {
    const { h, directory } = start()
    await h.started
    writeFileSync(join(directory, 'top.workflow.js'), script('top', 'return await workflow("middle")'))
    writeFileSync(join(directory, 'middle.js'), script('middle', 'return await workflow("bottom")'))
    writeFileSync(join(directory, 'bottom.js'), script('bottom', 'return 1'))
    const { run_id: run } = h.floor.startRun({ script: 'top.workflow.js', cwd: directory })
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'failed', error: expect.stringContaining('nesting is limited') })
  })
  it('refuses a relative or missing cwd, a script it cannot read, and a script without a valid meta', async () => {
    const { h, directory } = start()
    await h.started
    writeFileSync(join(directory, 'bad.js'), 'return 1\n')
    expect(() => h.floor.startRun({ script: FIXTURE, cwd: 'relative' })).toThrow('cwd must be an absolute path')
    expect(() => h.floor.startRun({ script: FIXTURE, cwd: join(directory, 'missing') })).toThrow('cwd is not a directory')
    expect(() => h.floor.startRun({ script: 'missing.js', cwd: directory })).toThrow('cannot read the script')
    expect(() => h.floor.startRun({ script: 'bad.js', cwd: directory })).toThrow('meta is invalid')
    expect(h.floor.status()).toEqual([])
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
  it('reads pollMs at each poll, so a value committed in place applies without a remount', () => {
    vi.useFakeTimers()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const config = workflowPlugin.Config({ pollMs: 500 })
      const nothing = { threads: { get: () => undefined }, tickets: { get: () => undefined } }
      const waiter = new TicketWaiter(nothing as never, () => config.pollMs.get())
      void waiter.settled('wf:run:node-a1', 'workflow:run:node', false)
      expect(timers.mock.calls.at(-1)?.[1]).toBe(500)
      commit(config.pollMs, 1000)
      vi.advanceTimersByTime(500)
      expect(timers.mock.calls.at(-1)?.[1]).toBe(1000)
      waiter.stop()
    } finally { timers.mockRestore(); vi.useRealTimers() }
  })
})
