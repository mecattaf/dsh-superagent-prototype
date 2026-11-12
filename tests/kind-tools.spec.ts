/** A Source kind's main-Session tools: the `orchestrator_<kind>_` prefix, and the Sessions that get them as the kind registers and
 * unregisters and as DSH creates the main Session's agent again. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sourceTool, type SourceKind } from '../src/sources/kind.ts'
import { feishu, startRuntime } from './fixtures/host.ts'

describe('a Source kind\'s main-Session tools', () => {
  const probe = (name: string): SourceKind => ({ kind: 'probe', title: { zh: 'probe', en: 'probe' }, description: { zh: 'probe', en: 'probe' },
    schema: z.object({}).strict(), fields: [], health: ['probe'],
    tools: [sourceTool({ name, description: 'Echo the text.', schema: z.object({ text: z.string() }).strict(), execute: async ({ text }) => ({ text }) })] })
  it('a kind\'s tools must be prefixed orchestrator_<kind>_ and reach the main Session', async () => {
    const host = await startRuntime()
    expect(() => host.runtime.sources.register(probe('orchestrator_echo'))).toThrow('does not start with orchestrator_probe_')
    expect(host.runtime.sources.kind('probe')).toBeUndefined()
    expect(host.tools.get(host.runtime.masterId)!.has('orchestrator_echo')).toBe(false)
    host.runtime.sources.register(probe('orchestrator_probe_echo'))
    expect(await host.runTool(host.runtime.masterId, 'orchestrator_probe_echo', { text: 'hi' })).toEqual({ text: 'hi' })
    await host.stop()
  })
  it('a kind\'s tools reach a main Session decorated before the kind registered, leave it when the kind unregisters, and come back', async () => {
    const host = await startRuntime()
    const unregister = host.runtime.sources.register(probe('orchestrator_probe_echo'))
    expect(await host.runTool(host.runtime.masterId, 'orchestrator_probe_echo', { text: 'hi' })).toEqual({ text: 'hi' })
    unregister()
    expect(host.tools.get(host.runtime.masterId)!.has('orchestrator_probe_echo')).toBe(false)
    host.runtime.sources.register(probe('orchestrator_probe_echo'))
    expect(host.tools.get(host.runtime.masterId)!.has('orchestrator_probe_echo')).toBe(true)
    await host.stop()
  })
  it('a kind\'s tools reach a main Session that DSH creates again, unless the kind unregistered, and never a worker\'s Session', async () => {
    const host = await startRuntime()
    const main = host.runtime.masterId
    // DSH creates the main Session's agent again; Sessions decorates the new agent as it decorated the first.
    const recreate = async () => {
      host.agents.delete(main)
      await host.controller.create({ sessionId: main })
      await (host.runtime as unknown as { ctx: { parallel(name: string, event: unknown): Promise<unknown> } }).ctx.parallel('agent/created', { agent: host.agents.get(main) })
    }
    const unregister = host.runtime.sources.register(probe('orchestrator_probe_echo'))
    await recreate()
    expect(await host.runTool(main, 'orchestrator_probe_echo', { text: 'again' })).toEqual({ text: 'again' })
    const { sessionId } = await host.acceptedTicket(feishu('1', '@bot 修一下回归'))
    expect(host.tools.get(sessionId)?.size).toBeGreaterThan(0)
    expect(host.tools.get(sessionId)!.has('orchestrator_probe_echo')).toBe(false)
    unregister()
    await recreate()
    expect(host.tools.get(main)!.has('orchestrator_probe_echo')).toBe(false)
    await host.stop()
  })
  it('a kind\'s tools leave the main Session when dsh-superagent stops, though DSH keeps the Session', async () => {
    const host = await startRuntime()
    const main = host.runtime.masterId
    host.runtime.sources.register(probe('orchestrator_probe_echo'))
    expect(host.tools.get(main)!.has('orchestrator_probe_echo')).toBe(true)
    await host.stop()
    expect(host.agents.has(main)).toBe(true)
    expect(host.tools.get(main)!.has('orchestrator_probe_echo')).toBe(false)
  })
})
