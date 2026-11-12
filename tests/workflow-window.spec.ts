import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Trigger } from '../src/core/index.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { FIXTURE, neverStopped, newDirectory, requeue, WORKFLOW_SETTINGS, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
const offeredLabels = (h: WorkflowHost) => h.offered().map(candidate => h.label(candidate.triggers[0]!.id))
/** Another Source kind, whose senderless Triggers the gate admits through its own admission row, as it admits workflow nodes. */
const otherKind: SourceKind = { kind: 'other', title: { zh: '其他', en: 'Other' }, description: { zh: '其他工作', en: 'Other work' },
  schema: z.object({}).strict(), fields: [], health: ['other'], scope: () => ({ listened: true, observed: true, row: 'other' }) }
const otherWork = (text: string): Trigger => ({ id: 'other:u', source: 'other', threads: [{ source: 'other', id: 'u' }],
  actor: { source: 'other', id: '' }, human: false, at: new Date().toISOString(), text, meta: { label: 'u' } })
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
async function finishRun(h: WorkflowHost, run: string) {
  await until(() => offeredLabels(h).includes('b1'))
  h.accept('b1'); h.report('b1', '{"a1": "alpha t", "a2": "beta t"}')
  await until(() => h.run(run)?.state !== 'running')
}

describe('the window of a workflow run', () => {
  it('W1 hold-and-insert with one worker slot: a1 < U < a2, a1 never stopped', async () => {
    // U is unrelated work from another Source kind, which the deployment admits as it admits workflow nodes.
    const { h, directory } = start({ slots: 1, settings: { ...WORKFLOW_SETTINGS, policy: { ...WORKFLOW_SETTINGS.policy,
      sources: { ...WORKFLOW_SETTINGS.policy.sources, other: { allowed: [], admission: { other: { unlistedUnaddressed: 'inferred' } } } } } } })
    h.sources.register(otherKind)
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    h.accept('a1')
    const a2 = h.hold('a2')
    expect(await h.receive(otherWork('Other work that should go first.'))).toBe('stored')
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
    expect(h.store.tickets.list().find(ticket => ticket.origin.triggerId === 'other:u')?.ended?.outcome).toBe('completed')
    expect(h.run(run)?.state).toBe('completed')
    neverStopped(h)
  })
  it('W2 default path: every node is accepted on its first card with no other wake', async () => {
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
  it('W2b no answer: an unavailable node waits, never null, and proceeds when requeued', async () => {
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
    expect(a1).toMatchObject({ state: 'unavailable', reason: 'Assessment timed out', decided_at: new Date(clock).toISOString() })
    expect(h.store.decisions.byThread(h.store.triggers.get(a1.trigger_id!)!.threads.map(ref => `${ref.source}:${ref.id}`)[0]!).at(-1)?.kind).toBe('unavailable')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.journal(run)).not.toContain('"type":"failed"')
    requeue(h, a1.trigger_id!)
    h.accept('a1'); h.report('a1', 'DONE'); h.report('a2', 'DONE')
    await finishRun(h, run)
    expect(h.run(run)).toMatchObject({ state: 'completed', result: { a1: 'DONE', a2: 'DONE' } })
  })
  it('W2c a held node and one whose Eval went unassessed read apart in status, health and log, and both still wait', async () => {
    let clock = Date.parse('2026-11-12T01:00:00Z')
    const { h, directory } = start({ now: () => new Date(clock).toISOString() })
    await h.started
    const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
    await until(() => h.offered().length === 2)
    const a2 = h.hold('a2')
    for (let round = 0; round < 3; round++) {
      const candidate = h.offered().find(item => h.label(item.triggers[0]!.id) === 'a1')!
      h.engine.candidateDelivered(candidate.evalId)
      clock += 121_000
      h.engine.evaluateDue()
    }
    const node = (label: string) => h.floor.status(run)[0]!.nodes.find(item => item.label === label)!
    const a1 = node('a1').trigger_id!
    expect(node('a2')).toMatchObject({ state: 'held', trigger_id: a2, reason: 'hold: a2 waits' })
    expect(node('a1')).toMatchObject({ state: 'unavailable', trigger_id: a1, reason: 'Assessment timed out' })
    // The waiting nodes' poll tells the Source's health and the log which wait on a decision and which on the main Session.
    await until(() => String(h.board.all.workflow?.detail).includes('not assessed'))
    expect(h.board.all.workflow).toMatchObject({ state: 'ready',
      detail: '1 runs under way, 2 nodes waiting for their tickets: 1 held, 1 not assessed (the main Session was unavailable)' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.logger.warn.mock.calls).toEqual([[expect.stringContaining('not assessed'), run, 'a1', 'Assessment timed out', a1]])
    expect(h.logger.info.mock.calls).toEqual([[expect.stringContaining('held'), run, 'a2', 'hold: a2 waits', a2]])
    // Neither is a failure, and nothing is offered again until a requeue.
    expect(h.journal(run)).not.toContain('"type":"failed"')
    expect(h.offered()).toHaveLength(0)
    requeue(h, a1)
    expect(node('a1').state).toBe('offered')
    await until(() => !String(h.board.all.workflow?.detail).includes('not assessed'))
    expect(h.board.all.workflow?.detail).toBe('1 runs under way, 2 nodes waiting for their tickets: 1 held')
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
  })
})
