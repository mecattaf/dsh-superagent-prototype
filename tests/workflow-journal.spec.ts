import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KvJournal, type WorkflowRun } from '../src/sources/workflow-store.ts'
import { MemoryJournal, MockBackend, parseJournal, runWorkflow } from '../src/workflow/index.ts'
import { FIXTURE, newDirectory } from './fixtures/workflow.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
/** The workflow Source's view of a Store, as a SourceContext gives it. */
function context(store: Store) {
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
  return sourceContextOf({ store, sources } as unknown as SourceContextDeps, { kind: 'workflow', health: [] })
}
const counter = () => { let n = 0; return () => `a${String(++n).padStart(16, '0')}` }
const backend = () => new MockBackend({ turns: () => 0 })

it('KvJournal lines read back after reopening the Store parse equal to a MemoryJournal of the same run', async () => {
  const directory = newDirectory(); directories.push(directory)
  const path = join(directory, 'orchestrator.sqlite')
  const source = readFileSync(FIXTURE, 'utf8')
  let store = new Store(path)
  const run: WorkflowRun = { id: 'wf-1', name: 'fixture-3', scriptPath: FIXTURE, scriptSha256: '', cwd: directory, state: 'running', startedAt: '', seq: 0 }
  context(store).state.set(KV.workflow.run(run.id), run)
  await runWorkflow(source, { backend: backend(), runId: run.id, args: { tag: 't' }, journal: new KvJournal(context(store), run.id), newAgentId: counter() })
  const memory = new MemoryJournal()
  await runWorkflow(source, { backend: backend(), runId: run.id, args: { tag: 't' }, journal: memory, newAgentId: counter() })
  store.close()
  store = new Store(path)
  const loaded = KvJournal.load(context(store), run.id)
  expect(loaded).toEqual(parseJournal(memory.text()))
  expect(context(store).state.get(KV.workflow.run(run.id))?.seq).toBe(memory.events.length)
  // Another run's lines are its own.
  expect(KvJournal.text(context(store), 'wf-10')).toBe('')
  store.close()
})
it('KvJournal reads no line of another run whose id begins with the same characters', () => {
  const directory = newDirectory(); directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (const id of ['wf-1', 'wf-10']) {
    context(store).state.set(KV.workflow.run(id), { id, name: 'n', scriptPath: '/s.js', scriptSha256: '', cwd: directory, state: 'running', startedAt: '', seq: 0 })
    new KvJournal(context(store), id).append({ type: 'launched' })
  }
  expect(KvJournal.text(context(store), 'wf-1')).toBe('{"type":"launched"}\n')
  store.close()
})
it('KvJournal writes nothing once its signal aborted', () => {
  const directory = newDirectory(); directories.push(directory)
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const run: WorkflowRun = { id: 'wf-2', name: 'n', scriptPath: '/s.js', scriptSha256: '', cwd: directory, state: 'running', startedAt: '', seq: 0 }
  context(store).state.set(KV.workflow.run(run.id), run)
  const stopped = new AbortController()
  const journal = new KvJournal(context(store), run.id, stopped.signal)
  journal.append({ type: 'launched' })
  stopped.abort()
  journal.append({ type: 'launched' })
  expect(KvJournal.text(context(store), run.id)).toBe('{"type":"launched"}\n')
  store.close()
})
