/**
 * Scheduled occurrences end to end: a record dropped into the inbox, the scheduled Source plugin on the Runtime, the main
 * Session's assessment under rule `scheduled`, and the dshd executor running each Ticket as one unit of an in-memory dshd.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, runningAssignment, threadKey, type Ticket } from '../src/core/index.ts'
import { BINDING } from '../src/executor/dshd.ts'
import { SettingsSchema } from '../src/policy.ts'
import * as scheduled from '../src/sources/scheduled.ts'
import { Config, inboxOf, readInbox, scheduledKind, scheduledTrigger, type OccurrenceRecord } from '../src/sources/scheduled.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { acceptCandidate, later as pass, runArgv, startFloor, type FloorOptions } from './fixtures/dshd-floor.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import type { Host } from './fixtures/host.ts'

/** The rule a deployment seeds for scheduled occurrences, as scheduled-source §10 words its first sentence. */
const RULE = { id: 'scheduled', name: 'Scheduled items', enabled: true,
  instruction: 'A Trigger of the scheduled Source whose first line starts with [Scheduled occurrence] or [Scheduled item, run now] is an implementation request by the owner of the working directory it names.' }
const TEXT = 'Summarize the pull requests merged yesterday into notes/digest.md, then commit it.'

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
const agency = (): string => { const made = mkdtempSync(join(tmpdir(), 'scheduled-agency-')); directories.push(made); return made }

/** Mounts the plugin entry on the Runtime as DSH loads it, and waits for its first read round. */
async function mount(): Promise<void> {
  const disposers: (() => unknown)[] = []
  scheduled.apply({ orchestrator: h!.runtime, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never, Config({}))
  unmount = async () => { for (const dispose of disposers.reverse()) await dispose() }
  await waitUntil(() => h!.runtime.health.scheduled?.state === 'ready')
}
/** The floor with the `scheduled` rule and admission cell seeded and, unless `mounted: false`, the plugin mounted. */
async function start(options: FloorOptions & { mounted?: false } = {}): Promise<Host> {
  ({ h, fake } = await startFloor({ rule: RULE, source: 'scheduled', row: 'occurrence' }, options))
  if (options.mounted !== false) await mount()
  return h
}
/** The host restarts as after a crash: the plugin goes with the Runtime, and DSH mounts it again on the new one. */
async function restart(): Promise<void> {
  await unmount?.(); unmount = undefined
  await h!.restart()
  await mount()
}
async function stop(): Promise<void> {
  await unmount?.(); unmount = undefined
  await h!.stop(); h = undefined
}

const inbox = () => inboxOf(Config({}), h!.runtime.deployment)
/** A schedule record of `item` working in `cwd`, due at `hour` o'clock UTC on 12 November. */
const record = (cwd: string, hour = 2, item = 'nightly-digest', fields: Partial<OccurrenceRecord> = {}): OccurrenceRecord => ({
  v: 1, kind: 'schedule', namespace: 'team/widgets', item, name: 'Nightly digest', cwd, due: `2026-11-12T${String(hour).padStart(2, '0')}:00:00.000Z`,
  missed: 0, revision: '3f9d2b7c1a0e', text: TEXT, by: 'scheduled-heartbeat', at: `2026-11-12T${String(hour).padStart(2, '0')}:00:04.512Z`, ...fields,
})
/** The file name a scheduler gives the record: `<namespace>~<item>@<instant>`. */
const occurrence = (value: OccurrenceRecord) => `${value.namespace.replace('/', '+')}~${value.item}@${value.due.slice(0, 13).replace(/[-:]/g, '')}00Z`
/** Drops records as the producer does, and returns the Trigger id of each. */
function drop(...values: OccurrenceRecord[]): string[] {
  mkdirSync(inbox(), { recursive: true })
  for (const value of values) writeFileSync(join(inbox(), `${occurrence(value)}.json`), JSON.stringify(value))
  return values.map(value => scheduledTrigger(value, occurrence(value), { missed: 0 }).id)
}
/** One read round of the inbox, as the plugin's loop runs it, and the passes it starts. */
async function round(): Promise<void> {
  await readInbox(h!.runtime.context(scheduledKind(Config({}))), inbox())
  await h!.runtime.idle()
}
/** The main Session accepts the occurrence under rule `scheduled` as one Ticket. */
const accept = (triggerId: string, worktree = 'nightly-digest', options: { wait?: false } = {}): Promise<Ticket> =>
  acceptCandidate(h!, triggerId, { rule: 'scheduled', title: 'team/widgets:nightly-digest', worktree, scope: TEXT, ...options })
const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
const binding = (ticket: Ticket, k = 1) => h!.runtime.store.get(BINDING(stored(ticket).assignments[k - 1]?.id ?? ''))
const unitOf = (ticket: Ticket, k = 1) => binding(ticket, k)!.name
const later = () => pass(h!)
const summaries = () => h!.runtime.store.tickets.list().flatMap(ticket => ticket.assignments.map(item => item.report?.summary ?? ''))

describe('scheduled occurrences on the dshd executor', () => {
  it('a dropped occurrence record becomes one Trigger, one accepted Ticket and one dshd run with --cwd equal to the record cwd, the pair profile, no --patch, and ends completed when the fake unit exits 0 with a final line', async () => {
    await start({ mounted: false })
    const cwd = agency()
    // Dropped before the plugin mounts: the first round of its own loop reads it.
    const [id] = drop(record(cwd))
    await mount(); await h!.runtime.idle()
    expect(readdirSync(join(inbox(), '.done'))).toEqual([`${occurrence(record(cwd))}.json`])
    const trigger = h!.runtime.store.triggers.get(id!)!
    expect(trigger).toMatchObject({ source: 'scheduled', human: false, meta: { cwd, item: 'nightly-digest' } })
    expect(h!.runtime.engine.candidate(id!)).toMatchObject({ strength: 'inferred' })
    const ticket = await accept(id!)
    expect(h!.runtime.store.tickets.list()).toHaveLength(1)
    expect(ticket.mandate).toMatchObject({ strength: 'inferred', basis: expect.objectContaining({ rules: ['scheduled'] }) })

    // One unit, run exactly as executor.md §5 builds it.
    expect(fake.runs).toHaveLength(1)
    const assignment = stored(ticket).assignments[0]!
    const name = `sa-nightly-digest-${ticket.id.slice(0, 12)}-a1`
    expect(stored(ticket).execution!.name).toBe(`nightly-digest-${ticket.id.slice(0, 12)}`)
    const argv = runArgv(h!)
    expect(argv).toHaveLength(1)
    expect(argv[0]).toEqual(['env', '-i', 'CONFIG_DIR=/srv/config', 'DSH_E2E_PASSED=yes', 'dshd', 'run', '--bg', '--json', '--name', name, '--cwd', cwd,
      '--label', `superagent.assignment=${assignment.id}`, '--label', `superagent.orchestrator=${h!.runtime.masterId}`, '--label', 'superagent.pair=alpha',
      '--label', `superagent.ticket=${ticket.id}`, '--', 'p-alpha', '--approval-policy', 'never', '--json', fake.runs[0]!.task])
    expect(argv[0]!.filter(arg => arg.startsWith('--patch'))).toEqual([])
    // The unit's environment is the passed and configured names only: the Source's DSH_SUPERAGENT_SCHEDULED_* variables stay
    // in this process, and the brief carries the occurrence instead.
    expect(Object.keys(fake.runs[0]!.env).sort()).toEqual(['CONFIG_DIR', 'DSH_E2E_PASSED'])
    // The brief: the framing first, the occurrence's whole text, header and frozen task, last.
    const brief = JSON.parse(fake.runs[0]!.task) as Record<string, unknown>
    expect(Object.keys(brief)).toEqual(['note', 'ticket_id', 'title', 'attempt', 'assignment', 'trigger'])
    expect(brief.assignment).toContain('Proactively accepted under scheduled.')
    expect(brief).toMatchObject({ ticket_id: ticket.id, title: 'team/widgets:nightly-digest', attempt: 1,
      trigger: { trigger_id: id, from: '', at: '2026-11-12T02:00:00.000Z', text: trigger.text } })
    expect(trigger.text).toMatch(/^\[Scheduled occurrence\] team\/widgets:nightly-digest — Nightly digest\nDue 2026-11-12T02:00:00.000Z; /)
    expect(trigger.text.endsWith(`\n\n${TEXT}`)).toBe(true)

    // The unit exits 0 with a long final answer: the Ticket completes with that answer, verbatim and uncapped, as its result.
    const final = `Wrote notes/digest.md and committed it.\n${'- one merged pull request\n'.repeat(300)}`
    fake.end(name, { lines: runLines('session-1', final) })
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: final })
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-1', ended: { verdict: 'completed', exitCode: 0 } })
    expect(h!.relays(h!.runtime.masterId).filter(item => item.kind === 'worker_report')).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
  })

  it('T-SRC-thread: two records of one item give two Threads and two Tickets, and settling or stopping the first never calls dshd stop for the second unit', async () => {
    for (const end of ['settles', 'is stopped'] as const) {
      await start()
      const cwd = agency()
      const [first] = drop(record(cwd, 2))
      await round()
      const one = await accept(first!)
      // The next due occurrence of the same item, read while the first one's unit runs.
      const [second] = drop(record(cwd, 3))
      await round()
      const threads = [first!, second!].map(id => threadKey(h!.runtime.store.triggers.get(id)!.threads[0]!))
      expect(new Set(threads).size).toBe(2)
      // The second occurrence is a candidate of its own, not an Input of the first one's live Ticket.
      expect(stored(one).inputs.filter(input => input.kind === 'trigger' && input.triggerId === second)).toEqual([])
      expect(h!.runtime.engine.candidate(second!)).toBeDefined()
      const two = await accept(second!)
      expect(two.id).not.toBe(one.id)
      expect(threads.map(thread => h!.runtime.store.threads.get(thread)!.subscriptions)).toEqual([[one.id], [two.id]])
      expect(fake.runs.map(recipe => recipe.cwd)).toEqual([cwd, cwd])

      if (end === 'settles') {
        fake.end(unitOf(one), { lines: runLines('session-1', 'Digest written.') })
        await later()
        expect(stored(one).ended?.outcome).toBe('completed')
        expect(fake.stops).toEqual([])
      } else {
        h!.runtime.engine.stopTicket(one.id); await h!.runtime.idle()
        expect(stored(one).ended?.outcome).toBe('stopped')
        expect(fake.stops).toEqual([unitOf(one)])
      }
      // The second unit runs on, and its Ticket with it.
      expect(fake.instances.get(unitOf(two))!.state).toBe('running')
      expect(binding(two)).toMatchObject({ state: 'running' })
      expect(runningAssignment(stored(two))).toBeDefined()
      expect(stored(two).ended).toBeUndefined()
      await stop()
    }
  })

  it('T-EX-stop-own: stop touches only the unit whose invocationId the binding recorded', async () => {
    await start()
    const cwd = agency()
    const [first] = drop(record(cwd, 2))
    await round()
    const one = await accept(first!)
    const [second] = drop(record(cwd, 3))
    await round()
    const two = await accept(second!)
    // Someone reruns the first unit by hand: the instance carries a new invocation the binding never recorded.
    fake.rerun(unitOf(one))
    h!.runtime.engine.stopTicket(one.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
    expect(fake.instances.get(unitOf(one))!.state).toBe('running')
    expect(binding(one)).toMatchObject({ state: 'ended', invocationId: 'invocation-1', ended: { verdict: 'superseded' } })
    expect(fake.instances.get(unitOf(two))!.state).toBe('running')
    // The second Ticket's stop stops its own unit, the one its binding started, and nothing else.
    h!.runtime.engine.stopTicket(two.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([unitOf(two)])
    expect(binding(two)).toMatchObject({ state: 'ended', invocationId: 'invocation-2', ended: { verdict: 'stopped' } })
    expect(fake.instances.get(unitOf(one))!.state).toBe('running')
  })

  it('T-EX-recipe-deterministic: launching the same Assignment twice yields already-running or task-already-ran, never exists-different-recipe', async () => {
    for (const before of ['runs on', 'ended'] as const) {
      await start()
      const cwd = agency()
      // The CLI's answer to the first `dshd run` never arrives: the floor crashes after dshd created the unit.
      const gate = deferred()
      fake.hold = gate.promise
      const [id] = drop(record(cwd))
      await round()
      const ticket = await accept(id!, 'nightly-digest', { wait: false })
      await waitUntil(() => fake.runs.length === 1)
      if (before === 'ended') fake.end(fake.runs[0]!.name, { lines: runLines('session-1', 'Digest written.') })
      // The call in flight still waits for the gate; the restarted floor's call does not.
      fake.hold = undefined
      await restart()
      await h!.runtime.idle()
      await later()
      // The restarted floor launched the same Assignment again with its frozen recipe, byte for byte.
      expect(fake.runs).toHaveLength(2)
      expect(fake.runs[1]).toEqual(fake.runs[0])
      expect(fake.instances.size).toBe(1)
      expect(summaries().join('\n')).not.toContain('exists-different-recipe')
      expect(stored(ticket).assignments).toHaveLength(1)
      if (before === 'runs on') {
        expect(binding(ticket)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
        expect(runningAssignment(stored(ticket))?.id).toBe(stored(ticket).assignments[0]!.id)
      } else {
        expect(binding(ticket)).toMatchObject({ state: 'ended', invocationId: 'invocation-1', ended: { verdict: 'completed' } })
        expect(stored(ticket).ended?.outcome).toBe('completed')
        expect(latestAssignment(stored(ticket))!.report!.summary).toBe('Digest written.')
      }
      gate.resolve()
      await stop()
    }
  })

  it('T-EX-slots: with maxWorkers 1 a second accepted Ticket stays pending (Later), not failed, and launches when the first unit ends', async () => {
    await start()
    const settings = h!.runtime.store.settings()
    h!.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
    const [digest, report] = drop(record(agency(), 2), record(agency(), 2, 'weekly-report'))
    await round()
    const one = await accept(digest!)
    const two = await accept(report!, 'weekly-report')
    await later(); await later()
    expect(fake.runs).toHaveLength(1)
    expect(latestAssignment(stored(two))).toMatchObject({ state: 'pending' })
    expect(latestAssignment(stored(two))!.report).toBeUndefined()
    expect(stored(two).ended).toBeUndefined()
    expect(binding(two)).toBeUndefined()
    fake.end(unitOf(one), { lines: runLines('session-1', 'Digest written.') })
    await later()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]!.labels['superagent.ticket']).toBe(two.id)
    expect(runningAssignment(stored(two))).toBeDefined()
  })

  it('T-SETUP-noaccount: under executor dshd with no GitHub repository the runtime reaches ready, configured() is true, and the scheduled Source leaves setupPending', async () => {
    // A floor with no account Source at all: no GitHub repository, no Feishu bot.
    await start({ seed: store => { store.saveSettings(SettingsSchema.parse({ ...store.settings(), sources: {} })) } })
    expect(h!.runtime.configured()).toBe(true)
    expect(h!.runtime.deployment).toMatchObject({ repository: '', github: { cli: '', login: '', noreply: '' } })
    expect(h!.runtime.health.runtime?.state).toBe('ready')
    expect(h!.runtime.health.scheduled).toMatchObject({ state: 'ready' })
    expect(h!.runtime.health.scheduled?.code).not.toBe('setupPending')
    // The whole path works without an account: the occurrence is read, accepted and launched.
    const cwd = agency()
    const [id] = drop(record(cwd))
    await round()
    await accept(id!)
    expect(fake.runs.map(recipe => recipe.cwd)).toEqual([cwd])
  })

  it('an undelivered machine Input does not keep an ended unit\'s Ticket from completing', async () => {
    await start()
    const cwd = agency()
    const [first] = drop(record(cwd, 2))
    await round()
    const one = await accept(first!)
    // On its own Thread, the next occurrence of the item never becomes an Input of the first Ticket.
    const [second] = drop(record(cwd, 3))
    await round()
    expect(stored(one).inputs).toEqual([])
    fake.end(unitOf(one), { lines: runLines('session-1', 'Digest written.') })
    await later()
    expect(stored(one).ended?.outcome).toBe('completed')
    expect(h!.runtime.engine.candidate(second!)).toBeDefined()
  })

  it('documents why the Thread is per occurrence: on a shared item Thread the next occurrence sits undelivered in the first Ticket, which still completes and hands it back to Eval', async () => {
    await start()
    const cwd = agency()
    const [first] = drop(record(cwd, 2))
    await round()
    const one = await accept(first!)
    // The withdrawn per-item shape: the next occurrence arrives on the first one's Thread.
    const next = record(cwd, 3)
    const shared = { ...scheduledTrigger(next, occurrence(next), { missed: 0 }), threads: h!.runtime.store.triggers.get(first!)!.threads }
    h!.runtime.receive(shared); await h!.runtime.idle()
    const input = stored(one).inputs.find(item => item.kind === 'trigger' && item.triggerId === shared.id)
    expect(input).toBeDefined()
    // The dshd executor delivers nothing mid-run: the brief the unit got is all it sees.
    expect(stored(one).undelivered).toContain(input!.id)
    fake.end(unitOf(one), { lines: runLines('session-1', 'Digest written.') })
    await later()
    expect(stored(one).ended?.outcome).toBe('completed')
    expect(stored(one).undelivered).toEqual([])
    expect(fake.runs).toHaveLength(1)
  })
})
