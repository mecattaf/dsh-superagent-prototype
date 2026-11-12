import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { FIXTURE, newDirectory, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
/** No ticket was stopped: the Executor ended only Assignments whose ticket had already completed. */
const neverStopped = (h: WorkflowHost) => {
  expect(h.store.tickets.list().map(ticket => ticket.ended?.outcome)).not.toContain('stopped')
  expect(h.executor.stop.mock.calls.map(([ticket]) => (ticket as { ended?: { outcome: string } }).ended?.outcome)).toEqual(h.executor.stop.mock.calls.map(() => 'completed'))
}
const offeredLabels = (h: WorkflowHost) => h.offered().map(candidate => h.label(candidate.triggers[0]!.id))
let directories: string[] = [], hosts: WorkflowHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function start(options?: Parameters<typeof workflowHost>[1]) {
  const directory = newDirectory()
  directories.push(directory)
  const host = workflowHost(directory, options)
  hosts.push(host)
  return { h: host, directory }
}
/** Requeues a held node's Trigger, as `orchestrator_trigger_requeue` does, and runs the pass that offers it again. */
function requeue(h: WorkflowHost, trigger: string) {
  expect(h.engine.reevaluate(trigger)).toBe(true)
  h.engine.evaluateDue()
}
async function finishRun(h: WorkflowHost, run: string) {
  await until(() => offeredLabels(h).includes('b1'))
  h.accept('b1'); h.report('b1', '{"a1": "alpha t", "a2": "beta t"}')
  await until(() => h.run(run)?.state !== 'running')
}

describe('the window of a workflow run', () => {
  it('K4 a held node waits, without a null or a new Trigger, and its same Trigger proceeds once requeued', async () => {
    const { h, directory } = start()
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    h.accept('a1'); h.accept('a2'); h.report('a1', 'DONE'); h.report('a2', 'DONE')
    await until(() => offeredLabels(h).includes('b1'))
    const b1 = h.hold('b1')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.run(run)?.state).toBe('running')
    expect(h.journal(run)).not.toContain('"type":"failed"')
    expect(h.floor.status(run)[0]!.nodes.find(node => node.label === 'b1')).toMatchObject({ state: 'held', trigger_id: b1 })
    requeue(h, b1)
    expect(h.floor.status(run)[0]!.nodes.find(node => node.label === 'b1')?.state).toBe('offered')
    await finishRun(h, run)
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { b1: { a1: 'alpha t', a2: 'beta t' } } })
    expect(h.receive.mock.calls.map(([item]) => (item as Trigger).id).filter(id => id === b1)).toHaveLength(1)
    neverStopped(h)
  })
  it('W1 holds a node so other work goes first on one worker slot: a1, then the other work, then a2, and a1 is never stopped', async () => {
    const { h, directory } = start({ slots: 1 })
    await h.started
    const other = join(directory, 'other.workflow.js')
    writeFileSync(other, "export const meta = { name: 'other', description: 'One node of other work' }\nreturn await agent('Other work.', { label: 'u' })\n")
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    h.accept('a1')
    const a2 = h.hold('a2')
    const { run_id: unrelated } = h.floor.startRun({ script: other, cwd: directory })
    await until(() => offeredLabels(h).includes('u'))
    h.accept('u')
    h.report('a1', 'DONE')
    requeue(h, a2)
    h.accept('a2')
    h.report('u', 'done')
    h.report('a2', 'DONE')
    await finishRun(h, run)
    const launched = h.launches.map(ticket => h.label(h.store.tickets.get(ticket)!.origin.triggerId))
    expect(launched).toEqual(['a1', 'u', 'a2', 'b1'])
    expect(h.run(unrelated)).toMatchObject({ state: 'completed', result: 'done' })
    expect(h.run(run)?.state).toBe('completed')
    neverStopped(h)
  })
  it('W2 the default path: every node is accepted on its first candidate, with no hold or requeue', async () => {
    const { h, directory } = start()
    await h.started
    const reevaluate = vi.spyOn(h.engine, 'reevaluate')
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    for (const label of offeredLabels(h)) h.accept(String(label))
    h.report('a1', 'DONE'); h.report('a2', 'DONE')
    await finishRun(h, run)
    expect(h.run(run)?.state).toBe('completed')
    expect(h.candidates).toHaveLength(3)
    expect(h.store.tickets.list()).toHaveLength(3)
    expect(reevaluate).not.toHaveBeenCalled()
    expect(h.launches.map(ticket => h.label(h.store.tickets.get(ticket)!.origin.triggerId))).toEqual(['a1', 'a2', 'b1'])
  })
  it('W2b a node whose Eval nobody answers waits as held, never null, and proceeds once requeued', async () => {
    let clock = Date.parse('2026-11-12T01:00:00Z')
    const { h, directory } = start({ now: () => new Date(clock).toISOString() })
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    h.accept('a2')
    // Each Eval of a1 reaches the main Session and expires; after two requeues it is recorded unavailable.
    for (let round = 0; round < 3; round++) {
      const candidate = h.offered().find(item => h.label(item.triggers[0]!.id) === 'a1')!
      h.engine.candidateDelivered(candidate.evalId)
      clock += 121_000
      h.engine.evaluateDue()
    }
    const a1 = h.floor.status(run)[0]!.nodes.find(node => node.label === 'a1')!
    expect(a1.state).toBe('held')
    expect(h.store.decisions.byThread(h.store.triggers.get(a1.trigger_id!)!.threads.map(ref => `${ref.source}:${ref.id}`)[0]!).at(-1)?.kind).toBe('unavailable')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.journal(run)).not.toContain('"type":"failed"')
    requeue(h, a1.trigger_id!)
    h.accept('a1'); h.report('a1', 'DONE'); h.report('a2', 'DONE')
    await finishRun(h, run)
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { a1: 'DONE', a2: 'DONE' } })
  })
})
