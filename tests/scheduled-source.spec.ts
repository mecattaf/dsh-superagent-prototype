/** The scheduled Source: occurrence records in an inbox directory become Triggers, read on a real Store through a `SourceContext`. */
import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, assessmentOutcome, settingsPolicy, type Assessment } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import * as scheduled from '../src/sources/scheduled.ts'
import { Config, OccurrenceRecordSchema, inboxOf, occurrenceThread, pruneDone, readInbox, scheduledKind, scheduledTrigger, type OccurrenceRecord, type ScheduledConfig }
  from '../src/sources/scheduled.ts'
import { testDeployment } from './fixtures/deployment.ts'

const directories: string[] = []
const stores: Store[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const temp = (prefix: string): string => { const directory = mkdtempSync(join(tmpdir(), prefix)); directories.push(directory); return directory }

/** Settings of a floor that admits occurrences as inferred candidates and accepts them in auto mode. */
const ADMITTED = { eval: { mode: 'auto' }, policy: { sources: { scheduled: { admission: { occurrence: { unlistedUnaddressed: 'inferred' } } } } } }
/**
 * A real Store and SourceRegistry, an Engine with stand-in ports, and a state directory whose inbox exists. `registered: false`
 * leaves the kind for a plugin entry to register.
 */
function host(options: { settings?: Record<string, unknown>; config?: ScheduledConfig; registered?: false; overrides?: Partial<SourceContextDeps> } = {}) {
  const root = temp('scheduled-source-')
  const stateDir = join(root, 'state'), work = join(root, 'work')
  mkdirSync(stateDir); mkdirSync(work)
  const store = new Store(join(root, 'db.sqlite'))
  stores.push(store)
  store.saveSettings(SettingsSchema.parse({ ...ADMITTED, ...options.settings }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const config = options.config ?? Config({})
  const kind = scheduledKind(config)
  if (options.registered !== false) sources.register(kind)
  const assessor = { request: vi.fn(async () => {}) }
  const executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const deployment = testDeployment({ stateDir })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...options.overrides }
  const inbox = inboxOf(config, deployment)
  mkdirSync(inbox, { recursive: true })
  // Plugin entries take the host, which builds each kind's context; the read round takes the context.
  const orchestrator = { sources, context: (of: { kind: string; health: readonly string[] }) => sourceContextOf(parts, of) }
  return { store, engine, sources, board, assessor, receive, deployment, inbox, work, stateDir, kind, orchestrator,
    ctx: sourceContextOf(parts, kind), done: () => readdirSync(join(inbox, '.done')).sort(), waiting: () => readdirSync(inbox).filter(name => !name.startsWith('.')).sort() }
}
type Host = ReturnType<typeof host>
/** Runs the plugin entry on the host as DSH would, and returns its disposal. */
function mount(h: Host, config: ScheduledConfig = Config({})): () => Promise<void> {
  const disposers: (() => unknown)[] = []
  scheduled.apply({ orchestrator: h.orchestrator, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never, config)
  return async () => { for (const dispose of disposers.reverse()) await dispose() }
}

const TEXT = 'Summarize the pull requests merged yesterday into notes/digest.md, then commit it.'
/** A valid schedule record of item `nightly-digest` working in `cwd`. */
const record = (cwd: string, fields: Partial<OccurrenceRecord> = {}): OccurrenceRecord => ({
  v: 1, kind: 'schedule', namespace: 'team/widgets', item: 'nightly-digest', name: 'Nightly digest', cwd, file: '/srv/work/widgets/schedule/nightly-digest.json',
  due: '2026-11-12T02:00:00.000Z', missed: 0, revision: '3f9d2b7c1a0e', text: TEXT, by: 'scheduled-heartbeat', at: '2026-11-12T02:00:04.512Z', ...fields,
})
const RUN_A = '01KA0Z8Q6V3M4N5P7R8S9T0W1X', RUN_B = '01KA0Z8Q6V3M4N5P7R8S9T0W1Y'
const manual = (cwd: string, run: string, fields: Partial<OccurrenceRecord> = {}): OccurrenceRecord =>
  record(cwd, { kind: 'manual', run, due: '2026-11-12T09:15:30.000Z', at: '2026-11-12T09:15:30.000Z', by: 'scheduled-run', ...fields })
const drop = (inbox: string, name: string, value: unknown): void => { writeFileSync(join(inbox, name), typeof value === 'string' ? value : JSON.stringify(value)) }
const idOf = (value: OccurrenceRecord) => key('scheduled', value.cwd, value.item, value.kind === 'manual' ? `run:${value.run!}` : new Date(value.due).toISOString())
const NAME = 'team+widgets~nightly-digest@20261112T0200Z'
const LABEL = 'team/widgets:nightly-digest — Nightly digest'

describe('scheduled Source', () => {
  it('turns a schedule record into one Trigger without a sender, on its own Thread, labelled with its item, and moves the file to .done', async () => {
    const h = host()
    const value = record(h.work)
    drop(h.inbox, `${NAME}.json`, value)
    expect(await readInbox(h.ctx, h.inbox)).toEqual({ read: 1, superseded: 0, invalid: 0, unreadable: 0 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    const trigger = h.store.triggers.get(idOf(value))!
    expect(trigger).toMatchObject({ id: idOf(value), source: 'scheduled', threads: [{ source: 'scheduled', id: NAME }],
      actor: { source: 'scheduled', id: '' }, human: false, at: '2026-11-12T02:00:00.000Z' })
    // No reply target: an occurrence has no conversation to answer in.
    for (const field of ['addressed', 'channel', 'url']) expect(trigger).not.toHaveProperty(field)
    expect(h.waiting()).toEqual([])
    expect(h.done()).toEqual([`${NAME}.json`])
    // The panel labels the occurrence's Thread with its item and shows when it was due.
    expect(h.store.threads.get(`scheduled:${NAME}`)?.meta).toMatchObject({ label: LABEL,
      facts: { due: { label: { en: 'Due' }, value: '2026-11-12T02:00:00.000Z' }, revision: { value: '3f9d2b7c1a0e' } } })
    expect(occurrenceThread(NAME)).toEqual({ source: 'scheduled', id: NAME })
  })

  it('gives equal records equal Trigger ids, and a re-read after a crash before the move answers duplicate and still moves the file', async () => {
    const h = host()
    const value = record(h.work)
    // The id depends on the occurrence, not on the file it came in or the time it was written.
    expect(scheduledTrigger(value, 'a', { missed: 0 }).id).toBe(scheduledTrigger({ ...value, at: '2026-11-12T03:00:00.000Z' }, 'b', { missed: 0 }).id)
    expect(scheduledTrigger(value, 'a', { missed: 0 }).id).toBe(scheduledTrigger({ ...value, due: '2026-11-12T03:00:00+01:00' }, 'a', { missed: 0 }).id)
    expect(scheduledTrigger(value, 'a', { missed: 0 }).id).not.toBe(scheduledTrigger({ ...value, due: '2026-11-12T03:00:00.000Z' }, 'a', { missed: 0 }).id)
    // A round that received the record and stopped before moving it.
    drop(h.inbox, 'a.json', value)
    expect(await h.receive(scheduledTrigger(value, 'a', { missed: 0 }))).toBe('stored')
    await readInbox(h.ctx, h.inbox)
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.done()).toEqual(['a.json'])
    // The producer drops it again under the same name: still one Trigger, and the earlier file in .done is kept.
    drop(h.inbox, 'a.json', value)
    await readInbox(h.ctx, h.inbox)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    expect(h.done()).toEqual(['a.1.json', 'a.json'])
  })

  it('keys a manual run by its run id, so two runs of one item are two Triggers', async () => {
    const h = host()
    const first = manual(h.work, RUN_A), second = manual(h.work, RUN_B)
    drop(h.inbox, 'run-a.json', first); drop(h.inbox, 'run-b.json', second)
    // A schedule record with the same due is a different occurrence.
    drop(h.inbox, 'schedule.json', record(h.work, { due: first.due }))
    expect(await readInbox(h.ctx, h.inbox)).toMatchObject({ read: 3, superseded: 0 })
    const ids = [idOf(first), idOf(second), idOf(record(h.work, { due: first.due }))]
    expect(new Set(ids).size).toBe(3)
    expect(ids.map(id => h.store.triggers.get(id)?.threads)).toEqual([[occurrenceThread('run-a')], [occurrenceThread('run-b')], [occurrenceThread('schedule')]])
    expect(h.store.triggers.get(idOf(first))?.meta).toMatchObject({ kind: 'manual', occurrence: 'run-a' })
    // Each run's Thread carries the item's label, and when it was requested.
    expect(h.store.threads.get('scheduled:run-a')?.meta).toMatchObject({ label: LABEL, facts: { due: { label: { en: 'Requested' }, value: first.due } } })
  })

  it('writes the header lines before the frozen text, with the missed count, the working directory, the revision and the pair', () => {
    const value = record('/srv/work/widgets', { due: '2026-11-12T03:00:00+01:00', pair: 'small-model' })
    expect(scheduledTrigger(value, 'x', { missed: 2 }).text).toBe([
      '[Scheduled occurrence] team/widgets:nightly-digest — Nightly digest',
      'Due 2026-11-12T02:00:00.000Z; 2 earlier due occurrence(s) did not run. Working directory: /srv/work/widgets. Item file: /srv/work/widgets/schedule/nightly-digest.json. Revision 3f9d2b7c1a0e. Pair: small-model.',
      '', TEXT].join('\n'))
    const { name: _name, file: _file, ...bare } = record('/srv/work/widgets')
    expect(scheduledTrigger(bare, 'x', { missed: 0 }).text).toBe([
      '[Scheduled occurrence] team/widgets:nightly-digest — nightly-digest',
      'Due 2026-11-12T02:00:00.000Z; no earlier due occurrence was missed. Working directory: /srv/work/widgets. Item file: not given. Revision 3f9d2b7c1a0e. Pair: default.',
      '', TEXT].join('\n'))
    expect(scheduledTrigger(manual('/srv/work/widgets', RUN_A), 'x', { missed: 0 }).text).toBe([
      '[Scheduled item, run now] team/widgets:nightly-digest — Nightly digest',
      'Requested 2026-11-12T09:15:30.000Z by scheduled-run. Working directory: /srv/work/widgets. Item file: /srv/work/widgets/schedule/nightly-digest.json. Revision 3f9d2b7c1a0e. Pair: default.',
      '', TEXT].join('\n'))
  })

  it('keeps meta to the occurrence fields and never the text', () => {
    const meta = scheduledTrigger(record('/srv/work/widgets'), 'occ', { missed: 3 }).meta
    expect(meta).toEqual({ occurrence: 'occ', namespace: 'team/widgets', item: 'nightly-digest', cwd: '/srv/work/widgets', kind: 'schedule',
      due: '2026-11-12T02:00:00.000Z', missed: 3, revision: '3f9d2b7c1a0e' })
    expect(scheduledTrigger(record('/srv/work/widgets', { pair: 'small-model' }), 'occ', { missed: 0, superseded: true }).meta)
      .toMatchObject({ pair: 'small-model', superseded: true })
    expect(JSON.stringify(meta)).not.toContain('Summarize')
  })

  it('stores older records of one item read in one round as filtered superseded, adds them to the live record\'s missed, and never supersedes a manual run', async () => {
    const h = host()
    const at = (hour: string, missed = 0) => record(h.work, { due: `2026-11-12T${hour}:00:00.000Z`, missed })
    drop(h.inbox, 'a.json', at('00')); drop(h.inbox, 'b.json', at('01', 1)); drop(h.inbox, 'c.json', at('02'))
    // The same occurrence under a second name is no older record; it answers duplicate.
    drop(h.inbox, 'c-copy.json', at('02'))
    // A manual run due before the live record, and another item, stand on their own.
    drop(h.inbox, 'd.json', manual(h.work, RUN_A, { due: '2026-11-11T23:00:00.000Z' }))
    drop(h.inbox, 'e.json', record(h.work, { item: 'weekly-report', due: '2026-11-11T00:00:00.000Z' }))
    expect(await readInbox(h.ctx, h.inbox)).toEqual({ read: 4, superseded: 2, invalid: 0, unreadable: 0 })
    // The superseded records are received first, then the rest by name, by code unit: 'c-copy.json' comes before 'c.json'.
    const order = h.receive.mock.calls.map(([trigger]) => trigger.meta.occurrence)
    expect(order).toEqual(['a', 'b', 'c-copy', 'c', 'd', 'e'])
    for (const old of [at('00'), at('01', 1)]) expect(h.store.triggers.disposition(idOf(old))?.filtered).toEqual({ code: 'superseded' })
    const live = h.store.triggers.get(idOf(at('02')))!
    // 0 of its own, plus 1 + 0 for a, plus 1 + 1 for b.
    expect(live.meta).toMatchObject({ missed: 3 })
    expect(live.text).toContain('3 earlier due occurrence(s) did not run')
    expect(h.store.triggers.disposition(idOf(at('02')))?.filtered).toBeUndefined()
    expect(await h.receive.mock.results[3]!.value).toBe('duplicate')
    expect(h.store.triggers.get(idOf(manual(h.work, RUN_A)))?.meta).not.toHaveProperty('superseded')
    expect(h.store.triggers.get(idOf(record(h.work, { item: 'weekly-report', due: '2026-11-11T00:00:00.000Z' })))?.meta).toMatchObject({ missed: 0 })
    expect(h.done()).toEqual(['a.json', 'b.json', 'c-copy.json', 'c.json', 'd.json', 'e.json'])
    // A filtered Trigger opens no Thread; each stored occurrence has its own, all labelled with their item.
    expect(h.store.threads.get('scheduled:a')).toBeUndefined()
    expect(h.store.threads.get('scheduled:b')).toBeUndefined()
    expect(h.store.threads.get('scheduled:c-copy')?.meta).toMatchObject({ label: LABEL, facts: { due: { value: '2026-11-12T02:00:00.000Z' } } })
    expect(h.store.threads.get('scheduled:d')?.meta).toMatchObject({ label: LABEL })
  })

  it('assesses a later occurrence of an item on its own Thread while a ticket of an earlier one is open, and gives that ticket nothing', async () => {
    const h = host()
    const first = record(h.work), second = record(h.work, { due: '2026-11-12T03:00:00.000Z' })
    drop(h.inbox, 'a.json', first)
    await readInbox(h.ctx, h.inbox)
    // Occurrence one was accepted: its Eval finished, and its open ticket follows the occurrence's Thread.
    const ticket = { id: 'ticket-1', title: 'team/widgets:nightly-digest', decisionId: 'd-1', mandate: { strength: 'inferred', policyVersion: '',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', source: 'scheduled', scope: {} }, actor: { source: 'scheduled', id: '' }, scope: '' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: idOf(first), triggerIds: [idOf(first)] } } as Ticket
    h.store.tickets.save(ticket)
    const { evaluating: _finished, ...thread } = h.store.threads.get('scheduled:a')!
    h.store.threads.save({ ...thread, subscriptions: ['ticket-1'] })
    drop(h.inbox, 'b.json', second)
    await readInbox(h.ctx, h.inbox)
    // On a Thread the ticket follows, the next occurrence would also have become one of its Inputs; on its own it is only assessed.
    expect(h.engine.candidate(idOf(second))).toMatchObject({ strength: 'inferred', triggers: [expect.objectContaining({ id: idOf(second) })] })
    expect(h.store.tickets.get('ticket-1')?.inputs).toEqual([])
    expect(h.store.triggers.disposition(idOf(second))?.fanout).toEqual([])
  })

  it('quarantines a v 2 record, a record failing the schema, text that is not JSON and a record whose cwd is not a directory into .bad with an .error line, and reads the rest', async () => {
    const h = host()
    drop(h.inbox, 'a-v2.json', { ...record(h.work), v: 2 })
    drop(h.inbox, 'b-schema.json', { ...record(h.work), item: 'Not A Slug', extra: true })
    drop(h.inbox, 'c-text.json', '{"v": 1, "kind": ')
    drop(h.inbox, 'd-cwd.json', record(join(h.work, 'missing')))
    drop(h.inbox, 'e-run.json', { ...record(h.work), kind: 'manual' })
    drop(h.inbox, 'f-good.json', record(h.work))
    expect(await readInbox(h.ctx, h.inbox)).toEqual({ read: 1, superseded: 0, invalid: 5, unreadable: 0, lastInvalid: 'e-run.json' })
    expect(h.done()).toEqual(['f-good.json'])
    expect(h.waiting()).toEqual([])
    const bad = join(h.inbox, '.bad')
    expect(readdirSync(bad).sort()).toEqual(['a-v2.json', 'a-v2.json.error', 'b-schema.json', 'b-schema.json.error', 'c-text.json', 'c-text.json.error',
      'd-cwd.json', 'd-cwd.json.error', 'e-run.json', 'e-run.json.error'])
    const reason = (name: string) => readFileSync(join(bad, `${name}.error`), 'utf8')
    for (const name of ['a-v2.json', 'b-schema.json', 'c-text.json', 'd-cwd.json', 'e-run.json']) {
      expect(reason(name)).toMatch(/^[^\n]+\n$/)
      expect(statSync(join(bad, `${name}.error`)).mode & 0o777).toBe(0o600)
    }
    expect(reason('a-v2.json')).toMatch(/^v: /)
    expect(reason('b-schema.json')).toContain('item: ')
    expect(reason('b-schema.json')).toContain('extra')
    expect(reason('c-text.json')).toMatch(/^not JSON: /)
    expect(reason('d-cwd.json')).toBe(`cwd is not a directory: ${join(h.work, 'missing')}\n`)
    expect(reason('e-run.json')).toBe('run: run is required for kind manual and absent for kind schedule\n')
    // A second invalid file of the same name later keeps the first one.
    drop(h.inbox, 'a-v2.json', { ...record(h.work), v: 3 })
    await readInbox(h.ctx, h.inbox)
    expect(readdirSync(bad)).toContain('a-v2.1.json.error')
  })

  it('ignores dot-files and other extensions, and a record removed between the listing and the read', async () => {
    const h = host()
    drop(h.inbox, '.partial.json', record(h.work)); drop(h.inbox, 'notes.txt', 'x'); drop(h.inbox, 'a.json.tmp', record(h.work))
    // A link whose target is gone reads as a file its producer withdrew after the listing.
    symlinkSync(join(h.inbox, 'nowhere'), join(h.inbox, 'withdrawn.json'))
    // A directory named like a record cannot be read; it is counted and left for a person.
    mkdirSync(join(h.inbox, 'folder.json'))
    expect(await readInbox(h.ctx, h.inbox)).toEqual({ read: 0, superseded: 0, invalid: 0, unreadable: 1 })
    expect(h.receive).not.toHaveBeenCalled()
    expect(readdirSync(h.inbox).sort()).toEqual(['.bad', '.done', '.partial.json', 'a.json.tmp', 'folder.json', 'notes.txt', 'withdrawn.json'])
    expect(h.done()).toEqual([])
    expect(readdirSync(join(h.inbox, '.bad'))).toEqual([])
  })

  it('leaves a record whose receive threw, and reads it on the next round', async () => {
    const h = host()
    drop(h.inbox, 'a.json', record(h.work)); drop(h.inbox, 'b.json', record(h.work, { item: 'weekly-report' }))
    h.receive.mockRejectedValueOnce(new Error('database is locked'))
    await expect(readInbox(h.ctx, h.inbox)).rejects.toThrow('database is locked')
    // The round ends at the failed receive: both records wait.
    expect(h.waiting()).toEqual(['a.json', 'b.json'])
    expect(h.store.triggers.get(idOf(record(h.work)))).toBeUndefined()
    expect(await readInbox(h.ctx, h.inbox)).toMatchObject({ read: 2 })
    expect(h.waiting()).toEqual([])
    expect(h.store.triggers.get(idOf(record(h.work)))).toBeDefined()
  })

  it('admits an occurrence as an inferred candidate only with the occurrence cell set to inferred, and accepts it only in auto mode with an enabled matched rule', async () => {
    // The default admission table ignores a sender off the list who does not address the agent.
    const ignored = host({ settings: { policy: {} } })
    drop(ignored.inbox, 'a.json', record(ignored.work))
    await readInbox(ignored.ctx, ignored.inbox)
    expect(ignored.engine.candidate(idOf(record(ignored.work)))).toBeUndefined()
    expect(ignored.assessor.request).not.toHaveBeenCalled()
    // Off, nothing is admitted even with the cell set.
    const off = host({ settings: { ...ADMITTED, eval: { mode: 'off' } } })
    drop(off.inbox, 'a.json', record(off.work))
    await readInbox(off.ctx, off.inbox)
    expect(off.engine.candidate(idOf(record(off.work)))).toBeUndefined()
    const admitted = host()
    drop(admitted.inbox, 'a.json', record(admitted.work))
    await readInbox(admitted.ctx, admitted.inbox)
    expect(admitted.engine.candidate(idOf(record(admitted.work)))).toMatchObject({ strength: 'inferred' })
    expect(admitted.assessor.request).toHaveBeenCalledOnce()
    // The kind shows the one admission row the cell belongs to.
    expect(admitted.kind.policy!.rows!({})).toEqual([expect.objectContaining({ id: 'occurrence',
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } })])
    const rule = { id: 'scheduled', name: 'Scheduled items', instruction: 'A Trigger of the scheduled Source is an implementation request.' }
    const settings = (mode: string, enabled = true) => SettingsSchema.parse({ eval: { mode }, policy: { rules: [{ ...rule, enabled }] } })
    const assessment = (matched: boolean, rules = [{ rule_id: 'scheduled', matched, reason: 'Names the working directory.' }]): Assessment => ({
      decision: 'accept', rule_assessments: rules, title: 'team/widgets:nightly-digest', scope: 'Summarize the pull requests merged yesterday.',
      reason: 'A scheduled occurrence.', intent_evidence: '[Scheduled occurrence] team/widgets:nightly-digest',
      direction: { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'The task names its file.' } })
    expect(assessmentOutcome(assessment(true), settings('auto'), 'inferred')).toMatchObject({ kind: 'accept', rules: ['scheduled'] })
    expect(assessmentOutcome(assessment(true), settings('observe'), 'inferred')).toMatchObject({ kind: 'ignore', audit: { would_accept: true } })
    expect(assessmentOutcome(assessment(false), settings('auto'), 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(assessmentOutcome(assessment(true, []), settings('auto', false), 'inferred')).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
  })

  it('fills the four DSH_SUPERAGENT_SCHEDULED variables from the origin Trigger, and empty values for a ticket from another Source', async () => {
    const h = host()
    drop(h.inbox, 'team+widgets~nightly-digest@20261112T0200Z.json', record(h.work))
    await readInbox(h.ctx, h.inbox)
    const trigger = h.store.triggers.get(idOf(record(h.work)))!
    const ticket = { id: 't1', execution: { name: 'digest', directory: '/w/digest', assignment: '' } } as unknown as Ticket
    const values = (origin: Trigger) => Object.fromEntries(ticketEnvironment({ deployment: h.deployment, sources: h.sources, settings: h.store.settings(), ticket,
      trigger: origin }).filter(variable => variable.owner === 'scheduled').map(variable => [variable.key, variable.value]))
    expect(values(trigger)).toEqual({ DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: 'team+widgets~nightly-digest@20261112T0200Z',
      DSH_SUPERAGENT_SCHEDULED_ITEM: 'team/widgets:nightly-digest', DSH_SUPERAGENT_SCHEDULED_DUE: '2026-11-12T02:00:00.000Z', DSH_SUPERAGENT_SCHEDULED_CWD: h.work })
    const github = { ...trigger, source: 'github', threads: [{ source: 'github', id: '12' }], meta: { number: 12 } }
    expect(values(github)).toEqual({ DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: '', DSH_SUPERAGENT_SCHEDULED_ITEM: '', DSH_SUPERAGENT_SCHEDULED_DUE: '',
      DSH_SUPERAGENT_SCHEDULED_CWD: '' })
  })

  it('parses both records of the shared fixture tests/fixtures/scheduled-occurrence-v1.json', () => {
    const records = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'scheduled-occurrence-v1.json'), 'utf8')) as unknown[]
    expect(records).toHaveLength(2)
    const parsed = records.map(value => OccurrenceRecordSchema.parse(value))
    expect(parsed.map(value => value.kind)).toEqual(['schedule', 'manual'])
    // Strict: every field the fixture holds is one the schema knows, and parsing drops none.
    expect(parsed).toEqual(records)
    expect(scheduledTrigger(parsed[1]!, 'run', { missed: 0 }).id).toBe(key('scheduled', '/srv/work/widgets', 'nightly-digest', `run:${parsed[1]!.run!}`))
    // `name` is optional: the manual record leaves it out, and its header names the item instead.
    expect(parsed[1]).not.toHaveProperty('name')
    expect(scheduledTrigger(parsed[1]!, 'run', { missed: 0 }).text.split('\n')[0]).toBe('[Scheduled item, run now] team/widgets:nightly-digest — nightly-digest')
  })
})

describe('scheduled Source kind', () => {
  it('filters a superseded record by its reason, observes every other occurrence in one row, and finds the Thread of an occurrence by its name', () => {
    const kind = scheduledKind(Config({}))
    expect(kind.scope!({ meta: { superseded: true } }, { pollSeconds: 10 })).toEqual({ listened: false, reason: 'superseded' })
    expect(kind.scope!({ meta: {} }, { pollSeconds: 10 })).toEqual({ listened: true, observed: true, row: 'occurrence' })
    expect(kind.find!(` ${NAME} `)).toEqual({ threads: [`scheduled:${NAME}`], terms: [NAME] })
    expect(kind.find!('team+widgets~nightly-digest@run~01KA0Z8Q6V3M4N5P7R8S9T0W1X')).toMatchObject({ threads: ['scheduled:team+widgets~nightly-digest@run~01KA0Z8Q6V3M4N5P7R8S9T0W1X'] })
    expect(kind.find!('digest')).toEqual({ threads: [], terms: ['digest'] })
    expect(kind.schema.parse({})).toEqual({ pollSeconds: 10 })
    expect(() => kind.schema.parse({ pollSeconds: 1 })).toThrow()
    // A policy part with no sender to list.
    expect(kind.policy!.schema.parse({})).toEqual({ allowed: [] })
    expect(() => kind.policy!.schema.parse({ allowed: [{ id: 'alice' }] })).toThrow()
  })

  it('reads <stateDir>/inbox/scheduled when inbox is empty, and the configured inbox otherwise, and shows it as the inbox fact', async () => {
    expect(Config({})).toEqual({ inbox: '', doneMaxAgeDays: 0, doneMaxCount: 0 })
    expect(() => Config({ inbox: 'relative/inbox' })).toThrow()
    expect(inboxOf(Config({}), { stateDir: '/srv/state' })).toBe('/srv/state/inbox/scheduled')
    expect(inboxOf(Config({ inbox: '/srv/drop' }), { stateDir: '/srv/state' })).toBe('/srv/drop')
    const deployment = testDeployment({ stateDir: '/srv/state' })
    expect(scheduledKind(Config({})).facts!(deployment)).toEqual({ inbox: '/srv/state/inbox/scheduled' })
    expect(scheduledKind(Config({ inbox: '/srv/drop' })).facts!(deployment)).toEqual({ inbox: '/srv/drop' })
    expect(scheduledKind(Config({ inbox: '/srv/drop' })).facts!(undefined)).toEqual({ inbox: '/srv/drop' })
    // The plugin reads the default inbox beside the database, and a configured one instead when set.
    const standard = host({ registered: false })
    expect(standard.inbox).toBe(join(standard.stateDir, 'inbox', 'scheduled'))
    drop(standard.inbox, 'a.json', record(standard.work))
    const stopStandard = mount(standard)
    await vi.waitFor(() => { expect(standard.done()).toEqual(['a.json']) })
    await stopStandard()
    const elsewhere = join(temp('scheduled-drop-'), 'drop')
    const configured = host({ registered: false, config: Config({ inbox: elsewhere }) })
    expect(configured.inbox).toBe(elsewhere)
    drop(elsewhere, 'b.json', record(configured.work))
    const stopConfigured = mount(configured, Config({ inbox: elsewhere }))
    await vi.waitFor(() => { expect(readdirSync(join(elsewhere, '.done'))).toEqual(['b.json']) })
    await stopConfigured()
    expect(existsSync(join(configured.stateDir, 'inbox'))).toBe(false)
  })
})

const DAY = 86_400_000
const NOW = Date.parse('2026-11-12T05:00:00.000Z')
/** Writes `name` under `dir` as if written `days` before NOW. */
const aged = (dir: string, name: string, days: number): string => {
  const file = join(dir, name)
  writeFileSync(file, '{}')
  const at = new Date(NOW - days * DAY)
  utimesSync(file, at, at)
  return file
}

describe('scheduled .done retention', () => {
  it('keeps every read record in .done by default, however old', () => {
    const h = host()
    const done = join(h.inbox, '.done')
    mkdirSync(done)
    for (const [index, days] of [400, 30, 1].entries()) aged(done, `r${index}.json`, days)
    expect(pruneDone(h.inbox, Config({}), NOW)).toBe(0)
    expect(h.done()).toEqual(['r0.json', 'r1.json', 'r2.json'])
  })

  it('removes read records older than doneMaxAgeDays from .done and keeps the newer ones', () => {
    const h = host()
    const done = join(h.inbox, '.done')
    mkdirSync(done)
    aged(done, 'old.json', 8); aged(done, 'edge.json', 6.9); aged(done, 'new.json', 0)
    expect(pruneDone(h.inbox, Config({ doneMaxAgeDays: 7 }), NOW)).toBe(1)
    expect(h.done()).toEqual(['edge.json', 'new.json'])
  })

  it('keeps the doneMaxCount newest read records in .done, and with both bounds removes a record either one names', () => {
    const h = host()
    const done = join(h.inbox, '.done')
    mkdirSync(done)
    // Named against their age, so the order kept is by modification time, not by name.
    for (const [index, days] of [1, 2, 3, 4, 5].entries()) aged(done, `${String.fromCharCode(101 - index)}.json`, days)
    expect(pruneDone(h.inbox, Config({ doneMaxCount: 3 }), NOW)).toBe(2)
    expect(h.done()).toEqual(['c.json', 'd.json', 'e.json'])
    // Three are within the count, and one of them is past the age.
    expect(pruneDone(h.inbox, Config({ doneMaxAgeDays: 2, doneMaxCount: 3 }), NOW)).toBe(1)
    expect(h.done()).toEqual(['d.json', 'e.json'])
    expect(pruneDone(h.inbox, Config({ doneMaxCount: 3 }), NOW)).toBe(0)
  })

  it('removes only *.json files directly in .done: never .bad, the waiting records, other names, folders, links, or what a link points at', () => {
    const h = host()
    const done = join(h.inbox, '.done'), bad = join(h.inbox, '.bad'), outside = temp('scheduled-outside-')
    mkdirSync(done); mkdirSync(bad)
    aged(done, 'read.json', 30)
    aged(bad, 'invalid.json', 30); aged(bad, 'invalid.json.error', 30)
    aged(h.inbox, 'waiting.json', 30)
    aged(done, 'notes.txt', 30); aged(done, '.hidden.json', 30)
    mkdirSync(join(done, 'folder.json'))
    aged(join(done, 'folder.json'), 'nested.json', 30)
    const target = aged(outside, 'target.json', 30)
    symlinkSync(target, join(done, 'link.json'))
    expect(pruneDone(h.inbox, Config({ doneMaxAgeDays: 1, doneMaxCount: 1 }), NOW)).toBe(1)
    expect(readdirSync(done).sort()).toEqual(['.hidden.json', 'folder.json', 'link.json', 'notes.txt'])
    expect(readdirSync(join(done, 'folder.json'))).toEqual(['nested.json'])
    expect(readdirSync(bad).sort()).toEqual(['invalid.json', 'invalid.json.error'])
    expect(h.waiting()).toEqual(['waiting.json'])
    expect(readdirSync(outside)).toEqual(['target.json'])
  })

  it('refuses a negative or fractional bound', () => {
    expect(() => Config({ doneMaxAgeDays: -1 })).toThrow()
    expect(() => Config({ doneMaxCount: 1.5 })).toThrow()
    expect(Config({ doneMaxAgeDays: 30, doneMaxCount: 500 })).toEqual({ inbox: '', doneMaxAgeDays: 30, doneMaxCount: 500 })
  })

  it('applies the configured retention to .done after each round of the plugin entry', async () => {
    const h = host({ registered: false })
    const done = join(h.inbox, '.done')
    mkdirSync(done)
    // Read by an earlier floor; the record read now is newer, so a count of one keeps only it.
    aged(done, 'earlier.json', 1)
    drop(h.inbox, 'a.json', record(h.work))
    const stop = mount(h, Config({ doneMaxCount: 1 }))
    await vi.waitFor(() => { expect(h.done()).toEqual(['a.json']) })
    await stop()
  })
})

describe('scheduled plugin entry', () => {
  it('registers its kind, reports what it read as ready health, and unregisters the kind and releases the inbox on disposal', async () => {
    const h = host({ registered: false })
    drop(h.inbox, 'a.json', record(h.work)); drop(h.inbox, 'b.json', '[]')
    const stop = mount(h)
    expect(h.sources.kind('scheduled')).toBeDefined()
    await vi.waitFor(() => { expect(h.board.all.scheduled).toMatchObject({ state: 'ready', detail: 'Read 1; superseded 0; invalid 1, last: b.json' }) })
    expect(existsSync(`${h.inbox}.lock`)).toBe(true)
    await stop()
    expect(h.sources.kind('scheduled')).toBeUndefined()
    expect(h.board.all.scheduled).toBeUndefined()
    expect(existsSync(`${h.inbox}.lock`)).toBe(false)
  })

  it('reads nothing and reports setupPending while setup is not configured, and sourceOff while the Source is off', async () => {
    const pending = host({ registered: false, overrides: { configured: () => false } })
    drop(pending.inbox, 'a.json', record(pending.work))
    const stopPending = mount(pending)
    await vi.waitFor(() => { expect(pending.board.all.scheduled).toMatchObject({ state: 'paused', code: 'setupPending' }) })
    await stopPending()
    expect(pending.waiting()).toEqual(['a.json'])
    expect(existsSync(`${pending.inbox}.lock`)).toBe(false)
    expect(pending.receive).not.toHaveBeenCalled()
    const off = host({ registered: false, settings: { sources: { scheduled: { enabled: false, config: {} } } } })
    drop(off.inbox, 'a.json', record(off.work))
    const stopOff = mount(off)
    await vi.waitFor(() => { expect(off.board.all.scheduled).toMatchObject({ state: 'paused', code: 'sourceOff' }) })
    await stopOff()
    expect(off.waiting()).toEqual(['a.json'])
    expect(off.receive).not.toHaveBeenCalled()
  })

  it('reports an error and reads nothing when another process holds the inbox lock', async () => {
    const h = host({ registered: false })
    drop(h.inbox, 'a.json', record(h.work))
    const release = lockSync(h.inbox, { stale: 30_000 })
    try {
      const stop = mount(h)
      await vi.waitFor(() => { expect(h.board.all.scheduled).toMatchObject({ state: 'error', detail: expect.stringContaining('already being held') }) })
      await stop()
    } finally { release() }
    expect(h.waiting()).toEqual(['a.json'])
    expect(h.receive).not.toHaveBeenCalled()
  })

  it('reports a round that fails as an error at once, and ready again after the next round succeeds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const h = host({ registered: false })
      drop(h.inbox, 'a.json', record(h.work))
      h.receive.mockRejectedValueOnce(new Error('database is locked'))
      const stop = mount(h)
      await vi.waitFor(() => { expect(h.board.all.scheduled).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '1' } }) })
      expect(h.waiting()).toEqual(['a.json'])
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => { expect(h.board.all.scheduled).toMatchObject({ state: 'ready', detail: 'Read 1; superseded 0; invalid 0' }) })
      expect(h.done()).toEqual(['a.json'])
      await stop()
    } finally { vi.useRealTimers() }
  })

  it('refuses configuration keys it does not use before registering anything', () => {
    const h = host({ registered: false })
    expect(() => mount(h, Config({ inbox: '', dir: '/srv/drop' } as never))).toThrow('dir')
    expect(h.sources.kind('scheduled')).toBeUndefined()
  })

  it('stays dormant on a context without the orchestrator service, as in a process whose engine is off, and starts once the service exists', async () => {
    const h = host({ registered: false })
    drop(h.inbox, 'a.json', record(h.work))
    const ctx = new Context()
    const fiber = ctx.plugin(scheduled, {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(h.sources.kind('scheduled')).toBeUndefined()
    expect(existsSync(join(h.inbox, '.done'))).toBe(false)
    expect(h.waiting()).toEqual(['a.json'])
    ctx.reflect.provide('orchestrator', h.orchestrator)
    await vi.waitFor(() => { expect(h.done()).toEqual(['a.json']) })
    await fiber.dispose()
    expect(h.sources.kind('scheduled')).toBeUndefined()
    expect(existsSync(`${h.inbox}.lock`)).toBe(false)
  })
})
