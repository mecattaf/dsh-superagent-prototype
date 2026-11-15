import { readFileSync, rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { parseJournal, runWorkflow } from '../src/workflow/index.ts'
import { FIXTURE, newDirectory, workflowHost, type WorkflowHost } from './fixtures/workflow.ts'

const until = (check: () => unknown) => vi.waitFor(() => { if (!check()) throw new Error('not yet') }, { timeout: 3000, interval: 5 })
let directories: string[] = [], hosts: WorkflowHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop().catch(() => {})
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function start() {
  const directory = newDirectory()
  directories.push(directory)
  const host = workflowHost(directory)
  hosts.push(host)
  return { h: host, directory }
}

it('the exported fixture journal replays with zero dispatch', async () => {
  const { h, directory } = start()
  await h.started
  const { run_id: run } = h.floor.startRun({ script: FIXTURE, cwd: directory, args: { tag: 't' } })
  await until(() => h.offered().length === 2)
  h.accept('a1'); h.accept('a2'); h.report('a1', 'DONE'); h.report('a2', 'DONE')
  await until(() => h.offered().length === 1)
  h.accept('b1'); h.report('b1', '{"a1": "alpha t", "a2": "beta t"}')
  await until(() => h.run(run)?.state !== 'running')
  const dispatched = vi.fn(async () => { throw new Error('dispatched') })
  const replayed = await runWorkflow(readFileSync(FIXTURE, 'utf8'), { backend: { name: 'refusing', run: dispatched }, args: { tag: 't' },
    resumeFrom: parseJournal(h.journal(run)), cacheIdentity: 'content' })
  expect(replayed.status).toBe('completed')
  expect(replayed.result).toEqual(h.run(run)!.result)
  expect(replayed.calls.map(call => call.state)).toEqual(['cached', 'cached', 'cached'])
  expect(dispatched).not.toHaveBeenCalled()
})
/**
 * A journal exported from a live run, one JSON line per record: `REPLAY_JOURNAL` names its file, `REPLAY_SCRIPT` the script it
 * ran (the fixture unless set) and `REPLAY_ARGS` the run's arguments as JSON, which the content identity of each call depends on.
 */
const live = process.env.REPLAY_JOURNAL
it.skipIf(!live)('an exported live journal replays with zero dispatch', async () => {
  const dispatched = vi.fn(async () => { throw new Error('dispatched') })
  const args: unknown = process.env.REPLAY_ARGS ? JSON.parse(process.env.REPLAY_ARGS) : undefined
  const replayed = await runWorkflow(readFileSync(process.env.REPLAY_SCRIPT || FIXTURE, 'utf8'), { backend: { name: 'refusing', run: dispatched },
    ...args !== undefined && { args }, resumeFrom: parseJournal(readFileSync(live!, 'utf8')), cacheIdentity: 'content', resumeFailures: 'replay' })
  expect(replayed.status).toBe('completed')
  expect(replayed.calls.map(call => call.state).filter(state => state !== 'cached')).toEqual([])
  expect(dispatched).not.toHaveBeenCalled()
})
