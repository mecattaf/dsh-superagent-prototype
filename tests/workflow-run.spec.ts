import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { threadKey, type Trigger } from '../src/core/index.ts'
import { NODE_FAILURE, settle, TicketBackend, TicketWaiter } from '../src/sources/workflow-backend.ts'
import { nodeOf } from '../src/sources/workflow-trigger.ts'
import { FIXTURE, neverStopped, newDirectory, requeue, WORKFLOW_SETTINGS, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

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
  it('W0 three-node fixture completes with exactly three Triggers', async () => {
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
    expect(h.store.threads.get(threadKey(trigger.threads[0]!))?.meta).toMatchObject({ label: 'fixture-3 · a1', facts: { run: { value: run } } })
    expect(h.floor.status(run)[0]!.nodes.map(node => [node.label, node.state])).toEqual([['a1', 'done'], ['a2', 'done'], ['b1', 'done']])
  })
  it('K1 floor killed while b1 runs: no new Trigger, Ticket or launch after restart', async () => {
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
  it('K2 killed after a2\'s result line and before b1 is offered: b1 offered once', async () => {
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
  it('K3 killed after b1\'s Ticket ended and before its result line: b1 settles from the Ticket', async () => {
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
  it('K4 a held node waits and the same Trigger proceeds once requeued', async () => {
    const { host: h, directory } = start()
    const run = await firstWave(h, directory)
    const b1 = h.hold('b1')
    // Five polls later the node still waits: holding it is no failure and raises nothing new.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.run(run)?.state).toBe('running')
    expect(h.journal(run)).not.toContain('"type":"failed"')
    expect(h.floor.status(run)[0]!.nodes.find(node => node.label === 'b1')).toMatchObject({ state: 'held', trigger_id: b1 })
    requeue(h, b1)
    expect(h.floor.status(run)[0]!.nodes.find(node => node.label === 'b1')?.state).toBe('offered')
    h.accept('b1'); h.report('b1', B1)
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: RESULT })
    expect(h.receive.mock.calls.map(([item]) => (item as Trigger).id).filter(id => id === b1)).toHaveLength(1)
    neverStopped(h)
  })
  it('K5 a node whose unit fails returns null and is not retried', async () => {
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
    // Status traces the node's latest attempt, not the Ticket of the one before.
    expect(h.floor.status(run)[0]!.nodes.find(node => node.label === 'b1')).toMatchObject({ state: 'offered', trigger_id: second!.id })
    h.accept('b1'); h.report('b1', B1)
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: RESULT })
    expect(h.store.tickets.list()).toHaveLength(4)
  })
  it('K6 a failed node is replayed as null on resume, never re-dispatched', async () => {
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
  it('a node failure worded like a retryable one is still replayed as null on resume', async () => {
    const { host: h1, directory } = start()
    await h1.started
    const { run_id: run } = h1.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h1.offered().length === 2)
    // "refused" is a word the interpreter retries on resume; a node's own failure is never one of those.
    h1.accept('a1'); h1.accept('a2'); h1.report('a1', 'the connection was refused', 'failed')
    await until(() => lines(h1, run).some(line => line.type === 'failed'))
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 1)
    h2.report('a2', 'DONE')
    await until(() => h2.offered().length === 1)
    h2.accept('b1'); h2.report('b1', B1)
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: { a1: null } })
    expect(received(h2).map(([label]) => label)).toEqual(['a2', 'b1'])
  })
  it('a resumed run answers every finished node from the journal, whatever order the nodes finished in', async () => {
    const { host: h1, directory } = start()
    await h1.started
    const script = join(directory, 'reorder.workflow.js')
    writeFileSync(script, `export const meta = { name: 'reorder', description: 'Two items through two stages' }
return await pipeline(['x', 'y'], item => agent('stage1 ' + item, { label: 's1:' + item }), (r, item) => agent('stage2 of ' + item + ' got ' + r, { label: 's2:' + item }))\n`)
    const { run_id: run } = h1.floor.startRun({ script, cwd: directory })
    await until(() => h1.offered().length === 2)
    // The second item finishes both stages before the first item finishes its first.
    h1.accept('s1:x'); h1.accept('s1:y'); h1.report('s1:y', 'Y')
    await until(() => h1.offered().length === 1)
    h1.accept('s2:y'); h1.report('s2:y', 'Y2'); h1.report('s1:x', 'X')
    await until(() => h1.offered().length === 1)
    h1.accept('s2:x')
    await h1.stop()
    const { host: h2 } = start(directory)
    await until(() => h2.receive.mock.calls.length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(received(h2)).toEqual([['s2:x', 'duplicate']])
    h2.report('s2:x', 'X2')
    await until(() => h2.run(run)?.state !== 'running')
    expect(h2.run(run)).toMatchObject({ state: 'completed', result: ['X2', 'Y2'] })
    expect(received(h2)).toEqual([['s2:x', 'duplicate']])
  })
  it('a restart drives no run that already ended: no Trigger, no journal line and no second end', async () => {
    const { host: h1, directory } = start()
    const run = await firstWave(h1, directory)
    h1.accept('b1'); h1.report('b1', B1)
    await until(() => h1.run(run)?.state !== 'running')
    const ended = h1.run(run), journal = h1.journal(run)
    await h1.stop()
    const { host: h2 } = start(directory)
    await h2.started
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h2.floor.active).toBe(0)
    expect(h2.receive).not.toHaveBeenCalled()
    expect(h2.journal(run)).toBe(journal)
    expect(h2.run(run)).toEqual(ended)
  })
  it('two identical agent() calls are two nodes, each with its own Trigger, Thread and status row', async () => {
    const { host: h, directory } = start()
    await h.started
    const script = join(directory, 'twins.workflow.js')
    writeFileSync(script, `export const meta = { name: 'twins', description: 'Two identical calls' }
return await parallel([() => agent('Same work.', { label: 'twin' }), () => agent('Same work.', { label: 'twin' })])\n`)
    const { run_id: run } = h.floor.startRun({ script, cwd: directory })
    await until(() => h.offered().length === 2)
    const triggers = h.receive.mock.calls.map(([item]) => item as Trigger)
    expect(triggers.map(item => item.meta.node)).toEqual([expect.stringMatching(/-o1$/), expect.stringMatching(/-o2$/)])
    expect(new Set(triggers.map(item => item.threads[0]!.id)).size).toBe(2)
    h.accept('twin'); h.accept('twin'); h.report('twin', 'one'); h.report('twin', 'two')
    await until(() => h.run(run)?.state !== 'running')
    expect([...h.run(run)?.result as string[]].sort()).toEqual(['one', 'two'])
    expect(h.floor.status(run)[0]!.nodes.map(node => [node.node, node.trigger_id, node.state])).toEqual(triggers.map(item => [item.meta.node, item.id, 'done']))
  })
  it('a node the Source filters returns null, and so does one whose Trigger was filtered before a restart', async () => {
    // The workflow Source is installed but off, so the Engine takes its Triggers in as filtered and gives them no Thread.
    const off = { ...WORKFLOW_SETTINGS, sources: { workflow: { enabled: false } } }
    const { host: h, directory } = start(undefined, { settings: off })
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.run(run)?.state !== 'running')
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { a1: null, a2: null, b1: null } })
    expect(lines(h, run).filter(line => line.type === 'failed').map(line => String(line.error))).toEqual(Array(3).fill(expect.stringMatching(/^workflow node filtered: /)))
    // The process dies as the first node is filtered: a resume raises that Trigger again, which the Engine answers duplicate.
    const { host: h1, directory: other } = start(undefined, { settings: off })
    await h1.started
    const take = h1.receive.getMockImplementation()!
    h1.receive.mockImplementation(trigger => { void take(trigger); h1.floor.stop(); return new Promise<never>(() => {}) })
    const { run_id: killed } = h1.floor.startRun({ script: FIXTURE, cwd: other, args: { tag: 't' } })
    await until(() => h1.receive.mock.calls.length >= 1)
    await h1.stop()
    const { host: h2 } = start(other)
    await until(() => h2.run(killed)?.state !== 'running')
    expect(received(h2)[0]).toEqual(['a1', 'duplicate'])
    expect(h2.run(killed)).toMatchObject({ state: 'completed', result: { a1: null, a2: null, b1: null } })
  })
})
describe('the parts of a node', () => {
  const call = { cid: `c1:${'ab'.repeat(32)}#1`, occurrence: 1, attempt: 1, prompt: 'Work.', opts: {} }
  const done = { id: 'ticket-1', origin: { triggerIds: ['wf:r:n-a1'] }, assignments: [{ report: { state: 'ready', summary: 'done' } }], ended: { outcome: 'completed' } }
  it('a call without a content identity has no node name', () => {
    expect(nodeOf(call)).toBe('abababababababab-o1')
    expect(() => nodeOf({ ...call, cid: undefined })).toThrow('without a content identity')
  })
  it('settle answers a blocked or failed report as a failure capped at 500 characters, and a completed Ticket with no ready report as no result', () => {
    const ticket = (report?: { state: string; summary: string }, ended?: { outcome: string }) =>
      ({ id: 'ticket-1', assignments: [{ ...report && { report } }], ...ended && { ended } }) as never
    expect(settle(ticket({ state: 'progress', summary: 'half way' }), false)).toBeUndefined()
    expect(settle(ticket({ state: 'blocked', summary: 'needs a key' }), false)).toEqual({ error: `${NODE_FAILURE}blocked: needs a key`, agentId: 'ticket-1' })
    expect(settle(ticket({ state: 'failed', summary: 'x'.repeat(800) }), false)!.error).toBe(`${NODE_FAILURE}failed: ${'x'.repeat(500)}`)
    expect(settle(ticket({ state: 'progress', summary: 'half way' }, { outcome: 'completed' }), false)).toEqual({ error: `${NODE_FAILURE}completed: half way`, agentId: 'ticket-1' })
  })
  it('TicketWaiter answers a node whose Ticket already ended at once, and once stopped answers nothing, asked before or after the stop', async () => {
    let ticket: unknown = done
    const source = { threads: { get: () => ({ subscriptions: ['ticket-1'] }) }, tickets: { get: () => ticket } } as never
    const first = new TicketWaiter(source, () => 60_000)
    expect(await Promise.race([first.settled('wf:r:n-a1', 'workflow:r:n', false), Promise.resolve('later')])).toEqual({ text: 'done', agentId: 'ticket-1' })
    first.stop()
    ticket = undefined
    const waiter = new TicketWaiter(source, () => 1)
    let answered = 0
    void waiter.settled('wf:r:n-a1', 'workflow:r:n', false).then(() => { answered++ })
    waiter.stop()
    void waiter.settled('wf:r:n-a1', 'workflow:r:n', false).then(() => { answered++ })
    ticket = done
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(answered).toBe(0)
    expect(waiter.size).toBe(0)
  })
  it('a TicketBackend whose Source stopped raises no Trigger: the call parks', async () => {
    const receive = vi.fn()
    const run = { id: 'wf-r', name: 'n', scriptPath: '/s.js', scriptSha256: '', cwd: '/', state: 'running' as const, startedAt: '', seq: 0 }
    const waiter = new TicketWaiter({ threads: { get: () => undefined }, tickets: { get: () => undefined } } as never, () => 1)
    const backend = new TicketBackend({ source: { receive } as never, run, waiter, signal: AbortSignal.abort() })
    let answered = false
    void backend.run(call as never).then(() => { answered = true }, () => { answered = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(receive).not.toHaveBeenCalled()
    expect(answered).toBe(false)
    waiter.stop()
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
