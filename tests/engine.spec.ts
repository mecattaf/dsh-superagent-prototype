/** The plugin entry on a Cordis context with DeepSeek Harness's services: an entry whose engine is off stays inert. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** A context that provides every service the entry injects, each recording what registers with it. */
function host() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-engine-'))
  directories.push(directory)
  const unregister = () => () => {}
  const services = {
    agents: new Map(), llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) },
    sessionController: { create: vi.fn(async () => {}), resolveAgent: vi.fn(), selectModel: vi.fn(), rename: vi.fn(), prompt: vi.fn() },
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn() }, workspaceRegistry: { create: vi.fn() },
    permissionPresets: { set: vi.fn() }, tools: { register: vi.fn(unregister), get: () => undefined, restrict: vi.fn(unregister), guard: vi.fn(unregister) },
    systemPrompt: { section: vi.fn(unregister) }, skills: { register: vi.fn(unregister) },
    webServer: { host: '127.0.0.1', port: 3082, register: vi.fn(unregister) },
    subprocess: { spawn: vi.fn(() => { throw new Error('The entry must not start a process here') }) },
  }
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  // A Source plugin, as github-watch and feishu-watch are: it starts only once the `orchestrator` service exists.
  const source = vi.fn()
  ctx.plugin({ name: 'source', inject: ['orchestrator'], apply: source })
  return { ctx, services, source, stateDir: join(directory, 'state'), directory }
}

it('with the engine off, takes no lock, opens no database, changes no process environment and registers nothing', async () => {
  const { ctx, services, source, stateDir, directory } = host()
  const environment = { ...process.env }
  const fiber = await ctx.plugin(plugin, { stateDir, engine: false })
  expect(existsSync(stateDir)).toBe(false)
  expect(readdirSync(directory)).toEqual([])
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(source).not.toHaveBeenCalled()
  expect(services.webServer.register).not.toHaveBeenCalled()
  expect(services.tools.register).not.toHaveBeenCalled()
  expect(services.sessionController.create).not.toHaveBeenCalled()
  expect(services.subprocess.spawn).not.toHaveBeenCalled()
  expect(process.env).toEqual(environment)
  await fiber.dispose()
  expect(readdirSync(directory)).toEqual([])
})

it('still refuses keys of the previous configuration with the engine off', async () => {
  const { ctx, stateDir } = host()
  await expect(ctx.plugin(plugin, { stateDir, engine: false, repository: 'acme/widgets' })).rejects.toThrow('repository (now on the GitHub Source)')
  expect(existsSync(stateDir)).toBe(false)
})

it('by default runs as before: locks the state directory, opens its database, serves its routes and the orchestrator service', async () => {
  const { ctx, services, source, stateDir } = host()
  const fiber = await ctx.plugin(plugin, { stateDir })
  expect(existsSync(`${stateDir}.lock`)).toBe(true)
  expect(existsSync(join(stateDir, 'orchestrator.sqlite'))).toBe(true)
  expect(services.webServer.register).toHaveBeenCalled()
  expect(ctx.get('orchestrator')).toBeDefined()
  await vi.waitFor(() => { expect(source).toHaveBeenCalledOnce() })
  await fiber.dispose()
  await vi.waitFor(() => { expect(existsSync(`${stateDir}.lock`)).toBe(false) })
})

it('takes over the state directory lock a hard-killed process left, once it goes stale, instead of failing ELOCKED', async () => {
  const { ctx, stateDir } = host()
  // A process killed with SIGKILL leaves its lock directory, last refreshed shortly before it died; it goes stale 30 s after that.
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(`${stateDir}.lock`)
  const refreshed = new Date(Date.now() - 29_000)
  utimesSync(`${stateDir}.lock`, refreshed, refreshed)
  const fiber = await ctx.plugin(plugin, { stateDir })
  expect(ctx.get('orchestrator')).toBeDefined()
  expect(statSync(`${stateDir}.lock`).mtimeMs).toBeGreaterThan(refreshed.getTime() + 25_000)
  await fiber.dispose()
  await vi.waitFor(() => { expect(existsSync(`${stateDir}.lock`)).toBe(false) })
})

it('waits at most lockWaitMs for a state directory lock that a live process holds, then refuses to start', async () => {
  const { ctx, services, stateDir } = host()
  mkdirSync(stateDir, { recursive: true })
  const release = lockSync(stateDir, { stale: 30_000 })
  try {
    const started = Date.now()
    await expect(ctx.plugin(plugin, { stateDir, lockWaitMs: 1_000 })).rejects.toThrow('Lock file is already being held')
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(ctx.get('orchestrator')).toBeUndefined()
    expect(services.webServer.register).not.toHaveBeenCalled()
    expect(existsSync(join(stateDir, 'orchestrator.sqlite'))).toBe(false)
  } finally { release() }
})
