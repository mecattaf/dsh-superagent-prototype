/**
 * A floor for end-to-end specs: the simulated DSH host running the dshd executor against an in-memory dshd, with settings
 * written through the management API as a deployment's seed writes them, and the main Session as a scripted assessor that
 * accepts each candidate under one rule.
 */
import { expect, vi } from 'vitest'
import type { Ticket } from '../../src/core/index.ts'
import type { DshdConfig } from '../../src/deployment.ts'
import type { Rule } from '../../src/policy.ts'
import { testDshd } from './deployment.ts'
import { FakeDshd } from './fake-dshd.ts'
import { startRuntime, type Host } from './host.ts'

/** The one compute pair, which is also the default. */
export const PAIRS = { alpha: { profile: 'p-alpha', env: {} } }
/** The name the floor's environment passes to every unit, and its value there. */
export const PASSED = ['DSH_E2E_PASSED', 'yes'] as const

/** What the floor admits and accepts: a rule, and the Source admission row whose unlisted, unaddressed cell becomes inferred. */
export interface FloorPolicy { rule: Rule; source: string; row: string }
export interface FloorOptions { dshd?: Partial<DshdConfig>; seed?: Parameters<typeof startRuntime>[0] }

/**
 * Starts the floor: the Runtime with executor dshd, the pair `alpha`, the passed name of `PASSED` and one configured name
 * (`CONFIG_DIR=/srv/config`); then seeds auto mode, the rule beside the existing ones, and the admission cell.
 */
export async function startFloor(policy: FloorPolicy, options: FloorOptions = {}): Promise<{ h: Host; fake: FakeDshd }> {
  vi.stubEnv(PASSED[0], PASSED[1])
  const fake = new FakeDshd()
  const h = await startRuntime(options.seed, { machine: { executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'alpha', passEnv: [PASSED[0]],
    env: { CONFIG_DIR: '/srv/config' }, ...options.dshd }) }, spawn: spec => fake.spawn(spec) })
  await seedSettings(h, policy)
  return { h, fake }
}

/** Writes the policy as the seed does: GET the blocks, then PUT `eval` and `policy` with their revisions. */
export async function seedSettings(h: Host, { rule, source, row }: FloorPolicy): Promise<void> {
  const { body } = await h.api('GET', 'settings')
  const blocks = body.blocks as Record<string, { value: Record<string, unknown>; revision: string }>
  const evalBlock = blocks.eval!, policy = blocks.policy!
  expect((await h.api('PUT', 'settings/eval', { value: { ...evalBlock.value, mode: 'auto' }, revision: evalBlock.revision })).status).toBe(200)
  const value = policy.value as { rules: Rule[]; sources: Record<string, Record<string, unknown>> }
  const saved = await h.api('PUT', 'settings/policy', { revision: policy.revision, value: { ...value, rules: [...value.rules, rule],
    sources: { ...value.sources, [source]: { ...value.sources[source], admission: { [row]: { unlistedUnaddressed: 'inferred' } } } } } })
  expect(saved, JSON.stringify(saved.body)).toMatchObject({ status: 200 })
}

/**
 * The main Session reads the candidate with `orchestrator_eval` and accepts it with `orchestrator_eval_decide`, judging every
 * enabled rule and matching only `rule`. Returns the Ticket once the passes the accept started are done, or at once with
 * `wait: false`, for a launch whose dshd call does not answer.
 */
export async function acceptCandidate(h: Host, triggerId: string, accept: { rule: string; title: string; worktree: string; scope: string; wait?: false }): Promise<Ticket> {
  const main = h.runtime.masterId
  await h.runTool(main, 'orchestrator_eval', { trigger_id: triggerId })
  const rules = h.runtime.store.settings().policy.rules.filter(rule => rule.enabled)
  const decided = await h.runTool(main, 'orchestrator_eval_decide', { trigger_id: triggerId, decision: 'accept', title: accept.title,
    worktree_name: accept.worktree, scope: accept.scope, reason: `Accepted under ${accept.rule}.`, intent_evidence: accept.title,
    rule_assessments: rules.map(rule => ({ rule_id: rule.id, matched: rule.id === accept.rule, reason: rule.id === accept.rule ? 'This rule.' : 'Not this rule.' })),
    direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'The text names its task.' } })
  expect(decided, JSON.stringify(decided)).toMatchObject({ decision: 'accept' })
  if (accept.wait !== false) await h.runtime.idle()
  return h.runtime.store.tickets.get((decided.ticket as { ticket_id: string }).ticket_id)!
}

let skew = 0
/** Time moves on: effects that wait for a later look, a free slot or a retry run now. */
export async function later(h: Host): Promise<void> {
  skew += 10 * 60_000
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
}
/** Every `dshd run` argv the floor spawned, in order. */
export const runArgv = (h: Host): string[][] =>
  h.subprocess.spawn.mock.calls.map(([spec]) => [...spec.argv]).filter(argv => argv.includes('run') && argv.includes('--bg'))
