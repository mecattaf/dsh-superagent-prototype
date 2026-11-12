/** The plugin entry on a Cordis context with DeepSeek Harness's services: an entry whose engine is off stays inert. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** The services DSH's headless app (`dsh-headless`) does not provide: it has no web server, Session controller or workspace registry. */
const WEB_ONLY = ['sessionController', 'workspaceRegistry', 'webServer']
/** Cordis's `FiberState.ACTIVE`, a const enum. */
const ACTIVE = 2

/** A context that provides every service the engine runs on, except `omit`, each recording what registers with it. */
function host(omit: readonly string[] = []) {
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
  // Capture every level: the default buffer keeps only the levels at or above the logger's default.
  const messages: { type: string; args: unknown[] }[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export: message => { messages.push(message) } })
  /** The text of each message logged at `type`. */
  const logged = (type: string): string[] => messages.filter(message => message.type === type).map(message => message.args.map(String).join(' '))
  for (const [name, service] of Object.entries(services)) if (!omit.includes(name)) ctx.reflect.provide(name, service)
  // A Source plugin, as github-watch and feishu-watch are: it starts only once the `orchestrator` service exists.
  const source = vi.fn()
  ctx.plugin({ name: 'source', inject: ['orchestrator'], apply: source })
  return { ctx, services, source, logged, stateDir: join(directory, 'state'), directory }
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

/** A stand-in for DSH's Loader service: `await()` settles once the plugin tree has no lifecycle work left. */
function loader(ctx: Context) {
  let settle = () => {}
  const settled = new Promise<void>(resolve => { settle = resolve })
  ctx.reflect.provide('loader', { await: () => settled })
  return { settle: async () => { settle(); await settled; await new Promise(resolve => setImmediate(resolve)) } }
}

it('with the engine off, activates in a headless app, which has no web server, Session controller or workspace registry', async () => {
  const { ctx, source, logged, stateDir, directory } = host(WEB_ONLY)
  const fiber = await ctx.plugin(plugin, { stateDir, engine: false })
  // DSH reports every entry that stays pending as "did not activate" on each boot; a dormant entry is active and quiet.
  expect(fiber.state).toBe(ACTIVE)
  expect(logged('info').join('\n')).toContain('engine is off')
  expect(logged('warn')).toEqual([])
  expect(readdirSync(directory)).toEqual([])
  expect(ctx.get('orchestrator')).toBeUndefined()
  expect(source).not.toHaveBeenCalled()
  await fiber.dispose()
})

it('with the engine on, still reports a host service the engine waits for once the plugin tree settled without it', async () => {
  const { ctx, logged, stateDir } = host(['webServer'])
  const tree = loader(ctx)
  await ctx.plugin(plugin, { stateDir })
  expect(existsSync(stateDir)).toBe(false)
  await tree.settle()
  expect(logged('warn').join('\n')).toMatch(/engine .*waiting for service: webServer/)
  expect(existsSync(stateDir)).toBe(false)
})

it('with the engine on, starts the Runtime once a host service that arrives late is provided, and reports nothing', async () => {
  const { ctx, services, logged, stateDir } = host(['webServer'])
  const tree = loader(ctx)
  const fiber = await ctx.plugin(plugin, { stateDir })
  expect(existsSync(stateDir)).toBe(false)
  ctx.reflect.provide('webServer', services.webServer)
  await vi.waitFor(() => { expect(ctx.get('orchestrator')).toBeDefined() })
  expect(existsSync(`${stateDir}.lock`)).toBe(true)
  expect(services.webServer.register).toHaveBeenCalled()
  await tree.settle()
  expect(logged('warn')).toEqual([])
  await fiber.dispose()
  await vi.waitFor(() => { expect(existsSync(`${stateDir}.lock`)).toBe(false) })
})

it('with the engine on and its services present, fails the entry when the Runtime cannot start, as before', async () => {
  const first = host()
  const held = await first.ctx.plugin(plugin, { stateDir: first.stateDir })
  const second = host()
  await expect(second.ctx.plugin(plugin, { stateDir: first.stateDir })).rejects.toThrow(/lock/i)
  await held.dispose()
})
