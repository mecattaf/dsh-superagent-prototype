/** The two floor profile patch files of DESIGN 9.3, read with the YAML library DSH reads cordis.patch.yml with. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface Row { id: string; disabled?: unknown; config?: Record<string, unknown> }
/** Parses one deploy/ patch file as a plain entry list: these rows carry no `!!js` scalars, so the default schema suffices. */
async function rows(file: string): Promise<Row[]> {
  const root = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = root.resolve('@deepseek-ai/cordis-plugin-include')
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string): unknown }
  return yaml.load(readFileSync(join(import.meta.dirname, '..', 'deploy', file), 'utf8')) as Row[]
}
/** A row by its id. */
const rowOf = (rows: readonly Row[], id: string) => rows.find(row => row.id === id)!

describe('deploy/floor.cordis.patch.yml', () => {
  it('has exactly the rows of DESIGN 9.3, in order', async () => {
    const rows_ = await rows('floor.cordis.patch.yml')
    expect(rows_.map(row => row.id)).toEqual(['dsh-superagent', 'agent-default-model', 'llm-claude', 'webserver', 'schedule', 'ui-schedule'])
  })
  it('points the bundle at the master state directory and the Claude preset at the subscription guard', async () => {
    const rows_ = await rows('floor.cordis.patch.yml')
    expect(rowOf(rows_, 'dsh-superagent').config).toEqual({ stateDir: '/home/tom/.agency/state/master' })
    expect(rowOf(rows_, 'agent-default-model').config).toEqual({ provider: 'claude', model: 'opus', reasoningEffort: 'medium' })
    const llm = rowOf(rows_, 'llm-claude').config!
    // The design writes the path as a line continuation; the parsed value is one path ending in the guard's binary.
    expect(llm.executablePath).toBe('/home/tom/.dsh/profiles/floor/node_modules/dsh-superagent/bin/floor-claude')
    expect(llm.idleTimeoutMs).toBe(1800000)
    expect(llm.maxProcesses).toBe(2)
    expect(Object.keys(llm)).toEqual(['executablePath', 'idleTimeoutMs', 'maxProcesses'])
  })
  it('pins the panel port and disables DSH\'s own Schedule, the floor being the only scheduler', async () => {
    const rows_ = await rows('floor.cordis.patch.yml')
    expect(rowOf(rows_, 'webserver').config).toEqual({ port: 3082 })
    expect(rowOf(rows_, 'schedule')).toEqual({ id: 'schedule', disabled: true })
    expect(rowOf(rows_, 'ui-schedule')).toEqual({ id: 'ui-schedule', disabled: true })
  })
})

describe('deploy/floor-worker.cordis.patch.yml', () => {
  it('has exactly the rows of DESIGN 9.3, in order', async () => {
    const rows_ = await rows('floor-worker.cordis.patch.yml')
    expect(rows_.map(row => row.id)).toEqual(['agent-preset-registry', 'agent-default-model', 'llm-claude'])
  })
  it('defaults the worker to claude under the same model and guard, with one process', async () => {
    const rows_ = await rows('floor-worker.cordis.patch.yml')
    expect(rowOf(rows_, 'agent-preset-registry').config).toEqual({ default: 'claude' })
    expect(rowOf(rows_, 'agent-default-model').config).toEqual({ provider: 'claude', model: 'opus', reasoningEffort: 'medium' })
    const llm = rowOf(rows_, 'llm-claude').config!
    expect(llm.executablePath).toBe('/home/tom/.dsh/profiles/floor/node_modules/dsh-superagent/bin/floor-claude')
    expect(llm.idleTimeoutMs).toBe(1800000)
    expect(llm.maxProcesses).toBe(1)
    expect(Object.keys(llm)).toEqual(['executablePath', 'idleTimeoutMs', 'maxProcesses'])
  })
})
