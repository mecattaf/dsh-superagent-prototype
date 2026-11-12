/**
 * The workflow Source on a real Store and Engine in a directory that outlives one host, so a test can stop a host and start
 * another on the same Store as a restart does. The main Session is the test, which decides each candidate; the Executor is a
 * stand-in that launches Assignments oldest first on a number of slots, and that the test ends by reporting.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { Engine, type Assignment, type Candidate, type ReceiveResult, type Ticket, type Trigger } from '../../src/core/index.ts'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { Store } from '../../src/app/store.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { KV } from '../../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { workflowKind } from '../../src/sources/workflow.ts'
import { WorkflowFloor, type FloorConfig } from '../../src/sources/workflow-floor.ts'
import { KvJournal } from '../../src/sources/workflow-store.ts'
import { testDeployment } from './deployment.ts'

export const FIXTURE = join(import.meta.dirname, 'fixture-3.workflow.js')
/** The settings a deployment seeds for workflow nodes: accept mode auto, the rule nodes are accepted under, and the admission row. */
export const WORKFLOW_SETTINGS = {
  eval: { mode: 'auto' },
  policy: { rules: [{ id: 'workflow-node', name: 'Workflow node', enabled: true, instruction: 'A workflow node proceeds by default.' }],
    sources: { workflow: { allowed: [], admission: { workflow: { unlistedUnaddressed: 'inferred' } } } } },
}
export const newDirectory = (): string => mkdtempSync(join(tmpdir(), 'workflow-'))

/**
 * One process's worth of the workflow Source on the Store in `directory`, with `slots` workers. `settings` replaces the seeded
 * settings of a new Store, and `config` the Source's machine settings, polling every 5 ms unless it names its own `pollMs`.
 */
export function workflowHost(directory: string, options: { slots?: number; config?: Partial<FloorConfig>; now?: () => string; settings?: unknown } = {}) {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  if (store.get(KV.settings.revision) === undefined) store.saveSettings(SettingsSchema.parse(options.settings ?? WORKFLOW_SETTINGS))
  const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
  const candidates: Candidate[] = []
  const launches: string[] = [], pending: { ticket: string; assignment: string }[] = [], running = new Set<string>()
  type Call = (ticket: Ticket, assignment: Assignment) => void
  const executor = { start: vi.fn<Call>((ticket, assignment) => { pending.push({ ticket: ticket.id, assignment: assignment.id }) }),
    deliver: vi.fn<Call>(), stop: vi.fn<(ticket: Ticket, assignment: Assignment, reason: string) => void>() }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: candidate => { candidates.push(candidate) } }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    ...options.now && { now: options.now } })
  // The assessment of an Eval an earlier host started reaches this main Session again, as the durable assessment effect does.
  for (const thread of store.threads.active()) {
    const candidate = thread.evaluating && engine.candidate(thread.evaluating.primary ?? thread.evaluating.triggerIds[0]!)
    if (candidate) candidates.push(candidate)
  }
  const slots = options.slots ?? 16
  /** Launches what waits, oldest first, while a slot is free. */
  const launch = () => {
    while (running.size < slots && pending.length) {
      const next = pending.shift()!
      running.add(next.ticket); launches.push(next.ticket)
      engine.assignmentStarted(next.ticket, next.assignment)
    }
  }
  const receive = vi.fn<(trigger: Trigger) => ReceiveResult | Promise<ReceiveResult>>(trigger => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands: new Commands(() => testDeployment(), {}, new AbortController().signal),
    sources, deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive }
  const host = { sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(deps, kind) }
  // The Ticket waiter reads pollMs each time it schedules a poll, so counting the reads counts the polls it scheduled.
  let polls = 0
  const floor = new WorkflowFloor(host, { pollMs: { get: () => { polls += 1; return 5 } }, concurrency: 16, maxAttempts: 1, pair: '', ...options.config })
  const unregister = sources.register(workflowKind(floor))
  const started = floor.start()

  /** The candidates whose Eval waits for a decision, oldest first. */
  const offered = () => candidates.filter(candidate => store.threads.get(candidate.thread.key)?.evaluating?.id === candidate.evalId)
  const label = (trigger: string) => store.triggers.get(trigger)?.meta.label
  /** Accepts the candidate of the node labelled `node`, as the main Session would, and launches what a slot allows. */
  function accept(node: string): Ticket {
    const candidate = offered().find(item => label(item.triggers[0]!.id) === node)
    if (!candidate) throw new Error(`No candidate for ${node}`)
    const decision = engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: `Node ${node}`, scope: `Node ${node}`, reason: 'workflow node',
      rules: ['workflow-node'], name: `node-${node}` })
    launch()
    return store.tickets.get(decision.ticketId!)!
  }
  /** Holds the node labelled `node`: its candidate is ignored with a reason that starts with `hold:`. */
  function hold(node: string): string {
    const candidate = offered().find(item => label(item.triggers[0]!.id) === node)
    if (!candidate) throw new Error(`No candidate for ${node}`)
    engine.decide(candidate.triggers[0]!.id, { kind: 'ignore', reason: `hold: ${node} waits` })
    return candidate.triggers[0]!.id
  }
  /** Ends the running Ticket of the node labelled `node` with a report, freeing its slot. */
  function report(node: string, summary: string, state: 'ready' | 'failed' = 'ready'): Ticket {
    const ticket = store.tickets.list().find(item => label(item.origin.triggerId) === node && !item.ended)
    if (!ticket) throw new Error(`No open ticket for ${node}`)
    const ended = engine.report(ticket.id, { state, summary })
    running.delete(ticket.id)
    launch()
    return ended
  }
  /** Stops this host as a killed process would leave the Store: the floor parks its calls and the Store closes. */
  async function stop() {
    unregister(); floor.stop(); await started; store.close()
  }
  const context = host.context({ kind: 'workflow', health: ['workflow'] })
  const run = (id: string) => store.get(KV.workflow.run(id))
  const journal = (id: string) => KvJournal.text(context, id)
  return { store, engine, sources, floor, executor, receive, candidates, offered, accept, hold, report, launch, launches, stop, run, journal,
    context, label, started, polls: () => polls }
}
export type WorkflowHost = ReturnType<typeof workflowHost>
/** Requeues a held node's Trigger, as `orchestrator_trigger_requeue` does, and runs the pass that offers it again. */
export function requeue(h: WorkflowHost, trigger: string): void {
  expect(h.engine.reevaluate(trigger)).toBe(true)
  h.engine.evaluateDue()
}
/**
 * No Ticket was stopped. The Engine asks the Executor to stop the Assignments of every Ticket that ends, a completed one too,
 * so each `stop` call must be for a Ticket that had already completed.
 */
export function neverStopped(h: WorkflowHost): void {
  expect(h.store.tickets.list().map(ticket => ticket.ended?.outcome)).not.toContain('stopped')
  expect(h.executor.stop.mock.calls.map(([ticket]) => ticket.ended?.outcome)).toEqual(h.executor.stop.mock.calls.map(() => 'completed'))
}
