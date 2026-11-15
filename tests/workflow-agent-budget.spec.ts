import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workflowTools } from '../src/sources/workflow-tools.ts'
import { workflowHost, newDirectory, type WorkflowHost } from './fixtures/workflow.ts'
import { run } from './workflow/helpers.ts'

const hosts: WorkflowHost[] = [], directories: string[] = []
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stop().catch(() => {})
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true })
})
function start(directory = newDirectory()) {
  if (!directories.includes(directory)) directories.push(directory)
  const h = workflowHost(directory); hosts.push(h)
  const script = join(directory, 'budget.workflow.js')
  writeFileSync(script, `export const meta = { name: 'budget', description: 'bounded test' }\nconst a = await agent('one', {label:'one'}); const b = await agent('two', {label:'two'}); return [a,b];`)
  return { h, script, directory }
}
const until = async (fn: () => unknown) => vi.waitFor(() => { if (!fn()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })

describe('explicit workflow lifetime agent budget', () => {
  it('public tool accepts a finite override, persists it and the Source enforces it', async () => {
    const { h, script, directory } = start(); await h.started
    const tool = workflowTools(h.floor)[0]!
    const value = await tool.execute(tool.schema.parse({ script, cwd: directory, max_agents: 1 }), new AbortController().signal) as { run_id: string }
    expect(h.run(value.run_id)?.maxAgents).toBe(1)
    expect(h.floor.status(value.run_id)[0]?.max_agents).toBe(1)
    await until(() => h.offered().some(c => h.label(c.triggers[0]!.id) === 'one'))
    h.accept('one'); h.report('one', 'ok')
    await until(() => h.run(value.run_id)?.state === 'failed')
    expect(h.run(value.run_id)?.error).toContain('lifetime cap of 1 agents reached')
    expect(h.offered().some(c => h.label(c.triggers[0]!.id) === 'two')).toBe(false)
  })

  it('keeps the original override on an idempotent Source request and restart replay', async () => {
    const { h: first, script, directory } = start(); await first.started
    const request = { script, cwd: directory, max_agents: 2, trigger_id: 'real-source-request' }
    const started = first.floor.startRun(request)
    expect(first.floor.startRun({ ...request, max_agents: 3 })).toMatchObject({ state: 'already-started', max_agents: 2 })
    await until(() => first.offered().some(c => first.label(c.triggers[0]!.id) === 'one'))
    first.accept('one'); first.report('one', 'ok')
    await until(() => first.offered().some(c => first.label(c.triggers[0]!.id) === 'two'))
    await first.stop(); hosts.splice(hosts.indexOf(first), 1)
    const second = workflowHost(directory); hosts.push(second); await second.started
    expect(second.run(started.run_id)?.maxAgents).toBe(2)
    expect(second.floor.status(started.run_id)[0]?.max_agents).toBe(2)
    await until(() => second.offered().some(c => second.label(c.triggers[0]!.id) === 'two'))
    second.accept('two'); second.report('two', 'ok')
    await until(() => second.run(started.run_id)?.state === 'completed')
  })

  it('refuses invalid overrides at both the public schema and direct handler', async () => {
    const { h, script, directory } = start(); await h.started
    const tool = workflowTools(h.floor)[0]!
    for (const n of [0, -1, 1.5, 1_000_001, Infinity, NaN]) {
      expect(tool.schema.safeParse({ script, cwd: directory, max_agents: n }).success).toBe(false)
      expect(() => h.floor.startRun({ script, cwd: directory, max_agents: n })).toThrow(RangeError)
    }
    expect(h.floor.status()).toHaveLength(0)
  })

  it('leaves the interpreter default at 1000 while an explicit higher budget passes', async () => {
    const body = `for (let i=0;i<1001;i++) await agent('item '+i); return 'finished';`
    const limited = await run(body, { concurrency: 1 })
    expect(limited.status).toBe('failed')
    expect(limited.error).toContain('lifetime cap of 1000 agents reached')
    expect(limited.calls).toHaveLength(1000)
    const explicit = await run(body, { concurrency: 1, maxAgents: 1001 })
    expect(explicit.status).toBe('completed')
    expect(explicit.result).toBe('finished')
    expect(explicit.calls).toHaveLength(1001)
  })
})
