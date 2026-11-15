/** The bundle's patch, read with the entry-list dialect DSH reads bundle patches with, and the agent preset it defines. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ROUTER_PRESET, WORKER_PRESET } from '../src/app/sessions.ts'

interface Row { id?: string; name: string; disabled?: unknown; config?: Record<string, unknown> & { plugins?: Row[] } | Row[] }
const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
/** The patch as DSH reads it: Cordis's include plugin parses `!!js` scalars, and applies the inserts to an entry list. A later layer,
 * such as a profile's `cordis.patch.yml`, applies to the result the same way. */
async function patched(...layers: unknown[][]): Promise<Row[]> {
  const { entryListSchema, applyEntryPatches } = await import(include) as {
    entryListSchema: unknown; applyEntryPatches(data: Row[], patches: unknown[], warn: (message: string) => void): Row[] }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  const patches = yaml.load(readFileSync(join(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as unknown[]
  const warnings: string[] = []
  const rows = [patches, ...layers].reduce<Row[]>((data, layer) => applyEntryPatches(data, layer, message => { warnings.push(message) }), [])
  expect(warnings).toEqual([])
  return rows
}
/** Whether DSH's Loader starts a row: a `!!js` `disabled` evaluates against the row's entry context, as `Entry.disabled` does. */
async function disabled(row: Row): Promise<boolean> {
  const { Context } = await import('@deepseek-ai/cordis')
  const { Entry, evaluate, isJsExpr } = await import(createRequire(include).resolve('@deepseek-ai/cordis-plugin-loader')) as {
    Entry: { key: symbol }; evaluate(ctx: object, expr: string): unknown; isJsExpr(value: unknown): value is { __jsExpr: string } }
  const ctx = new Context().extend({ [Entry.key]: { options: row } })
  return isJsExpr(row.disabled) ? Boolean(evaluate(ctx, row.disabled.__jsExpr)) : Boolean(row.disabled)
}
/** Every plugin row of a preset, those inside groups too. */
const flat = (rows: readonly Row[]): Row[] => rows.flatMap(row => [row, ...Array.isArray(row.config) ? flat(row.config) : []])

/** A preset the patch defines, by its id. */
const presetOf = (rows: readonly Row[], id: string) => rows.map(row => row.config as { id?: string; order?: number; plugins: Row[] })
  .find(config => config?.id === id)!

it('defines the worker preset Executor Sessions run under, with a shell that moves long commands to the background', async () => {
  const rows = await patched()
  expect(rows.map(row => row.id)).toEqual(['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'dsh-superagent-scheduled',
    'dsh-superagent-workflow', 'dsh-superagent-worker-preset', 'dsh-superagent-router-preset'])
  // The optional Sources are inserted off; a profile turns them on.
  expect(rows.filter(row => row.disabled === true).map(row => row.id)).toEqual(['dsh-superagent-feishu', 'dsh-superagent-scheduled',
    'dsh-superagent-workflow'])
  expect(rows.find(row => row.id === 'dsh-superagent-scheduled')?.name).toBe('dsh-superagent/scheduled-watch')
  const preset = presetOf(rows, WORKER_PRESET)
  expect(preset.id).toBe(WORKER_PRESET)
  const plugins = flat(preset.plugins)
  const named = (name: string) => plugins.filter(row => row.name === name).map(row => row.config)
  expect(named('@deepseek-ai/dsh-bash-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-pwsh-sandbox')).toEqual([{ timeoutMs: 5000, maxTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-jobs')).toEqual([{ waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }])
  expect(named('@deepseek-ai/dsh-tool-web')).toEqual([expect.objectContaining({ fetch: false })])
  // Spawned subagents run under standard, whose shell moves a command to the background only after 60 s; forked ones, which would run under
  // this preset, are left out.
  expect(named('@deepseek-ai/dsh-tool-subagent')).toEqual([expect.objectContaining({ provider: 'spawn', agentPreset: 'standard' })])
  // What a worker needs, and none of what asks a person, presents, plans, changes the profile, schedules, sets goals or runs workflows.
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-agent-instructions']) expect(named(name).length).toBeGreaterThan(0)
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode', '@deepseek-ai/dsh-plugin-manager/tools',
    '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-command-goal',
    '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names).not.toContain(name)
})

it('defines the router preset the main Session runs under: the worker\'s 5-second shell and job waits, and only the tools it uses', async () => {
  const rows = await patched()
  const router = presetOf(rows, ROUTER_PRESET), worker = presetOf(rows, WORKER_PRESET)
  expect(router.order).toBe(91)
  const plugins = flat(router.plugins)
  const named = (preset: Row[], name: string) => preset.filter(row => row.name === name).map(row => row.config)
  for (const name of ['@deepseek-ai/dsh-bash-sandbox', '@deepseek-ai/dsh-pwsh-sandbox', '@deepseek-ai/dsh-tool-jobs']) {
    expect(named(plugins, name), name).toEqual(named(flat(worker.plugins), name))
  }
  // The tools its allow list keeps: skill, bash, read, read_image and the job tools; the file tools only read.
  for (const name of ['@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-compaction-basic',
    '@deepseek-ai/dsh-compaction-tool-result-pruner']) expect(named(plugins, name).length, name).toBeGreaterThan(0)
  expect(named(plugins, '@deepseek-ai/dsh-tool-fs')).toEqual([{ write: false, edit: false }])
  const names = plugins.map(row => row.name)
  for (const name of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-subagent-control', '@deepseek-ai/dsh-tool-web', '@deepseek-ai/dsh-tool-fs-search',
    '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-plugin-manager/tools', '@deepseek-ai/dsh-plugin-market/tools', '@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-workflow-ptc']) expect(names, name).not.toContain(name)
})

it('leaves the main entry off while the profile sets engine: false, so a headless app reports no entry waiting for a web app', async () => {
  const main = async (...layers: unknown[][]) => (await patched(...layers)).find(row => row.id === 'dsh-superagent')!
  const profile = (config: Record<string, unknown>, row: Record<string, unknown> = {}) => [{ id: 'dsh-superagent', config, ...row }]
  // The entry's services include a web app's (index.ts `inject`): in DSH's headless app it would wait for them on every start.
  expect(await disabled(await main(profile({ stateDir: '/srv/state', engine: false })))).toBe(true)
  // With the engine on, or left at its default, the entry starts, and DSH still reports a service it waits for.
  expect(await disabled(await main(profile({ stateDir: '/srv/state', engine: true })))).toBe(false)
  expect(await disabled(await main(profile({ stateDir: '/srv/state' })))).toBe(false)
  expect(await disabled(await main())).toBe(false)
  // A profile that sets the row's own switch decides; the entry's `engine` gate then keeps it inert.
  expect(await disabled(await main(profile({ stateDir: '/srv/state', engine: false }, { disabled: false })))).toBe(false)
  expect(await disabled(await main(profile({ stateDir: '/srv/state', engine: true }, { disabled: true })))).toBe(true)
})
