/**
 * Workflow nodes end to end on the dshd executor: the workflow Source plugin on the Runtime, a run started with the main
 * Session's `orchestrator_workflow_start`, each node accepted under rule `workflow-node`, and each Ticket one unit of an
 * in-memory dshd whose final answer becomes the node's result.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket } from '../src/core/index.ts'
import { BINDING } from '../src/executor/dshd.ts'
import { KV } from '../src/kv.ts'
import * as workflow from '../src/sources/workflow.ts'
import { nodeTriggerId, SCHEMA_INSTRUCTION } from '../src/sources/workflow-trigger.ts'
import { nodeUsage, type RunStatus } from '../src/sources/workflow-runs.ts'
import { KvJournal } from '../src/sources/workflow-store.ts'
import { reference } from './fixtures/deployment.ts'
import { acceptCandidate, later, runArgv, startDshdHost } from './fixtures/dshd-host.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import type { Host } from './fixtures/host.ts'
import { FIXTURE } from './fixtures/workflow.ts'

/** The usage two workers' DSH Sessions recorded per step: an OpenAI-compatible provider (totals, no cache writes) and Claude (cache writes, no total). */
const OPENAI = [{ inputTokens: 3076, outputTokens: 116, totalTokens: 8662, cacheReadTokens: 5470 },
  { inputTokens: 38, outputTokens: 1, totalTokens: 8701, cacheReadTokens: 8662 }]
const CLAUDE = { inputTokens: 2, outputTokens: 239, cacheReadTokens: 32343, cacheWriteTokens: 372 }
/** The rule a deployment seeds for workflow nodes. */
const RULE = { id: 'workflow-node', name: 'Workflow node', enabled: true, instruction: 'A workflow node proceeds by default.' }
const PROMPT = 'Write notes/digest.md from the pull requests merged yesterday, then reply with its first line.'
const COUNT = { type: 'object', required: ['count'], properties: { count: { type: 'number' } } }
const COUNT_PROMPT = 'Count the pull requests merged yesterday. Reply as {"count": <number>}.'

let h: Host | undefined
let fake: FakeDshd
let unmount: (() => Promise<void>) | undefined
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await unmount?.(); unmount = undefined
  await h?.stop(); h = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const agency = (): string => { const made = mkdtempSync(join(tmpdir(), 'workflow-agency-')); directories.push(made); return made }
/** Writes a one-node script into `cwd`: a text node, or a node with the COUNT schema. */
function script(cwd: string, kind: 'text' | 'schema'): string {
  const call = kind === 'text' ? `agent(${JSON.stringify(PROMPT)}, { label: 'digest' })`
    : `agent(${JSON.stringify(COUNT_PROMPT)}, { label: 'count', schema: ${JSON.stringify(COUNT)} })`
  writeFileSync(join(cwd, 'once.workflow.js'), `export const meta = { name: 'once', description: 'One node' }\nconst answer = await ${call}\nreturn { answer }\n`)
  return 'once.workflow.js'
}

/** The host with the `workflow-node` rule and admission cell seeded, and the workflow plugin mounted. */
async function start(): Promise<void> {
  ({ h, fake } = await startDshdHost({ rule: RULE, source: 'workflow', row: 'workflow' }))
  await mount()
}
/** Mounts the plugin entry on the Runtime as DSH loads it, polling every `pollMs` (5 ms), and waits until its runs are under way. */
async function mount(pollMs = 5, maxAttempts = 1): Promise<void> {
  const disposers: (() => unknown)[] = []
  workflow.apply({ orchestrator: h!.runtime, logger: { info: () => {}, warn: () => {} }, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never,
    { pollMs: reference(pollMs), offeredWarnSeconds: reference(3600), concurrency: 16, maxAttempts, pair: '' } as never)
  unmount = async () => { for (const dispose of disposers.reverse()) await dispose() }
  await vi.waitFor(() => { if (h!.runtime.health.workflow?.state !== 'ready') throw new Error('not yet') })
}
/** The main Session starts a run as a request asks, with its tool. */
async function startRun(cwd: string, file: string, args?: unknown): Promise<string> {
  const started = await h!.runTool(h!.runtime.masterId, 'orchestrator_workflow_start', { script: file, cwd, ...args !== undefined && { args } })
  expect(started).toMatchObject({ state: 'started' })
  return started.run_id as string
}
const status = async (run: string): Promise<RunStatus> =>
  ((await h!.runTool(h!.runtime.masterId, 'orchestrator_workflow_status', { run_id: run })).runs as RunStatus[])[0]!
/** Waits until the node labelled `label` is offered, then accepts it as the rule says; returns its Trigger id and Ticket. */
async function acceptNode(run: string, label: string): Promise<{ trigger: string; ticket: Ticket }> {
  const trigger = await vi.waitFor(async () => {
    const node = (await status(run)).nodes.find(item => item.label === label)
    if (node?.state !== 'offered') throw new Error(`${label} is ${node?.state ?? 'not started'}`)
    return node.trigger_id!
  })
  const ticket = await acceptCandidate(h!, trigger, { rule: 'workflow-node', title: `Node ${label}`, worktree: `node-${label}`, scope: `Node ${label}` })
  return { trigger, ticket }
}
const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
const unitOf = (ticket: Ticket) => h!.runtime.store.get(BINDING(stored(ticket).assignments[0]!.id))!.name
/** Waits for the run to end, and returns its stored row. */
async function ended(run: string) {
  await vi.waitFor(async () => { if ((await status(run)).state === 'running') throw new Error('still running') })
  return h!.runtime.store.get(KV.workflow.run(run))!
}
const journal = (run: string) => KvJournal.text(h!.runtime.context({ kind: 'workflow', health: ['workflow'] }), run)
  .trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

describe('workflow nodes on the dshd executor', () => {
  it('a workflow node runs as one DshdExecutor unit and its final text becomes the node result', async () => {
    await start()
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const { trigger, ticket } = await acceptNode(run, 'digest')
    // One unit in the run's directory, labelled with the run and the node beside the executor's own labels.
    expect(fake.runs).toHaveLength(1)
    const [recipe] = fake.runs
    const node = h!.runtime.store.triggers.get(trigger)!.meta.node as string
    expect(recipe).toMatchObject({ cwd, profile: 'p-alpha', labels: { 'superagent.run': run, 'superagent.node': node, 'superagent.pair': 'alpha',
      'superagent.ticket': ticket.id } })
    expect(runArgv(h!)[0]).toEqual(expect.arrayContaining(['--cwd', cwd, '--label', `superagent.run=${run}`, '--label', `superagent.node=${node}`]))
    // The worker reads the prompt verbatim, after the executor's framing.
    const brief = JSON.parse(recipe!.task) as Record<string, unknown>
    expect(Object.keys(brief).at(0)).toBe('note')
    expect(Object.keys(brief).at(-1)).toBe('trigger')
    expect((brief.trigger as { text: string }).text).toBe(PROMPT)
    expect(await status(run)).toMatchObject({ state: 'running', nodes: [{ label: 'digest', state: 'ticket', ticket_id: ticket.id }] })

    const final = `# Digest, 11 November\n${'- a merged pull request\n'.repeat(250)}`
    fake.end(unitOf(ticket), { lines: runLines('session-1', final) })
    await later(h!)
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: final } })
    expect(journal(run).filter(line => line.type === 'result')).toEqual([expect.objectContaining({ result: final })])
    expect(fake.runs).toHaveLength(1)
  })

  it('a node settles as its Ticket ends, not at the next poll', async () => {
    ({ h, fake } = await startDshdHost({ rule: RULE, source: 'workflow', row: 'workflow' }))
    // The longest poll the Config allows: a node that waited for it would not settle within this test's wait.
    await mount(60_000)
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const { ticket } = await acceptNode(run, 'digest')
    fake.end(unitOf(ticket), { lines: runLines('session-1', 'Digest written') })
    await later(h!)
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: 'Digest written' } })
  })

  it('runs the three-node fixture as three units, its schema node answering with the JSON value of its final text', async () => {
    await start()
    const cwd = agency()
    writeFileSync(join(cwd, 'fixture-3.workflow.js'), readFileSync(FIXTURE, 'utf8'))
    const run = await startRun(cwd, 'fixture-3.workflow.js', { tag: 't1' })
    const a1 = await acceptNode(run, 'a1'), a2 = await acceptNode(run, 'a2')
    expect(fake.runs).toHaveLength(2)
    fake.end(unitOf(a1.ticket), { lines: runLines('session-a1', 'DONE') })
    fake.end(unitOf(a2.ticket), { lines: runLines('session-a2', 'DONE') })
    await later(h!)
    const b1 = await acceptNode(run, 'b1')
    // A schema node's text ends with the schema instruction, and that is the last thing its worker reads.
    const text = (JSON.parse(fake.runs[2]!.task) as { trigger: { text: string } }).trigger.text
    expect(text).toBe(h!.runtime.store.triggers.get(b1.trigger)!.text)
    expect(text).toMatch(new RegExp(`\\n\\n${SCHEMA_INSTRUCTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\{"type":"object"`))
    fake.end(unitOf(b1.ticket), { lines: runLines('session-b1', '{"a1": "alpha t1", "a2": "beta t1"}') })
    await later(h!)
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { a1: 'DONE', a2: 'DONE', b1: { a1: 'alpha t1', a2: 'beta t1' } } })
    expect(fake.runs.map(recipe => recipe.cwd)).toEqual([cwd, cwd, cwd])
    expect(new Set(fake.runs.map(recipe => recipe.labels['superagent.node'])).size).toBe(3)
  })

  it('gives each node the token usage its worker printed and the run the total of the nodes it measured, counting the nodes it could not', async () => {
    await start()
    const cwd = agency()
    writeFileSync(join(cwd, 'fixture-3.workflow.js'), readFileSync(FIXTURE, 'utf8'))
    const run = await startRun(cwd, 'fixture-3.workflow.js', { tag: 't1' })
    const a1 = await acceptNode(run, 'a1'), a2 = await acceptNode(run, 'a2')
    // A unit that still runs has printed no usage that counts yet.
    expect((await status(run)).usage).toEqual({ measured_nodes: 0, unmeasured_nodes: 0 })
    fake.end(unitOf(a1.ticket), { lines: runLines('session-a1', 'DONE', OPENAI) })
    fake.end(unitOf(a2.ticket), { lines: runLines('session-a2', 'DONE', [CLAUDE]) })
    await later(h!)
    const b1 = await acceptNode(run, 'b1')
    // One of b1's steps printed no usage, so its total is not known: it is counted, not guessed.
    fake.end(unitOf(b1.ticket), { lines: runLines('session-b1', '{"a1": "alpha t1", "a2": "beta t1"}', [CLAUDE, undefined]) })
    await later(h!)
    await ended(run)
    const { nodes, usage } = await status(run)
    expect(nodes.map(node => [node.label, node.usage])).toEqual([
      ['a1', { inputTokens: 3114, outputTokens: 117, totalTokens: 17363, cacheReadTokens: 14132 }], ['a2', CLAUDE], ['b1', undefined]])
    // A bucket one measured node does not report is left out of the total, as DSH leaves it out of a step's.
    expect(usage).toEqual({ total: { inputTokens: 3116, outputTokens: 356, cacheReadTokens: 46475 }, measured_nodes: 2, unmeasured_nodes: 1 })
  })

  it('sums a node\'s usage over the units of all its attempts, and shows none while a later attempt\'s unit runs', async () => {
    ({ h, fake } = await startDshdHost({ rule: RULE, source: 'workflow', row: 'workflow' }))
    await mount(5, 2)
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const first = await acceptNode(run, 'digest')
    // The first attempt's unit exits 0 with no final answer, so the interpreter tries the node again.
    fake.end(unitOf(first.ticket), { lines: runLines('session-1', undefined, OPENAI) })
    await later(h!)
    const second = await acceptNode(run, 'digest')
    expect(second.ticket.id).not.toBe(first.ticket.id)
    expect((await status(run)).nodes[0]!.usage).toBeUndefined()
    expect((await status(run)).usage).toEqual({ measured_nodes: 0, unmeasured_nodes: 0 })
    fake.end(unitOf(second.ticket), { lines: runLines('session-2', 'Digest written.', [CLAUDE]) })
    await later(h!)
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: 'Digest written.' } })
    const both = { inputTokens: 3116, outputTokens: 356, cacheReadTokens: 46475 }
    expect((await status(run)).nodes[0]!.usage).toEqual(both)
    expect((await status(run)).usage).toEqual({ total: both, measured_nodes: 1, unmeasured_nodes: 0 })
  })

  it('a restart while a node\'s unit runs adopts the unit, and the resumed run completes with no second Trigger, Ticket or unit', async () => {
    await start()
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const { trigger, ticket } = await acceptNode(run, 'digest')
    const node = h!.runtime.store.triggers.get(trigger)!.meta.node as string
    // The host stops while the unit runs; DSH mounts the plugin again on the restarted Runtime, which resumes the run.
    await unmount!(); unmount = undefined
    await h!.restart()
    await mount()
    expect((await status(run)).nodes).toEqual([expect.objectContaining({ label: 'digest', state: 'ticket', ticket_id: ticket.id })])
    fake.end(unitOf(ticket), { lines: runLines('session-1', 'Digest written.') })
    await later(h!)
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: 'Digest written.' } })
    expect(h!.runtime.store.get(BINDING(stored(ticket).assignments[0]!.id))).toMatchObject({ invocationId: 'invocation-1', ended: { verdict: 'completed' } })
    expect(stored(ticket).assignments).toHaveLength(1)
    expect(h!.runtime.store.tickets.list()).toHaveLength(1)
    expect(h!.runtime.store.triggers.get(nodeTriggerId(run, node, 2))).toBeUndefined()
    // The resumed call journals its start again under the same key, as a resume does; it is still one node.
    expect(new Set(journal(run).filter(line => line.type === 'started').map(line => line.key)).size).toBe(1)
    expect(fake.runs).toHaveLength(1)
  })

  it('a node whose unit exited 0 with no final answer returns null: the summary Unit <name> exited 0. is not a result, and the node is not retried', async () => {
    await start()
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const { ticket } = await acceptNode(run, 'digest')
    fake.end(unitOf(ticket), { lines: runLines('session-1') })
    await later(h!)
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(latestAssignment(stored(ticket))!.report!.summary).toBe(`Unit ${unitOf(ticket)} exited 0.`)
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: null } })
    expect(journal(run).filter(line => line.type === 'failed')).toEqual([expect.objectContaining({ error: 'no text output' })])
    expect(h!.runtime.store.tickets.list()).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
  })

  it('a schema node whose final text is not JSON returns null and is not retried', async () => {
    await start()
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'schema'))
    const { ticket } = await acceptNode(run, 'count')
    fake.end(unitOf(ticket), { lines: runLines('session-1', 'I counted three pull requests.') })
    await later(h!)
    // The Ticket completed with the worker's answer; only the node, which needed a JSON value, has none.
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'I counted three pull requests.' })
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: null } })
    expect(journal(run).filter(line => line.type === 'failed')).toEqual([expect.objectContaining({ error: 'no structured output' })])
    expect(fake.runs).toHaveLength(1)
  })

  it('a node whose unit exits non-zero returns null with the unit\'s ending, its Ticket waiting for a person, and is not retried', async () => {
    await start()
    const cwd = agency()
    const run = await startRun(cwd, script(cwd, 'text'))
    const { ticket } = await acceptNode(run, 'digest')
    fake.end(unitOf(ticket), { exitCode: 3, lines: runLines('session-1', 'The repository is unreachable.') })
    await later(h!)
    expect(stored(ticket).ended).toBeUndefined()
    expect(waitsForPerson(stored(ticket))).toBe(true)
    expect(await ended(run)).toMatchObject({ state: 'completed', result: { answer: null } })
    expect(journal(run).filter(line => line.type === 'failed')).toEqual([expect.objectContaining({
      error: expect.stringMatching(new RegExp(`^workflow node failed: Unit ${unitOf(ticket)} ended task-failed \\(exit 3\\)\\.`)) })])
    expect(fake.runs).toHaveLength(1)
  })
})

describe('a node\'s usage', () => {
  it('counts a Ticket two attempts of a node share once', () => {
    const usage = { inputTokens: 5, outputTokens: 1 }
    const pins = new Map<string, unknown>([[KV.workflow.ticket(nodeTriggerId('r1', 'n1', 1)), 't1'], [KV.workflow.ticket(nodeTriggerId('r1', 'n1', 2)), 't1'],
      [KV.dshd.binding('t1-a1'), { state: 'ended', usage }]])
    const ticket = { id: 't1', assignments: [{ id: 't1-a1', state: 'ended', createdAt: '', endedAt: '' }] }
    const source = { state: { get: (key: string) => pins.get(key), set: () => {} }, threads: { get: () => undefined },
      tickets: { get: (id: string) => id === 't1' ? ticket : undefined, open: () => [] },
      triggers: { get: (id: string) => id === nodeTriggerId('r1', 'n1', 3) ? undefined : { id } } }
    expect(nodeUsage(source as never, 'r1', 'n1')).toEqual(usage)
  })
})
