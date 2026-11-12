import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { FIXTURE, newDirectory, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const B1 = '{"a1": "alpha t", "a2": "beta t"}'
const RESULT = { a1: 'DONE', a2: 'DONE', b1: { a1: 'alpha t', a2: 'beta t' } }
const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
const lines = (h: WorkflowHost, run: string) => h.journal(run).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
/** The labels of the nodes a host raised, with what the Engine answered each. */
const received = (h: WorkflowHost) => h.receive.mock.calls.map(([trigger], index) => [(trigger as Trigger).meta.label, h.receive.mock.results[index]!.value])

let directories: string[] = [], hosts: WorkflowHost[] = []
function start(directory = newDirectory(), options?: Parameters<typeof workflowHost>[1]) {
  if (!directories.includes(directory)) directories.push(directory)
  const host = workflowHost(directory, options)
  hosts.push(host)
  return { host, directory }
}
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
/** Starts the fixture and runs its first wave to both results, leaving b1 offered. */
async function firstWave(h: WorkflowHost, cwd: string) {
  await h.started
  const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd, args: { tag: 't' } })
  await until(() => h.offered().length === 2)
  h.accept('a1'); h.accept('a2')
  h.report('a1', 'DONE'); h.report('a2', 'DONE')
  await until(() => h.offered().some(candidate => h.label(candidate.triggers[0]!.id) === 'b1'))
  return run
}

describe('workflow runs', () => {
  it('W0 runs the three-node fixture with exactly three Triggers, offering b1 only once both results of the first wave are journaled', async () => {
    const { host: h, directory } = start()
    const run = await firstWave(h, directory)
    const journal = lines(h, run)
    const b1 = journal.findIndex(line => line.type === 'started' && line.label === 'b1')
    expect(journal.slice(0, b1).filter(line => line.type === 'result')).toHaveLength(2)
    h.accept('b1'); h.report('b1', B1)
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: RESULT })
    expect(received(h)).toEqual([['a1', 'stored'], ['a2', 'stored'], ['b1', 'stored']])
    expect(h.executor.start).toHaveBeenCalledTimes(3)
    expect(h.store.tickets.list().map(ticket => ticket.assignments.length)).toEqual([1, 1, 1])
    // Each node tells the Executor its directory and labels, and runs on its own Thread.
    const trigger = h.receive.mock.calls[0]![0] as Trigger
    expect(trigger.meta).toMatchObject({ kind: 'workflow-node', run, cwd: directory, labels: { 'superagent.run': run } })
    expect(new Set(h.receive.mock.calls.map(([item]) => (item as Trigger).threads[0]!.id)).size).toBe(3)
    expect(h.floor.status(run)[0]!.nodes.map(node => [node.label, node.state])).toEqual([['a1', 'done'], ['a2', 'done'], ['b1', 'done']])
  })
  it('K1 restarts while b1 runs: no new Trigger, Ticket or launch, and ending b1 completes the run', async () => {
    const { host: h1, directory } = start()
    const run = await firstWave(h1, directory)
    h1.accept('b1')
    expect(h1.executor.start).toHaveBeenCalledTimes(3)
    await h1.stop()
    const { host: h2 } = start(directory)
    await h2.started
    await until(() => h2.receive.mock.calls.length === 1)
    // a1 and a2 answer from the journal; b1 raises its own Trigger again, which the Engine already has.
    expect(received(h2)).toEqual([['b1', 'duplicate']])
    expect(h2.store.tickets.list()).toHaveLength(3)
    h2.report('b1', B1)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: RESULT })
    expect(h2.executor.start).not.toHaveBeenCalled()
  })
  it('K2 restarts after the result of a2 and before b1 was taken in: b1 is offered once', async () => {
    const { host: h1, directory } = start()
    await h1.started
    const take = h1.receive.getMockImplementation()!
    // The process dies as b1's Trigger is on its way to the Engine.
    h1.receive.mockImplementation(trigger => trigger.meta.label === 'b1' ? (h1.floor.stop(), new Promise<never>(() => {})) : take(trigger))
    const { run_id: run } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    h1.accept('a1'); h1.accept('a2'); h1.report('a1', 'DONE'); h1.report('a2', 'DONE')
    await until(() => received(h1).length === 3)
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.offered().length === 1)
    expect(received(h2)).toEqual([['b1', 'stored']])
    const ids = [...h1.receive.mock.calls, ...h2.receive.mock.calls].map(([item]) => item as Trigger).filter(item => item.meta.label === 'b1').map(item => item.id)
    expect(new Set(ids).size).toBe(1)
    h2.accept('b1'); h2.report('b1', B1)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: RESULT })
  })
  it('K3 restarts after b1\'s Ticket ended and before its result was journaled: b1 settles from its Ticket', async () => {
    const { host: h1, directory } = start()
    const run = await firstWave(h1, directory)
    h1.accept('b1')
    h1.floor.stop()
    h1.report('b1', B1)
    expect(lines(h1, run).filter(line => line.type === 'result')).toHaveLength(2)
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.run(run)?.state !== 'running')
    expect(received(h2)).toEqual([['b1', 'duplicate']])
    expect(h2.executor.start).not.toHaveBeenCalled()
    expect(lines(h2, run).filter(line => line.type === 'result')).toHaveLength(3)
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: RESULT })
  })
  it('K5 a node whose ticket fails returns null once and is not tried again', async () => {
    const { host: h, directory } = start()
    const run = await firstWave(h, directory)
    h.accept('b1'); h.report('b1', 'the files were missing', 'failed')
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { a1: 'DONE', a2: 'DONE', b1: null } })
    expect(lines(h, run).find(line => line.type === 'failed')).toMatchObject({ error: 'workflow node failed: the files were missing' })
    expect(received(h)).toHaveLength(3)
  })
  it('offers a node again as its next attempt, on the same Thread, when its reply misses its schema and maxAttempts allows', async () => {
    const { host: h, directory } = start(undefined, { config: { maxAttempts: 2 } })
    const run = await firstWave(h, directory)
    h.accept('b1'); h.report('b1', 'Both files say alpha and beta.')
    await until(() => h.offered().length === 1)
    const [first, second] = h.receive.mock.calls.slice(2).map(([item]) => item as Trigger)
    expect([first!.meta.attempt, second!.meta.attempt]).toEqual([1, 2])
    expect(second!.threads).toEqual(first!.threads)
    h.accept('b1'); h.report('b1', B1)
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: RESULT })
    expect(h.store.tickets.list()).toHaveLength(4)
  })
  it('K6 a failed node is replayed as null on resume, never raised again', async () => {
    const { host: h1, directory } = start()
    await h1.started
    const { run_id: run } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    h1.accept('a1'); h1.accept('a2'); h1.report('a1', 'no disk', 'failed')
    await until(() => lines(h1, run).some(line => line.type === 'failed'))
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 1)
    expect(received(h2)).toEqual([['a2', 'duplicate']])
    h2.report('a2', 'DONE')
    await until(() => h2.offered().length === 1)
    h2.accept('b1'); h2.report('b1', B1)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: { a1: null, a2: 'DONE', b1: { a1: 'alpha t', a2: 'beta t' } } })
    expect(received(h2).map(([label]) => label)).toEqual(['a2', 'b1'])
  })
})
describe('node results', () => {
  it('a node\'s result is its Ticket\'s summary verbatim, and a node with a schema parses it from one code fence at most', async () => {
    const { host: h, directory } = start()
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    h.accept('a1'); h.accept('a2')
    h.report('a1', '  DONE\n\nThe file holds alpha t.  '); h.report('a2', 'DONE')
    await until(() => h.offered().length === 1)
    h.accept('b1'); h.report('b1', `\`\`\`json\n${B1}\n\`\`\``)
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { ...RESULT, a1: '  DONE\n\nThe file holds alpha t.  ' } })
  })
  it('a node whose unit exited 0 without a final answer returns null, journaled, and a resume replays the null', async () => {
    const { host: h1, directory } = start()
    await h1.started
    const { run_id: run } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    h1.accept('a1'); h1.accept('a2')
    h1.report('a1', 'Unit sa-node-a1-a1 exited 0.')
    await until(() => lines(h1, run).some(line => line.type === 'failed'))
    expect(lines(h1, run).find(line => line.type === 'failed')).toMatchObject({ error: 'no text output' })
    expect(h1.floor.status(run)[0]!.nodes.find(node => node.label === 'a1')).toMatchObject({ state: 'null', ticket_id: expect.any(String) })
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 1)
    expect(received(h2)).toEqual([['a2', 'duplicate']])
    h2.report('a2', 'DONE')
    await until(() => h2.offered().length === 1)
    h2.accept('b1'); h2.report('b1', 'Unit sa-node-b1-a1 exited 0.')
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: { a1: null, a2: 'DONE', b1: null } })
    expect(lines(h2, run).filter(line => line.type === 'failed').map(line => line.error)).toEqual(['no text output', 'no structured output'])
    expect(received(h2).map(([label]) => label)).toEqual(['a2', 'b1'])
  })
  it('a node with a schema whose reply is no JSON value returns null, journaled, with no second Trigger', async () => {
    const { host: h, directory } = start()
    const run = await firstWave(h, directory)
    h.accept('b1'); h.report('b1', 'Both files say alpha and beta.')
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { a1: 'DONE', a2: 'DONE', b1: null } })
    expect(lines(h, run).find(line => line.type === 'failed')).toMatchObject({ error: 'no structured output' })
    expect(received(h)).toHaveLength(3)
  })
})
