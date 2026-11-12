/** The dshd executor on the simulated DSH host, with its real Store, Engine and Effects and an in-memory dshd. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, runningAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { BINDING, DshdExecutor, verdictOf } from '../src/executor/dshd.ts'
import { DshExecutor } from '../src/executor/dsh.ts'
import type { DshdConfig } from '../src/deployment.ts'
import { workerBin } from '../src/infra/environment.ts'
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
  it('lets the configured environment override a passed name, and the pair\'s environment override both', async () => {
    await start({ passEnv: ['HOME'], env: { HOME: '/srv/home', CONFIG_DIR: '/srv/config' },
      pairs: { ...PAIRS, local: { ...PAIRS.local, env: { CONFIG_DIR: '/srv/local-config', LOCAL_MODEL_KEY: 'none' } } } })
    await accepted(request('1', { cwd: directory(), pair: 'local' }))
    expect(fake.runs[0]!.env).toEqual({ HOME: '/srv/home', CONFIG_DIR: '/srv/local-config', LOCAL_MODEL_KEY: 'none' })
  })
  it('gives a unit this process\'s PATH without the worker shims Setup put on it', async () => {
    await start({ passEnv: ['PATH'] })
    // The fixture deployment names a repository, so Setup ran the in-process path and put its shim directory on PATH.
    expect(process.env.PATH!.split(delimiter)).toContain(workerBin(h!.directory))
    await accepted(request('1', { cwd: directory() }))
    expect(fake.runs[0]!.env.PATH).toBeDefined()
    expect(fake.runs[0]!.env.PATH!.split(delimiter)).not.toContain(workerBin(h!.directory))
    expect(h!.runtime.executor).toMatchObject({ needsAccount: false, workerEnvironment: 'own' })
  })
  it('runs the pair the Trigger names, else the default pair, and labels the unit with it, keeping only superagent labels of the Trigger', async () => {
    await start()
    await accepted(request('1', { cwd: directory(), pair: 'local', labels: { 'superagent.run': 'r1', 'superagent.node': 'n2', other: 'x', 'superagent.ticket': 'forged',
      'superagent.edge': 'v'.repeat(256), 'superagent.long': 'v'.repeat(257), 'superagent.lines': 'one\ntwo' } }))
    await accepted(request('5', { cwd: directory() }))
    expect(fake.runs.map(recipe => [recipe.profile, recipe.labels['superagent.pair']])).toEqual([['work-local', 'local'], ['work-opus', 'opus']])
    expect(fake.runs[0]!.labels).toMatchObject({ 'superagent.run': 'r1', 'superagent.node': 'n2', 'superagent.edge': 'v'.repeat(256) })
    expect(fake.runs[0]!.labels).not.toHaveProperty('other')
    // A value dshd could not carry as one --label argument, longer than 256 characters or over two lines, is left out.
    expect(fake.runs[0]!.labels).not.toHaveProperty('superagent.long')
    expect(fake.runs[0]!.labels).not.toHaveProperty('superagent.lines')
    expect(fake.runs[0]!.labels['superagent.ticket']).not.toBe('forged')
  })
  it('runs the default pair for a Trigger whose meta.pair is empty, as for one that names none', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory(), pair: '' }))
    expect(fake.runs.map(recipe => [recipe.profile, recipe.labels['superagent.pair']])).toEqual([['work-opus', 'opus']])
    expect(binding(ticket)).toMatchObject({ pair: 'opus', state: 'running' })
    expect(latestAssignment(stored(ticket))!.report).toBeUndefined()
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
  it('runs a Ticket whose Trigger names a relative directory in the configured cwd, and finds no pair on an object\'s prototype', async () => {
    const configured = directory()
    await start({ cwd: configured })
    await accepted(request('1', { cwd: 'relative/agency' }))
    expect(fake.runs[0]!.cwd).toBe(configured)
    const inherited = await accepted(request('5', { cwd: directory(), pair: 'constructor' }))
    await later()
    expect(fake.runs).toHaveLength(1)
    expect(latestAssignment(stored(inherited.ticket))!.report).toMatchObject({ state: 'failed', summary: 'unknown pair constructor' })
  })
  it('ignores a launch row of an Assignment that already runs, so its unit is neither run again nor stopped', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    h!.runtime.effects.enqueue('launch', id, { ticketId: ticket.id, assignmentId: id })
    await later()
    expect(fake.runs).toHaveLength(1)
    expect(fake.stops).toEqual([])
    expect(binding(ticket)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
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
  it('measures the brief in bytes of UTF-8, as Linux limits one argument: a CJK brief within briefArgvMaxChars characters goes to the file, a longer ASCII one stays inline', async () => {
    await start({ briefArgvMaxChars: 2000 })
    const cjk = await accepted({ ...request('1', { cwd: directory() }), text: `@bot ${'整理日志。'.repeat(150)}` })
    const ascii = await accepted({ ...request('5', { cwd: directory() }), text: `@bot ${'Tidy logs. '.repeat(90)}` })
    const run = (ticket: Ticket) => fake.runs.find(recipe => recipe.labels['superagent.ticket'] === ticket.id)!
    const file = join(h!.directory, 'briefs', `${stored(cjk.ticket).assignments[0]!.id}.json`)
    expect(run(cjk.ticket).task).toBe(`Read and follow the task in ${file}.`)
    const written = readFileSync(file, 'utf8')
    expect(written.length).toBeLessThanOrEqual(2000)
    expect(Buffer.byteLength(written)).toBeGreaterThan(2000)
    const inline = run(ascii.ticket).task
    expect(JSON.parse(inline)).toMatchObject({ ticket_id: ascii.ticket.id })
    expect(inline.length).toBeGreaterThan(written.length)
    expect(Buffer.byteLength(inline)).toBeLessThanOrEqual(2000)
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
    // A launch from before the start runs again once dshd.resumeDelaySeconds have passed.
    expect(fake.runs).toHaveLength(1)
    await later()
    const [ticket] = h!.runtime.store.tickets.list()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(fake.instances.size).toBe(1)
    expect(binding(ticket!)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
    expect(runningAssignment(stored(ticket!))?.id).toBe(stored(ticket!).assignments[0]!.id)
    gate.resolve()
  })
  it('re-runs a launch a crash cut off with its frozen recipe even when the configuration changed before the restart', async () => {
    await start()
    fake.hold = deferred().promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    await h!.restart({ executor: 'dshd', dshd: testDshd({ pairs: { opus: { profile: 'work-opus-next', env: { ADDED: '1' } } }, defaultPair: 'opus',
      args: ['--approval-policy', 'on-request'] }) })
    fake.hold = undefined
    await later()
    const [ticket] = h!.runtime.store.tickets.list()
    // The new profile, arguments and environment apply to the next Assignment; this one keeps the recipe dshd already holds.
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(fake.instances.size).toBe(1)
    expect(binding(ticket!)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
  })
  it('re-runs a launch a crash cut off on its stored pair even when that pair left the configuration before the restart', async () => {
    await start()
    fake.hold = deferred().promise
    const trigger = request('1', { cwd: directory(), pair: 'local' })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    await h!.restart({ executor: 'dshd', dshd: testDshd({ pairs: { opus: PAIRS.opus }, defaultPair: 'opus' }) })
    fake.hold = undefined
    await later()
    const [ticket] = h!.runtime.store.tickets.list()
    // The binding was recorded before dshd run, so its pair and frozen recipe stand; looking the pair up again would refuse it.
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(binding(ticket!)).toMatchObject({ state: 'running', pair: 'local' })
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
  it('launches again afresh, with the person\'s message, a Ticket whose directory was missing once the person makes it', async () => {
    await start()
    const cwd = join(directory(), 'later')
    const { ticket } = await accepted(request('1', { cwd }))
    await later()
    expect(waitsForPerson(stored(ticket))).toBe(true)
    expect(binding(ticket)).toBeUndefined()
    mkdirSync(cwd)
    h!.runtime.receive(feishu('3', '@bot 目录建好了', { root_id: 'om_1' })); await h!.runtime.idle(); await later()
    expect(fake.runs).toHaveLength(1)
    expect(fake.runs[0]!.task).toContain('目录建好了')
    expect(stored(ticket).undelivered).toEqual([])
  })
  it('builds the recipe again when a person\'s message launches a refused launch again and dshd made no unit', async () => {
    await start()
    fake.failNext('run', 4, 'profile-unreadable')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later()
    expect(binding(ticket)).toMatchObject({ state: 'launching' })
    h!.runtime.receive(feishu('3', '@bot 配置修好了', { root_id: 'om_1' })); await h!.runtime.idle(); await later()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]!.task).toContain('配置修好了')
    expect(binding(ticket)).toMatchObject({ state: 'running', recipe: fake.runs[1] })
    expect(stored(ticket).undelivered).toEqual([])
  })
  it('tries an unavailable dshd three times, then records failed', async () => {
    await start()
    for (let i = 0; i < 4; i++) fake.failNext('run', 7, 'systemd-unavailable')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later(); await later(); await later()
    expect(fake.runs).toHaveLength(3)
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('systemd-unavailable') })
  })
  it('adopts the unit a dshd run that never answered started: the retry re-runs the frozen recipe and dshd reports already-running', async () => {
    await start()
    fake.answerNothingNext('run')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(fake.instances.size).toBe(1)
    expect(latestAssignment(stored(ticket))!.report).toBeUndefined()
    expect(runningAssignment(stored(ticket))?.id).toBe(stored(ticket).assignments[0]!.id)
    expect(binding(ticket)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
    fake.end(nameOf(ticket), { lines: runLines('session-8', 'Done.') }); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
  })
  it('records failed after three dshd runs that never answered, and stops the unit the first one started, found by its name and labels', async () => {
    await start()
    for (let i = 0; i < 3; i++) fake.answerNothingNext('run')
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    await later(); await later(); await later()
    expect(fake.runs).toHaveLength(3)
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('was stopped before it finished') })
    // No unit runs outside the orchestrator's view: a person's retry starts -a2 alone.
    expect(fake.stops).toEqual([fake.runs[0]!.name])
    expect(binding(ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'stopped' } })
    h!.runtime.engine.retryTicket(ticket.id); await later()
    expect([...fake.instances.values()].filter(unit => unit.state === 'running').map(unit => unit.recipe.name)).toEqual([nameOf(ticket, 2)])
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
    // A full pair puts the launch off without counting a failure, so its backoff and health stay those of a waiting launch.
    expect(h!.runtime.store.db.prepare("SELECT attempts FROM effect WHERE kind = 'launch' AND key = ?").get(stored(second.ticket).assignments[0]!.id))
      .toEqual({ attempts: 0 })
  })
  it('counts a launch dshd has not answered yet against its pair\'s maxWorkers', async () => {
    await start()
    const gate = deferred()
    fake.hold = gate.promise
    const first = request('1', { cwd: directory(), pair: 'local' }), second = request('5', { cwd: directory(), pair: 'local' })
    for (const trigger of [first, second]) { h!.runtime.receive(trigger); await h!.runtime.idle() }
    await h!.route({ kind: 'accept', trigger_id: first.id, title: 'One', worktree_name: 'one', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    const result = await h!.route({ kind: 'accept', trigger_id: second.id, title: 'Two', worktree_name: 'two', acknowledgement: '收到。' })
    const id = h!.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!.assignments[0]!.id
    const due = () => (h!.runtime.store.db.prepare("SELECT due FROM effect WHERE kind = 'launch' AND key = ?").get(id) as { due: number } | undefined)?.due ?? 0
    // The second launch is put off while the first one waits for dshd's answer.
    await waitUntil(() => fake.runs.length > 1 || due() > Date.now() + 1000)
    expect(fake.runs).toHaveLength(1)
    fake.hold = undefined; gate.resolve()
    await h!.runtime.idle()
    expect(fake.runs).toHaveLength(1)
  })
  it('holds the slot of a stopped Ticket\'s unit until its stop records the unit\'s end', async () => {
    await start()
    const one = await accepted(request('1', { cwd: directory(), pair: 'local' }))
    await accepted(request('5', { cwd: directory(), pair: 'local' }))
    expect(fake.runs).toHaveLength(1)
    // dshd stop waits for dsh to exit (systemctl stop), and fails while dshd is unavailable.
    const stop = fake.stop.bind(fake)
    fake.stop = async name => { await new Promise(resolve => setTimeout(resolve, 50)); return stop(name) }
    fake.failNext('stop', 7, 'systemd-unavailable')
    const seen: number[] = []
    const run = fake.run.bind(fake)
    fake.run = async recipe => { seen.push([...fake.instances.values()].filter(unit => unit.state === 'running').length); return run(recipe) }
    h!.runtime.engine.stopTicket(one.ticket.id)
    await h!.runtime.idle()
    expect(fake.runs).toHaveLength(1)
    await later(); await later()
    expect(fake.stops).toEqual([nameOf(one.ticket)])
    expect(fake.runs).toHaveLength(2)
    expect(seen).toEqual([0])
  })
  it('holds the slot of a unit an unanswered launch may have started until its stop records the unit\'s end', async () => {
    await start()
    for (let i = 0; i < 3; i++) fake.answerNothingNext('run')
    const one = await accepted(request('1', { cwd: directory(), pair: 'local' }))
    await later()
    // The stop of the unit the first run started fails once while dshd is unavailable, so the unit may still run.
    fake.failNext('stop', 7, 'systemd-unavailable')
    await later()
    expect(latestAssignment(stored(one.ticket))!.report).toMatchObject({ state: 'failed' })
    expect(fake.stops).toEqual([])
    const seen: number[] = []
    const run = fake.run.bind(fake)
    fake.run = async recipe => { seen.push([...fake.instances.values()].filter(unit => unit.state === 'running').length); return run(recipe) }
    await accepted(request('5', { cwd: directory(), pair: 'local' }))
    expect(seen).toEqual([])
    await later(); await later()
    expect(fake.stops).toEqual([nameOf(one.ticket)])
    expect(seen).toEqual([0])
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
    // Even a watch that still finds the older unit's binding running leaves the newer Assignment alone: the Engine hears of an
    // end only for the Assignment that runs the Ticket.
    const older = stored(ticket).assignments[0]!.id
    h!.runtime.store.set(BINDING(older), { ...h!.runtime.store.get(BINDING(older))!, state: 'running' })
    h!.runtime.effects.enqueue('dshd-watch', older, { ticketId: ticket.id, assignmentId: older })
    await later()
    expect(runningAssignment(stored(ticket))?.id).toBe(stored(ticket).assignments[1]!.id)
    expect(stored(ticket).assignments[1]!.report).toBeUndefined()
    expect(h!.runtime.store.get(BINDING(older))!.state).toBe('ended')
  })
  it('relays a worker_report to the main Session for each settled unit', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { lines: runLines('session-3', 'Done.') }); await later()
    expect(reports()).toEqual([expect.objectContaining({ kind: 'worker_report', state: 'ready', summary: 'Done.', unit: nameOf(ticket), session: 'session-3' })])
  })
  it('records the end of a unit whose Ticket a person stopped while it was watched, and neither reports nor retries', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    // The watch has read how the unit ended and waits for its journal when the person stops the Ticket.
    const gate = deferred()
    let reading = false
    const read = fake.read.bind(fake)
    fake.read = async name => { reading = true; await gate.promise; return read(name) }
    fake.end(nameOf(ticket), { lines: runLines('session-4', 'Done.') })
    skew += 10 * 60_000
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
    try { await h!.runtime.pump(); await waitUntil(() => reading) } finally { vi.useRealTimers() }
    h!.runtime.engine.stopTicket(ticket.id)
    await waitUntil(() => binding(ticket)!.state === 'ended')
    const stopped = binding(ticket)
    gate.resolve()
    await h!.runtime.idle()
    expect(stored(ticket).ended).toBeDefined()
    expect(latestAssignment(stored(ticket))!.report).toBeUndefined()
    expect(reports()).toEqual([])
    expect(h!.runtime.effects.pending('dshd-watch', id)).toBe(false)
    // The stop recorded the end; the watch that resumed after it left that record as it was.
    expect(binding(ticket)).toEqual(stopped)
    expect(binding(ticket)!.sessionId).toBeUndefined()
  })
  it('settles a unit once when its watch handler runs twice', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    fake.end(nameOf(ticket), { lines: runLines('session-5', 'Done.') }); await later()
    const settled = binding(ticket)
    expect(settled).toMatchObject({ state: 'ended', sessionId: 'session-5' })
    // The queue runs the watch again, as after a crash between the settlement's commit and the row's removal.
    const dshdCalls = () => h!.subprocess.spawn.mock.calls.filter(([spec]) => spec.argv.includes('dshd')).length
    const calls = dshdCalls()
    h!.runtime.effects.enqueue('dshd-watch', id, { ticketId: ticket.id, assignmentId: id })
    await later()
    expect(dshdCalls()).toBe(calls)
    expect(reports()).toHaveLength(1)
    expect(binding(ticket)).toEqual(settled)
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'Done.' })
  })
  it('keeps the unit\'s binding running when its settlement fails, and settles it once on the next try', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    vi.spyOn(h!.runtime.engine, 'report').mockImplementationOnce(() => { throw new Error('database is busy') })
    fake.end(nameOf(ticket), { lines: runLines('session-8', 'Done.') })
    await later()
    // The end, the report and the relay commit together or not at all: the watch tries again.
    expect(binding(ticket)!.state).toBe('running')
    expect(latestAssignment(stored(ticket))!.report).toBeUndefined()
    expect(h!.runtime.effects.pending('dshd-watch', stored(ticket).assignments[0]!.id)).toBe(true)
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-8' })
    expect(reports()).toHaveLength(1)
  })
  it('caps the answer of a unit that did not complete in its summary, and keeps a completed unit\'s answer whole', async () => {
    await start()
    const failed = await accepted(request('1', { cwd: directory() }))
    const done = await accepted(request('5', { cwd: directory() }))
    const long = 'x'.repeat(5000)
    fake.end(nameOf(failed.ticket), { exitCode: 1, lines: runLines('session-1', long) })
    fake.end(nameOf(done.ticket), { lines: runLines('session-2', long) })
    await later()
    const name = nameOf(failed.ticket)
    expect(latestAssignment(stored(failed.ticket))!.report!.summary).toBe(`Unit ${name} ended task-failed (exit 1).\n\n${'x'.repeat(3800)}…\n\nUnit ${name}; session session-1.`)
    expect(latestAssignment(stored(done.ticket))!.report!.summary).toBe(long)
  })
  it('settles a unit whose launch answer named no invocation on the invocation dshd get reports', async () => {
    await start()
    const run = fake.run.bind(fake)
    // dshd may answer run --bg before systemd has named the unit's invocation.
    fake.run = async recipe => { const result = await run(recipe); return 'refused' in result ? result : { ...result, invocationId: null, lastRun: null } }
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    expect(binding(ticket)).toMatchObject({ state: 'running', invocationId: 'invocation-1' })
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') }); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(latestAssignment(stored(ticket))!.report!.summary).toBe('Done.')
  })
  it('takes neither the end nor the answer of a run someone started under the unit\'s name while it was watched', async () => {
    await start()
    const waited = await accepted(request('1', { cwd: directory() }))
    const read = await accepted(request('5', { cwd: directory() }))
    const wait = fake.wait.bind(fake), journal = fake.read.bind(fake)
    // While the watch waits on the first unit, its run ends and someone reruns it to an end of its own.
    fake.wait = async name => {
      if (name === nameOf(waited.ticket)) { fake.end(name); fake.rerun(name); fake.end(name, { lines: runLines('session-x', 'Someone else\'s answer.') }) }
      return wait(name)
    }
    // Between the second unit's end and the read of its journal, someone reruns it.
    fake.read = async name => {
      if (name === nameOf(read.ticket) && fake.instances.get(name)!.lastRun.invocationId === binding(read.ticket)!.invocationId) {
        fake.rerun(name); fake.end(name, { lines: runLines('session-y', 'Someone else\'s answer.') })
      }
      return journal(name)
    }
    fake.end(nameOf(read.ticket), { lines: runLines('session-2', 'Mine.') })
    await later()
    expect(stored(waited.ticket).ended).toBeUndefined()
    expect(latestAssignment(stored(waited.ticket))!.report!.summary).toContain('ended superseded.')
    // The second unit's own run exited 0, so its Ticket completes, without the other run's answer or Session.
    expect(latestAssignment(stored(read.ticket))!.report).toMatchObject({ state: 'ready', summary: `Unit ${nameOf(read.ticket)} exited 0.` })
    expect(binding(read.ticket)!.sessionId).toBeUndefined()
  })
  it('leaves a unit another orchestrator labels alone: stopping its Ticket stops nothing, and its end settles only as superseded', async () => {
    await start()
    const stopped = await accepted(request('1', { cwd: directory() }))
    const watched = await accepted(request('5', { cwd: directory() }))
    for (const { ticket } of [stopped, watched]) fake.instances.get(nameOf(ticket))!.recipe.labels['superagent.orchestrator'] = 'another-orchestrator'
    h!.runtime.engine.stopTicket(stopped.ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
    expect(binding(stopped.ticket)!.ended?.verdict).toBe('superseded')
    fake.end(nameOf(watched.ticket), { lines: runLines('session-x', 'Another orchestrator\'s answer.') }); await later()
    expect(stored(watched.ticket).ended).toBeUndefined()
    expect(latestAssignment(stored(watched.ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('ended superseded.') })
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
  it('settles a unit that ended while the orchestrator was down on the first pass after restart, with no new unit', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { lines: runLines('session-6', 'Finished meanwhile.') })
    await h!.restart()
    await h!.runtime.idle()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'Finished meanwhile.' })
    expect(stored(ticket).assignments).toHaveLength(1)
    expect(fake.runs).toHaveLength(1)
    expect(binding(ticket)).toMatchObject({ state: 'ended', invocationId: 'invocation-1', sessionId: 'session-6' })
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
    // The restart's new Assignment resumes work from before the start, so it waits for dshd.resumeDelaySeconds too.
    expect(fake.runs).toEqual([])
    await later()
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
  it('does not launch again on restart an Assignment whose launch failed and waits for a person', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory(), pair: 'gpu' }))
    const report = latestAssignment(stored(ticket))!.report
    expect(report).toMatchObject({ state: 'failed', summary: 'unknown pair gpu' })
    await h!.restart(); await h!.runtime.idle(); await later()
    expect(latestAssignment(stored(ticket))!.report).toEqual(report)
    expect(reports()).toHaveLength(1)
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

describe('unattended starts', () => {
  /** Time moves on by `ms` from now, not by the file's growing skew: effects due by then run. */
  async function after(ms: number): Promise<void> {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
    try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
  }
  /** Accepts each request while processing is paused, so each Ticket's Assignment waits pending, as for a floor that was stopped. */
  async function waiting(...triggers: Trigger[]): Promise<Ticket[]> {
    for (const trigger of triggers) { h!.runtime.receive(trigger); await h!.runtime.idle() }
    await h!.runtime.settings.pause(true, 'panel')
    const tickets: Ticket[] = []
    for (const trigger of triggers) {
      const result = await h!.route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: `fix-${tickets.length + 1}`, acknowledgement: '收到。' })
      tickets.push(h!.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!)
    }
    return tickets
  }
  const worker = () => h!.runtime.health.worker?.detail

  it('holds the launch of work from before a start for dshd.resumeDelaySeconds, never launches a Ticket a person stopped meanwhile, and launches new work at once', async () => {
    await start({ resumeDelaySeconds: 300 })
    const [one, two] = await waiting(request('1', { cwd: directory() }), request('5', { cwd: directory() }))
    await h!.restart()
    await h!.runtime.settings.pause(false, 'panel')
    await after(60_000)
    expect(fake.runs).toEqual([])
    expect(worker()).toMatch(/^2 Assignments from before the start launch at \d\d:\d\d$/)
    // A Ticket created after the start, as a Scheduled occurrence's at midnight, launches at once.
    const fresh = await accepted(request('9', { cwd: directory(), pair: 'opus' }))
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).toEqual([fresh.ticket.id])
    h!.runtime.engine.stopTicket(one!.id); await h!.runtime.idle()
    await after(4 * 60_000)
    expect(fake.runs).toHaveLength(1)
    await after(6 * 60_000)
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).toEqual([fresh.ticket.id, two!.id])
    expect(binding(one!)).toBeUndefined()
    expect(stored(one!).ended?.outcome).toBe('stopped')
    expect(worker()).toBe('No Assignment from before the start waits to launch')
  })
  it('launches at once after a start with dshd.resumeDelaySeconds 0, as upstream resumes', async () => {
    await start({ resumeDelaySeconds: 0 })
    const [one] = await waiting(request('1', { cwd: directory() }))
    await h!.restart()
    await h!.runtime.settings.pause(false, 'panel')
    await after(10_000)
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).toEqual([one!.id])
    expect(worker()).toBeUndefined()
  })
  it('records failed, not launched, work from before a start older than dshd.resumeMaxAgeHours, unless its launch was under way; a retry launches at once', async () => {
    await start({ resumeMaxAgeHours: 1 })
    const cut = request('1', { cwd: directory() }), waited = request('5', { cwd: directory() })
    for (const trigger of [cut, waited]) { h!.runtime.receive(trigger); await h!.runtime.idle() }
    // One launch is under way when the floor stops, so dshd may run its unit: it runs its frozen recipe again whatever its age.
    fake.hold = deferred().promise
    await h!.route({ kind: 'accept', trigger_id: cut.id, title: 'Fix', worktree_name: 'fix-cut', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    await h!.runtime.settings.pause(true, 'panel')
    const result = await h!.route({ kind: 'accept', trigger_id: waited.id, title: 'Old', worktree_name: 'fix-old', acknowledgement: '收到。' })
    const old = h!.runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)
    await h!.restart()
    fake.hold = undefined
    await h!.runtime.settings.pause(false, 'panel')
    await after(2 * 3_600_000)
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]).toEqual(fake.runs[0])
    expect(binding(old!)).toBeUndefined()
    expect(latestAssignment(stored(old!))!.report).toMatchObject({ state: 'failed',
      summary: 'Not launched after the restart: this work waited 2 h, longer than dshd.resumeMaxAgeHours (1 h). Retry the ticket to launch it.' })
    expect(waitsForPerson(stored(old!))).toBe(true)
    h!.runtime.engine.retryTicket(old!.id); await h!.runtime.idle()
    expect(fake.runs.at(-1)!.name).toBe(nameOf(old!, 2))
  })
  it('settles as lost, freeing the slot, a unit dshd reports orphaned at once, and one masked after dshd.uncertainWatchLimit looks', async () => {
    await start({ uncertainWatchLimit: 3 })
    const masked = await accepted(request('1', { cwd: directory(), pair: 'local' }))
    const next = await accepted(request('5', { cwd: directory(), pair: 'local' }))
    const orphaned = await accepted(request('9', { cwd: directory() }))
    fake.instances.get(nameOf(masked.ticket))!.state = 'masked'
    fake.instances.get(nameOf(orphaned.ticket))!.state = 'orphaned'
    await later()
    expect(binding(orphaned.ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'lost' } })
    expect(latestAssignment(stored(orphaned.ticket))!.report).toMatchObject({ state: 'failed', summary: expect.stringMatching(/^Unit \S+ ended lost\./) })
    expect(binding(masked.ticket)!.state).toBe('running')
    await later()
    expect(binding(masked.ticket)!.state).toBe('running')
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).not.toContain(next.ticket.id)
    await later(); await later()
    expect(binding(masked.ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'lost' } })
    expect(waitsForPerson(stored(masked.ticket))).toBe(true)
    expect(fake.runs.map(recipe => recipe.labels['superagent.ticket'])).toContain(next.ticket.id)
    expect(fake.stops).toEqual([])
  })
  it('leaves PATH entries under /nix/store out of every unit\'s environment, and says so once in the log', async () => {
    const path = process.env.PATH
    try {
      await start({ passEnv: ['PATH'] })
      const warn = vi.spyOn(h!.ctx.logger, 'warn')
      process.env.PATH = [workerBin(h!.directory), '/nix/store/0aaa-coreutils/bin', '/usr/local/bin', '/nix/store/1bbb-git/bin',
        '/etc/profiles/per-user/agent/bin'].join(delimiter)
      await accepted(request('1', { cwd: directory() }))
      await accepted(request('5', { cwd: directory() }))
      expect(fake.runs.map(recipe => recipe.env.PATH)).toEqual(Array(2).fill(['/usr/local/bin', '/etc/profiles/per-user/agent/bin'].join(delimiter)))
      const logged = warn.mock.calls.filter(args => String(args[0]).includes('/nix/store'))
      expect(logged).toEqual([[expect.stringContaining('give this process a PATH of profile links'), '/nix/store/0aaa-coreutils/bin:/nix/store/1bbb-git/bin']])
    } finally { process.env.PATH = path }
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
  it('does not stop a unit whose binding another host made', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    h!.runtime.store.set(BINDING(id), { ...binding(ticket)!, host: 'another-host' })
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
    expect(binding(ticket)!.state).toBe('running')
    expect(h!.runtime.effects.pending('dshd-stop', id)).toBe(true)
  })
  it('records how a unit that ended before its Ticket was stopped ended, and stops nothing', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') })
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(fake.stops).toEqual([])
    expect(binding(ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'completed' } })
  })
  it('records a unit dshd cannot tell about as lost when its Ticket is stopped, and stops nothing', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.instances.get(nameOf(ticket))!.state = 'inconsistent'
    h!.runtime.engine.stopTicket(ticket.id)
    await waitUntil(() => binding(ticket)!.state === 'ended')
    expect(fake.stops).toEqual([])
    // An ended binding holds a final verdict: 'unknown' is what keeps a running Assignment, never how a unit ended.
    expect(binding(ticket)!.ended?.verdict).toBe('lost')
  })
  it('keeps the end a watch recorded while dshd stop had not answered yet', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const id = stored(ticket).assignments[0]!.id
    const gate = deferred()
    let stopping = false
    const stop = fake.stop.bind(fake)
    fake.stop = async name => { stopping = true; await gate.promise; return stop(name) }
    h!.runtime.engine.stopTicket(ticket.id)
    void h!.runtime.pump()
    await waitUntil(() => stopping)
    // The unit ends on its own, and its watch records how before the stop returns.
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') })
    h!.runtime.effects.enqueue('dshd-watch', id, { ticketId: ticket.id, assignmentId: id })
    await waitUntil(() => binding(ticket)!.state === 'ended')
    gate.resolve()
    await h!.runtime.idle()
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-1', ended: { verdict: 'completed', exitCode: 0 } })
  })
  it('stops the unit of a launch a crash cut off when its Ticket is stopped before the launch runs again', async () => {
    await start()
    fake.hold = deferred().promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    const result = await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    // Processing stays paused across the restart, so the launch is not retried before the person's stop.
    await h!.runtime.settings.pause(true, 'panel')
    await h!.restart()
    fake.hold = undefined
    const [unbound] = h!.runtime.store.tickets.list()
    expect(binding(unbound!)).toMatchObject({ state: 'launching' })
    expect(binding(unbound!)!.invocationId).toBeUndefined()
    h!.runtime.engine.stopTicket(ticketId); await h!.runtime.idle()
    // The binding names no invocation yet: the unit is this Assignment's by its label.
    expect(fake.stops).toEqual([fake.runs[0]!.name])
    expect(binding(unbound!)).toMatchObject({ state: 'ended', ended: { verdict: 'stopped' } })
    await h!.runtime.settings.pause(false, 'panel'); await later()
    expect(fake.runs).toHaveLength(1)
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
  it('stops the unit of a Ticket stopped while dshd did not answer its launch, without trying the launch again', async () => {
    await start()
    const gate = deferred()
    fake.hold = gate.promise
    fake.answerNothingNext('run')
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    const result = await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    h!.runtime.engine.stopTicket(ticketId)
    fake.hold = undefined; gate.resolve()
    await h!.runtime.idle()
    expect(fake.stops).toEqual([fake.runs[0]!.name])
    expect(fake.runs).toHaveLength(1)
    expect(h!.runtime.store.get(BINDING(h!.runtime.store.tickets.get(ticketId)!.assignments[0]!.id))).toMatchObject({ state: 'ended', ended: { verdict: 'stopped' } })
  })
  it('stops the unit of a Ticket stopped while its launch ran, when a restart cut that launch before dshd answered', async () => {
    await start()
    fake.hold = deferred().promise
    const trigger = request('1', { cwd: directory() })
    h!.runtime.receive(trigger); await h!.runtime.idle()
    const result = await h!.route({ kind: 'accept', trigger_id: trigger.id, title: 'Fix', worktree_name: 'fix-regression', acknowledgement: '收到。' })
    await waitUntil(() => fake.runs.length === 1)
    const ticketId = (result.ticket as { ticket_id: string }).ticket_id
    h!.runtime.engine.stopTicket(ticketId)
    // The stop has run and left the unit to the launch under way.
    await h!.runtime.effects.idle('dshd-stop')
    expect(h!.runtime.effects.pending('dshd-stop')).toBe(false)
    await h!.restart()
    fake.hold = undefined
    await h!.runtime.idle()
    expect(fake.stops).toEqual([fake.runs[0]!.name])
    expect(fake.runs).toHaveLength(1)
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
  /** A second Ticket of the one-slot pair takes a person's follow-up into its first brief while it waits for the slot. */
  async function followedUp() {
    const first = await accepted(request('1', { cwd: directory(), pair: 'local' }))
    const second = await accepted(request('5', { cwd: directory(), pair: 'local' }))
    h!.runtime.receive(feishu('7', '@bot 记得用分支 hotfix', { root_id: 'om_5' })); await h!.runtime.idle()
    fake.end(nameOf(first.ticket)); await later(); await later()
    expect(fake.runs).toHaveLength(2)
    expect(fake.runs[1]!.task).toContain('hotfix')
    return second.ticket
  }
  it('gives a recovery unit the Inputs the cut unit\'s brief carried, without repeating them as delivered', async () => {
    await start()
    const ticket = await followedUp()
    fake.cut(nameOf(ticket)); await later(); await later()
    expect(fake.runs).toHaveLength(3)
    const brief = JSON.parse(fake.runs[2]!.task) as { earlier_inputs: string[]; inputs: string[] }
    expect(brief.earlier_inputs).toEqual([expect.stringContaining('hotfix')])
    expect(brief.inputs).toEqual([expect.stringContaining('The host restarted during this ticket.')])
    expect(binding(ticket, 2)!.inputIds).toHaveLength(1)
    // A second cut carries the person's line again, and not the first recovery note.
    fake.cut(nameOf(ticket, 2)); await later(); await later()
    const third = JSON.parse(fake.runs[3]!.task) as { earlier_inputs: string[] }
    expect(third.earlier_inputs).toEqual([expect.stringContaining('hotfix')])
  })
  it('gives a retried unit the Inputs earlier units\' briefs carried', async () => {
    await start()
    const ticket = await followedUp()
    fake.end(nameOf(ticket), { exitCode: 2, lines: [] }); await later()
    h!.runtime.engine.retryTicket(ticket.id); await h!.runtime.idle(); await later()
    expect(fake.runs).toHaveLength(3)
    const brief = JSON.parse(fake.runs[2]!.task) as { earlier_inputs: string[]; retried: string }
    expect(brief.earlier_inputs).toEqual([expect.stringContaining('hotfix')])
    expect(brief.retried).toContain('A person retried this ticket.')
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
  it('counts the Inputs a brief carries as read, so the Ticket\'s end does not hand them back to Eval', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const followup = feishu('3', '@bot 还有这个', { root_id: 'om_1' })
    h!.runtime.receive(followup); await h!.runtime.idle()
    fake.cut(nameOf(ticket)); await later()
    // The second unit's brief carries the follow-up the first never saw.
    expect(JSON.parse(fake.runs[1]!.task).inputs.join('\n')).toContain('还有这个')
    fake.end(nameOf(ticket, 2)); await later(); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(h!.candidates()).not.toContain(followup.id)
  })
  it('tells the unit of a Ticket a person retried that it was retried', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    fake.end(nameOf(ticket), { exitCode: 1, lines: [] }); await later()
    h!.runtime.engine.retryTicket(ticket.id); await later()
    const briefs = fake.runs.map(recipe => JSON.parse(recipe.task) as { attempt: number; retried?: string })
    expect(briefs.map(brief => [brief.attempt, brief.retried])).toEqual([[1, undefined],
      [2, 'A person retried this ticket. Continue the assignment from the current directory and what it holds now.']])
  })
  it('tells the main Session that a note or an attach reaches a unit only through the brief of a later launch', async () => {
    await start()
    const { ticket } = await accepted(request('1', { cwd: directory() }))
    const noted = await h!.runTool(h!.runtime.masterId, 'orchestrator_ticket_note', { ticket_id: ticket.id, text: 'Ticket B renamed the setting.' })
    expect(noted.reason).toMatch(/^Recorded\. .*reads only its brief.*next launch.*does not reach a worker already running\.$/)
    const other = request('2', { cwd: directory() })
    h!.runtime.receive(other); await h!.runtime.idle()
    const attached = await h!.route({ kind: 'attach', ticket_id: ticket.id, trigger_id: other.id })
    expect(attached.reason).toMatch(/^Attached: .*reads only its brief.*does not receive it, and its end hands the trigger back to Eval\.$/)
    expect(fake.runs).toHaveLength(1)
  })
})
