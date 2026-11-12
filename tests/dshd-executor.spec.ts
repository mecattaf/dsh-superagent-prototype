/** The dshd executor on the simulated DSH host, with its real Store, Engine and Effects and an in-memory dshd. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, runningAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { BINDING, DshdExecutor, verdictOf } from '../src/executor/dshd.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import type { DshdConfig } from '../src/deployment.ts'
import { testDshd } from './fixtures/deployment.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const PAIRS = { opus: { profile: 'work-opus', env: {} }, local: { profile: 'work-local', env: { LOCAL_MODEL_KEY: 'none' }, maxWorkers: 1 } }
let h: Host | undefined
let fake: FakeDshd
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await h?.stop(); h = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const directory = () => { const made = mkdtempSync(join(tmpdir(), 'dshd-agency-')); directories.push(made); return made }
async function start(dshd: Partial<DshdConfig> = {}): Promise<Host> {
  fake = new FakeDshd()
  h = await startRuntime(undefined, { machine: { executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', env: { CONFIG_DIR: '/srv/config' }, ...dshd }) },
    spawn: spec => fake.spawn(spec) })
  return h
}
/** A request that names its directory and, optionally, its pair and labels, as the Scheduled and Workflow Sources write them. */
function request(id: string, meta: Record<string, unknown> = {}): Trigger {
  const trigger = feishu(id, `@bot 任务 ${id}`)
  return { ...trigger, meta: { ...trigger.meta, ...meta } }
}
async function accepted(trigger: Trigger) {
  const { ticket } = await h!.acceptedTicket(trigger)
  return { ticket, unit: () => fake.instances.get(binding(ticket)?.name ?? '') }
}
const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
const binding = (ticket: Ticket, k = 1) => h!.runtime.store.get(BINDING(stored(ticket).assignments[k - 1]?.id ?? ''))
const nameOf = (ticket: Ticket, k = 1) => binding(ticket, k)!.name
/** Time moves on: effects that wait for a later look, a free slot or a retry run now. */
let skew = 0
async function later(): Promise<void> {
  skew += 10 * 60_000
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
  try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
}
const reports = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'worker_report')

describe('launch and recipe', () => {
  it('launches an accepted Ticket as one unit named <prefix>-<name>-a1 in the directory its Trigger names', async () => {
    await start()
    const agency = directory()
    const { ticket } = await accepted(request('1', { cwd: agency }))
    expect(fake.runs).toHaveLength(1)
    const [recipe] = fake.runs
    expect(recipe).toMatchObject({ name: `sa-${stored(ticket).execution!.name}-a1`, cwd: agency, profile: 'work-opus', args: ['--approval-policy', 'never'],
      labels: { 'superagent.orchestrator': h!.runtime.masterId, 'superagent.ticket': ticket.id, 'superagent.assignment': stored(ticket).assignments[0]!.id,
        'superagent.pair': 'opus' } })
    expect(recipe!.name).toMatch(/^sa-fix-regression-[0-9a-f]{12}-a1$/)
    expect(runningAssignment(stored(ticket))).toBeDefined()
    expect(binding(ticket)).toMatchObject({ executor: 'dshd', state: 'running', invocationId: 'invocation-1', instanceId: 'instance-1', pair: 'opus' })
    expect(h!.runtime.executor).toBeInstanceOf(DshdExecutor)
    expect(h!.runtime.executor.activeCount()).toBe(1)
    // The brief is the whole first message: the Ticket, its source request in full and how a headless worker ends.
    expect(JSON.parse(recipe!.task)).toMatchObject({ ticket_id: ticket.id, title: `Fix ${ticket.origin.triggerId}`, attempt: 1,
      trigger: { trigger_id: ticket.origin.triggerId, text: '@bot 任务 1' }, note: expect.stringContaining('there is no report tool') })
    // The framing comes first and the request last.
    expect(Object.keys(JSON.parse(recipe!.task) as object)).toEqual(['note', 'ticket_id', 'title', 'attempt', 'trigger'])
    expect(JSON.parse(recipe!.task).note).toMatch(/If the task asks for a JSON-only reply, your final answer is that JSON value and nothing else\.$/)
  })
  it('runs a Ticket whose Trigger names no directory in the configured cwd, else in a directory it makes under the Execution directory', async () => {
    const configured = directory()
    await start({ cwd: configured })
    await accepted(request('1'))
    expect(fake.runs[0]!.cwd).toBe(configured)
    await h!.stop()
    await start()
    const { ticket } = await accepted(request('2'))
    expect(fake.runs[0]!.cwd).toBe(join(h!.directory, 'work', stored(ticket).execution!.name))
    expect(statSync(fake.runs[0]!.cwd).isDirectory()).toBe(true)
  })
  it('gives a unit the passed names, the configured environment and its pair\'s environment, and nothing else', async () => {
    await start({ passEnv: ['HOME', 'NOT_SET_ANYWHERE'] })
    await accepted(request('1', { cwd: directory(), pair: 'local' }))
    expect(fake.runs[0]!.env).toEqual({ HOME: process.env.HOME, CONFIG_DIR: '/srv/config', LOCAL_MODEL_KEY: 'none' })
    const argv = h!.subprocess.spawn.mock.calls.map(([spec]) => spec.argv).find(item => item.includes('run'))!
    expect(argv.slice(0, 2)).toEqual(['env', '-i'])
  })
  it('runs the pair the Trigger names, else the default pair, and labels the unit with it, keeping only superagent labels of the Trigger', async () => {
    await start()
    await accepted(request('1', { cwd: directory(), pair: 'local', labels: { 'superagent.run': 'r1', 'superagent.node': 'n2', other: 'x', 'superagent.ticket': 'forged' } }))
    await accepted(request('5', { cwd: directory() }))
    expect(fake.runs.map(recipe => [recipe.profile, recipe.labels['superagent.pair']])).toEqual([['work-local', 'local'], ['work-opus', 'opus']])
    expect(fake.runs[0]!.labels).toMatchObject({ 'superagent.run': 'r1', 'superagent.node': 'n2' })
    expect(fake.runs[0]!.labels).not.toHaveProperty('other')
    expect(fake.runs[0]!.labels['superagent.ticket']).not.toBe('forged')
  })
  it('records failed without retrying for a pair the configuration does not name, or a directory that does not exist', async () => {
    await start()
    const unknown = await accepted(request('1', { cwd: directory(), pair: 'gpu' }))
    const missing = await accepted(request('5', { cwd: join(directory(), 'gone') }))
    await later()
    expect(fake.runs).toEqual([])
    expect(latestAssignment(stored(unknown.ticket))!.report).toMatchObject({ state: 'failed', summary: 'unknown pair gpu' })
    expect(latestAssignment(stored(missing.ticket))!.report!.summary).toMatch(/^cwd .*gone does not exist$/)
    expect(waitsForPerson(stored(missing.ticket))).toBe(true)
  })
  it('records the binding before dshd run, and the started Assignment, delivered and read Inputs and the watch in one transaction', async () => {
    await start()
    let seen: unknown
    const run = fake.run.bind(fake)
    fake.run = async recipe => { seen = h!.runtime.store.get(BINDING(recipe.labels['superagent.assignment']!)); return run(recipe) }
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    expect(seen).toMatchObject({ state: 'launching', recipe: fake.runs[0] })
    expect(stored(ticket).undelivered).toEqual([])
    expect(h!.runtime.effects.pending('dshd-watch', stored(ticket).assignments[0]!.id)).toBe(true)
  })
  it('writes a brief longer than briefArgvMaxChars once under stateDir/briefs and passes a pointer to it', async () => {
    await start({ briefArgvMaxChars: 1000 })
    const { ticket } = await accepted({ ...request('1', { cwd: directory() }), text: `@bot ${'整理日志。'.repeat(300)}` })
    const file = join(h!.directory, 'briefs', `${stored(ticket).assignments[0]!.id}.json`)
    expect(fake.runs[0]!.task).toBe(`Read and follow the task in ${file}.`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ ticket_id: ticket.id })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('idempotency', () => {
  it('re-runs a launch cut off by a crash with the frozen recipe: dshd reports already-running and only one unit exists', async () => {
    await start()
    const gate = deferred()
    fake.hold = gate.promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    await h!.restart()
    fake.hold = undefined
    await h!.runtime.idle()
    const [ticket] = h!.runtime.store.tickets.list()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(fake.instances.size).toBe(1)
    expect(binding(ticket!)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
    expect(runningAssignment(stored(ticket!))?.id).toBe(stored(ticket!).assignments[0]!.id)
    gate.resolve()
  })
  it('binds a unit that ran to its end before the crash (task-already-ran) and settles it from its last run', async () => {
    await start()
    fake.hold = deferred().promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    await h!.restart()
    fake.hold = undefined
    fake.end(fake.runs[0]!.name, { lines: runLines('session-9', 'All done.') })
    await later()
    const [ticket] = h!.runtime.store.tickets.list()
    expect(fake.runs).toHaveLength(2)
    expect(stored(ticket!).ended?.outcome).toBe('completed')
    expect(binding(ticket!)).toMatchObject({ state: 'ended', invocationId: 'invocation-1', sessionId: 'session-9', ended: { verdict: 'completed' } })
  })
  it('records failed without retrying when dshd refuses the recipe', async () => {
    await start()
    fake.failNext('run', 4, 'exists-different-recipe')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later()
    expect(fake.runs).toHaveLength(1)
    expect(latestAssignment(stored(ticket))!.report!.summary).toMatch(/^dshd refused sa-.*-a1: exists-different-recipe: /)
  })
  it('tries an unavailable dshd three times, then records failed', async () => {
    await start()
    for (let i = 0; i < 4; i++) fake.failNext('run', 7, 'systemd-unavailable')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later(); await later(); await later()
    expect(fake.runs).toHaveLength(3)
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('systemd-unavailable') })
  })
})

describe('slots', () => {
  const maxWorkers = (n: number) => {
    const settings = h!.runtime.store.settings()
    h!.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: n } })
  }
  it('keeps the N+1th Ticket pending, not failed, while maxWorkers N units run, and launches it when one ends', async () => {
    await start()
    maxWorkers(1)
    const one = await accepted(request('1', { cwd: directory() }))
    const two = await accepted(request('5', { cwd: directory() }))
    await later()
    expect(fake.runs).toHaveLength(1)
    expect(latestAssignment(stored(two.ticket))).toMatchObject({ state: 'pending' })
    expect(latestAssignment(stored(two.ticket))!.report).toBeUndefined()
    fake.end(nameOf(one.ticket))
    await later()
    expect(fake.runs).toHaveLength(2)
    expect(runningAssignment(stored(two.ticket))).toBeDefined()
  })
  it('launches pending Tickets oldest first as slots free', async () => {
    await start()
    maxWorkers(1)
    const one = await accepted(request('1', { cwd: directory() }))
    const two = await accepted(request('5', { cwd: directory() }))
    const three = await accepted(request('9', { cwd: directory() }))
    fake.end(nameOf(one.ticket)); await later()
    fake.end(nameOf(two.ticket)); await later()
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).toEqual([one.ticket.id, two.ticket.id, three.ticket.id])
  })
  it('frees the slot of a unit that ended failed although its Assignment still runs', async () => {
    await start()
    maxWorkers(1)
    const one = await accepted(request('1', { cwd: directory() }))
    await accepted(request('5', { cwd: directory() }))
    fake.end(nameOf(one.ticket), { exitCode: 2 })
    await later()
    expect(runningAssignment(stored(one.ticket))).toBeDefined()
    expect(fake.runs).toHaveLength(2)
  })
  it('holds a pair at its own maxWorkers while another pair launches', async () => {
    await start()
    await accepted(request('1', { cwd: directory(), pair: 'local' }))
    const second = await accepted(request('5', { cwd: directory(), pair: 'local' }))
    await accepted(request('9', { cwd: directory(), pair: 'opus' }))
    await later()
    expect(fake.runs.map(recipe => recipe.labels['superagent.pair'])).toEqual(['local', 'opus'])
    expect(latestAssignment(stored(second.ticket))).toMatchObject({ state: 'pending' })
  })
  it('holds launches while processing is paused', async () => {
    await start()
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    await h!.runtime.settings.pause(true, 'panel')
    await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await later()
    expect(fake.runs).toEqual([])
    await h!.runtime.settings.pause(false, 'panel')
    await later()
    expect(fake.runs).toHaveLength(1)
  })
})

describe('settlement', () => {
  it('ends the Ticket completed when its unit exits 0, with the final answer verbatim as its summary', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const name = nameOf(ticket)
    fake.end(name, { lines: runLines('session-7', 'Cleaned the journal.') })
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    // The answer is the Ticket's result verbatim and uncapped; the unit and its Session are in the binding and the relay.
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'Cleaned the journal.' })
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-7', ended: { verdict: 'completed', exitCode: 0, ending: 'exited' } })
    expect(h!.runtime.executor.activeCount()).toBe(0)
  })
  it('records failed and keeps the Ticket open for a person when its unit exits non-zero, is killed or never ran', async () => {
    await start()
    const exits = await accepted(request('1', { cwd: directory() }))
    const killed = await accepted(request('5', { cwd: directory() }))
    const never = await accepted(request('9', { cwd: directory() }))
    fake.end(nameOf(exits.ticket), { exitCode: 3, lines: runLines('session-1', 'Tests fail.') })
    fake.end(nameOf(killed.ticket), { signal: 9, lines: [] })
    fake.end(nameOf(never.ticket), { ending: 'failed', lines: [] })
    fake.instances.get(nameOf(never.ticket))!.lastRun.child = null
    await later()
    for (const { ticket } of [exits, killed, never]) {
      expect(stored(ticket).ended).toBeUndefined()
      expect(waitsForPerson(stored(ticket))).toBe(true)
    }
    expect(latestAssignment(stored(exits.ticket))!.report!.summary).toBe(`Unit ${nameOf(exits.ticket)} ended task-failed (exit 3).\n\nTests fail.\n\nUnit ${nameOf(exits.ticket)}; session session-1.`)
    expect(latestAssignment(stored(killed.ticket))!.report!.summary).toContain('ended killed (signal 9).')
    expect(latestAssignment(stored(never.ticket))!.report!.summary).toContain('ended never-ran.')
  })
  it('records failed when someone stopped the unit with dshd stop', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { ending: 'stopped', lines: [] })
    await later()
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('ended stopped.') })
  })
  it('restarts a unit a reboot cut as upstream restarts interrupted work: a new Assignment with the recovery note', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.cut(nameOf(ticket))
    await later()
    expect(stored(ticket).assignments.map(item => [item.state, item.endedReason])).toEqual([['ended', 'hostRestarted'], ['running', undefined]])
    expect(fake.runs.map(recipe => recipe.name)).toEqual([nameOf(ticket), nameOf(ticket).replace(/-a1$/, '-a2')])
    const brief = JSON.parse(fake.runs[1]!.task) as { attempt: number; inputs: string[] }
    expect(brief.attempt).toBe(2)
    expect(brief.inputs.join('\n')).toContain('The host restarted during this ticket.')
  })
  it('records failed when dshd no longer knows the unit', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.remove(nameOf(ticket))
    await later()
    expect(latestAssignment(stored(ticket))!.report!.summary).toContain('ended lost.')
  })
  it('never settles from another invocation of the unit\'s name', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.rerun(nameOf(ticket))
    fake.end(nameOf(ticket), { lines: runLines('session-x', 'Someone else\'s answer.') })
    await later()
    expect(stored(ticket).ended).toBeUndefined()
    expect(latestAssignment(stored(ticket))!.report!.summary).toContain('ended superseded.')
    expect(latestAssignment(stored(ticket))!.report!.summary).not.toContain('Someone else')
  })
  it('does not let an older unit\'s end settle a newer Assignment', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const first = nameOf(ticket)
    fake.end(first, { exitCode: 1, lines: [] }); await later()
    // A person retries; the first unit's watch would see the same end again, but its Assignment no longer runs.
    h!.runtime.engine.retryTicket(ticket.id); await later()
    h!.runtime.effects.enqueue('dshd-watch', stored(ticket).assignments[0]!.id, { ticketId: ticket.id, assignmentId: stored(ticket).assignments[0]!.id })
    await later()
    expect(runningAssignment(stored(ticket))?.id).toBe(stored(ticket).assignments[1]!.id)
    expect(stored(ticket).assignments[1]!.report).toBeUndefined()
  })
  it('relays a worker_report to the main Session for each settled unit', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { lines: runLines('session-3', 'Done.') }); await later()
    expect(reports()).toEqual([expect.objectContaining({ kind: 'worker_report', state: 'ready', summary: 'Done.', unit: nameOf(ticket), session: 'session-3' })])
  })
  it('keeps an Assignment whose unit dshd cannot tell about, and settles it once it can', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.instances.get(nameOf(ticket))!.state = 'inconsistent'
    await later()
    expect(binding(ticket)!.state).toBe('running')
    expect(verdictOf({ state: 'inconsistent', lastRun: null })).toBe('unknown')
    fake.end(nameOf(ticket)); await later(); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
  })
})

describe('restart', () => {
  it('adopts a unit that still runs after a restart: no interruption, no second dshd run, the same invocationId', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await h!.restart()
    await h!.runtime.idle()
    expect(stored(ticket).assignments).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
    expect(binding(ticket)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
    fake.end(nameOf(ticket)); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
  })
  it('restarts an Assignment that ran in-process before the switch as upstream does', async () => {
    fake = new FakeDshd()
    h = await startRuntime(undefined, { spawn: spec => fake.spawn(spec) })
    expect(h.runtime.executor).toBeInstanceOf(DshExecutor)
    const { ticket } = await h.acceptedTicket(request('1', { cwd: directory() }))
    expect(runningAssignment(stored(ticket))).toBeDefined()
    await h.restart({ executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus' }) })
    await h.runtime.idle()
    expect(stored(ticket).assignments.map(item => item.endedReason)).toEqual(['hostRestarted', undefined])
    expect(fake.runs.map(recipe => recipe.name)).toEqual([expect.stringMatching(/-a2$/)])
  })
  it('leaves a settled Assignment alone on restart', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { exitCode: 1, lines: [] }); await later()
    await h!.restart(); await h!.runtime.idle()
    expect(stored(ticket).assignments).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
  })
  it('does not observe a binding another host made', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    h!.runtime.store.set(BINDING(id), { ...binding(ticket)!, host: 'another-host' })
    fake.end(nameOf(ticket)); await later()
    expect(stored(ticket).ended).toBeUndefined()
    expect(binding(ticket)!.state).toBe('running')
    expect(h!.runtime.effects.pending('dshd-watch', id)).toBe(true)
  })
})

describe('stop', () => {
  it('stops the unit of a Ticket a person stops once its invocation matches', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([nameOf(ticket)])
    expect(binding(ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'stopped' } })
  })
  it('does not stop a unit whose current invocation is not the bound one', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.rerun(nameOf(ticket))
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
    expect(binding(ticket)!.ended?.verdict).toBe('superseded')
  })
  it('does nothing for an Assignment whose unit had already ended', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { exitCode: 1, lines: [] }); await later()
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
  })
  it('stops the new unit of a Ticket stopped while its launch ran', async () => {
    await start()
    const gate = deferred()
    fake.hold = gate.promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    const result = await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    h!.runtime.engine.stopTicket(ticketId)
    fake.hold = undefined; gate.resolve()
    await h!.runtime.idle()
    expect(fake.stops).toEqual([fake.runs[0]!.name])
    expect(h!.runtime.store.tickets.get(ticketId)!.assignments[0]!.startedAt).toBeUndefined()
  })
})

describe('inputs', () => {
  it('carries the waiting Inputs, the recovery note among them, in the brief', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.cut(nameOf(ticket)); await later()
    const brief = JSON.parse(fake.runs[1]!.task) as { inputs: string[] }
    expect(brief.inputs).toEqual([expect.stringContaining('The host restarted during this ticket.')])
    expect(stored(ticket).undelivered).toEqual([])
  })
  it('leaves Inputs that arrive mid-run undelivered, and an end hands them back to Eval', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const followup = feishu('3', '@bot 还有这个', { root_id: 'om_1' })
    h!.runtime.receive(followup); await h!.runtime.idle()
    expect(stored(ticket).undelivered).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
    fake.end(nameOf(ticket)); await later(); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(h!.candidates()).toContain(followup.id)
  })
})
