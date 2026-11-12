/** dshd's outcomes as the dshd executor reads them: lines dshd 0.1.0 printed, its documented states and refusals, and each answer. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { DshdCli, DshdUnavailable, invocationOf, type DshdLastRun, type DshdRecipe } from '../src/executor/dshd-cli.ts'
import { BINDING, eventsOf, unitName, usageOf, verdictOf, type Verdict } from '../src/executor/dshd.ts'
import { testDshd } from './fixtures/deployment.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import { GET_EXITED, READ_JSON_RUN, READ_LINES, RUN_CREATED, WAIT_ENDED_EXITED, WAIT_ENDED_FAILED, WAIT_STILL_RUNNING } from './fixtures/dshd-0.1.0.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

/** A subprocess service whose every command exits with `exitCode`, printing `stdout` and `stderr`, as in tests/dshd-cli.spec.ts. */
function answering(stdout = '', stderr = '', exitCode: number | null = 0) {
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return { spawn: vi.fn(() => ({ done: Promise.resolve({ exitCode, signal: null }), collected: { stdout: reader(stdout), stderr: reader(stderr) } })) }
}
const cli = (subprocess: ReturnType<typeof answering>) => new DshdCli(subprocess as never, 'dshd')
const signal = new AbortController().signal
const refusal = (kind: string, message = `refused: ${kind}`) => JSON.stringify({ error: { kind, message, hint: null } })
const recipe: DshdRecipe = { name: 'sa-fix-a1', cwd: '/srv/agency', labels: {}, profile: 'work-opus', args: [], task: 'Reply with READY.', env: {} }
/** The `lastRun` of a status, as `DshdCli` keeps it. */
const run = (ending: DshdLastRun['ending'], child: DshdLastRun['child'] = null): DshdLastRun => ({ invocationId: 'invocation-1', ending, endedAt: 1, child })

describe('dshd 0.1.0 output (captured 12 Nov)', () => {
  it('reads the created outcome of dshd run --bg --json as a launch of a running unit, with its invocation and instance', async () => {
    const launched = await cli(answering(RUN_CREATED)).run(recipe, signal)
    expect(launched).toMatchObject({ outcome: 'created', id: '27e75458-14be-4037-b2f9-fe004c2c4b12', state: 'running',
      invocationId: 'e8e5e47b097e4a8493e28d8a940eb779', labels: {}, lastRun: { invocationId: 'e8e5e47b097e4a8493e28d8a940eb779', ending: null, child: null } })
    expect(verdictOf(launched as never)).toBe('running')
  })
  it('settles an ended unit on its last run\'s invocation, since dshd clears the top-level one once the task exits 0', async () => {
    for (const [line, invocation] of [[GET_EXITED, 'f72771583e9a465d810ef7da34505aa6'], [WAIT_ENDED_EXITED, '62a66e72bc4a4ff987385901f954a42a']] as const) {
      const status = await cli(answering(line)).get('sa-fix-a1', signal)
      if (status === 'not-found') throw new Error('not found')
      expect(status).toMatchObject({ state: 'stopped', invocationId: null, lastRun: { invocationId: invocation, ending: 'exited', child: { exitCode: 0 } } })
      expect(invocationOf(status)).toBe(invocation)
      // The last run's own `exitCode` is systemd's word ("exited"); only the child's is dsh's exit code.
      expect(verdictOf(status)).toBe('completed')
    }
    expect(await cli(answering(WAIT_ENDED_EXITED)).wait('sa-fix-a1', 30, signal)).toEqual({ outcome: 'ended', exitCode: 0, signal: null, reason: 'dsh exited with status 0' })
  })
  it('reads a task that exited 1 as task-failed of the invocation its launch bound', async () => {
    expect(await cli(answering(WAIT_ENDED_FAILED)).wait('sa-fix-a1', 30, signal)).toEqual({ outcome: 'ended', exitCode: 1, signal: null, reason: 'dsh exited with status 1' })
    const status = await cli(answering(WAIT_ENDED_FAILED)).get('sa-fix-a1', signal)
    const launched = await cli(answering(RUN_CREATED)).run(recipe, signal)
    if (status === 'not-found' || 'refused' in launched) throw new Error('not read')
    expect(status).toMatchObject({ state: 'failed', lastRun: { ending: 'failed', child: { exitCode: 1 } } })
    expect(verdictOf(status)).toBe('task-failed')
    expect(invocationOf(status)).toBe(invocationOf(launched))
  })
  it('reads the check-in of dshd wait --json as still-running', async () => {
    expect(await cli(answering(WAIT_STILL_RUNNING)).wait('sa-fix-a1', 10, signal)).toEqual({ outcome: 'still-running' })
    expect(await cli(answering(WAIT_STILL_RUNNING, '', 124)).wait('sa-fix-a1', 10, signal)).toEqual({ outcome: 'still-running' })
  })
  it('finds no Session and no answer in the journal of a task run without --json', async () => {
    const envelope = JSON.stringify({ name: 'probe-20261112-c2', invocationId: '62a66e72bc4a4ff987385901f954a42a', complete: true, streams: ['stdout', 'stderr'], lines: READ_LINES })
    const read = await cli(answering(envelope)).read('sa-fix-a1', signal)
    expect(read).toEqual({ invocationId: '62a66e72bc4a4ff987385901f954a42a', complete: true, lines: READ_LINES })
    expect(eventsOf(read as never)).toEqual({})
  })
  it('finds the Session and the answer of a task run with --json, also in a window of its newest lines that lost the session event', async () => {
    const read = await cli(answering(READ_JSON_RUN)).read('sa-fix-a1', signal)
    if (read === 'not-found') throw new Error('not found')
    expect(read).toMatchObject({ invocationId: '1709bfd1f99d496fbd28efb7a83bac95', complete: true })
    expect(eventsOf(read)).toEqual({ sessionId: 'session-0a4a53d1-0169-42ca-a8bf-ad6731f124e6', final: 'READY' })
    // `dshd read -n 3`: the final event and dshd-run's last two lines.
    expect(eventsOf({ lines: read.lines.slice(-3) })).toEqual({ sessionId: 'session-0a4a53d1-0169-42ca-a8bf-ad6731f124e6', final: 'READY' })
  })
})

describe('a run\'s token usage', () => {
  // The usage two workers' DSH Sessions recorded on each step's assistant/message, which a headless --json run
  // prints on that step's step_end status: an OpenAI-compatible provider (totals, no cache writes) and Claude (cache writes, no total).
  const OPENAI = [{ inputTokens: 3076, outputTokens: 116, totalTokens: 8662, cacheReadTokens: 5470 },
    { inputTokens: 38, outputTokens: 1, totalTokens: 8701, cacheReadTokens: 8662 }]
  const CLAUDE = { inputTokens: 2, outputTokens: 239, cacheReadTokens: 32343, cacheWriteTokens: 372 }
  const read = (lines: string[], complete = true) => ({ invocationId: 'invocation-1', complete, lines })

  it('sums the usage every step of a whole run printed, keeping a bucket only when every step reports it', () => {
    expect(usageOf(read(runLines('session-o', 'DONE', OPENAI)))).toEqual({ inputTokens: 3114, outputTokens: 117, totalTokens: 17363, cacheReadTokens: 14132 })
    expect(usageOf(read(runLines('session-c', 'DONE', [CLAUDE])))).toEqual(CLAUDE)
    expect(usageOf(read(runLines('session-m', 'DONE', [OPENAI[0], CLAUDE])))).toEqual({ inputTokens: 3078, outputTokens: 355, cacheReadTokens: 37813 })
  })
  it('knows no usage when a step printed none, the lines do not reach back to the run\'s start, or no step ended', () => {
    expect(usageOf(read(runLines('session-o', 'DONE', [OPENAI[0], undefined])))).toBeUndefined()
    expect(usageOf(read(runLines('session-o', 'DONE', OPENAI), false))).toBeUndefined()
    expect(usageOf(read(runLines('session-o', 'DONE')))).toBeUndefined()
    expect(usageOf(read(['dshd-run: run started', JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 'many' } })]))).toBeUndefined()
  })
})

describe('dshd outcomes', () => {
  it('maps every state and last-run ending dshd 0.1.0 documents to one verdict', () => {
    const rows: [string, DshdLastRun | null, Verdict][] = [
      ['running', run(null), 'running'], ['starting', run(null), 'running'], ['stopping', run(null), 'running'],
      ['stopped', run('exited', { exitCode: 0 }), 'completed'], ['previous-boot', run('exited', { exitCode: 0 }), 'completed'],
      ['stopped', run('exited', { exitCode: 3 }), 'task-failed'], ['failed', run('failed', { exitCode: 1 }), 'task-failed'],
      ['failed', run('failed', { signal: 9 }), 'killed'], ['failed', run('failed'), 'never-ran'], ['stopped', null, 'never-ran'],
      ['stopped', run('stopped'), 'stopped'], ['stopped', run('stopped-without-intent'), 'cut'], ['failed', run('interrupted'), 'cut'],
      ['interrupted', run(null), 'cut'], ['previous-boot', run(null), 'cut'],
      ['masked', run('exited', { exitCode: 0 }), 'unknown'], ['orphaned', null, 'unknown'], ['inconsistent', run(null), 'unknown'],
    ]
    expect(rows.map(([state, lastRun]) => verdictOf({ state, lastRun }))).toEqual(rows.map(([, , verdict]) => verdict))
  })
  it('reads a refusal from stderr while stdout stays empty, and a dshd a signal ended as no answer', async () => {
    expect(await cli(answering('', refusal('invalid-name', 'names match [a-z0-9]'), 2)).run(recipe, signal))
      .toEqual({ refused: 'invalid-name', exit: 2, message: 'names match [a-z0-9]' })
    await expect(cli(answering('', '', null)).run(recipe, signal)).rejects.toThrow('dshd run sa-fix-a1 was stopped before it finished')
    for (const kind of ['systemd-unavailable', 'tool-missing', 'template-missing']) {
      await expect(cli(answering('', refusal(kind), 7)).run(recipe, signal)).rejects.toBeInstanceOf(DshdUnavailable)
    }
  })
})

describe('the dshd executor on these outcomes', () => {
  let h: Host | undefined
  const directories: string[] = []
  afterEach(async () => {
    await h?.stop(); h = undefined
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  const config = testDshd({ pairs: { opus: { profile: 'work-opus', env: {} } }, defaultPair: 'opus' })
  const request = (id: string): Trigger => {
    const trigger = feishu(id, `@bot 任务 ${id}`)
    const cwd = mkdtempSync(join(tmpdir(), 'dshd-outcome-')); directories.push(cwd)
    return { ...trigger, meta: { ...trigger.meta, cwd } }
  }
  const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
  const binding = (ticket: Ticket) => h!.runtime.store.get(BINDING(stored(ticket).assignments[0]!.id))!
  type Answer = { stdout?: string; stderr?: string; exit: number | null }
  /**
   * dshd answering each verb from a queue of what it printed, the last answer repeating, with the labels the run gave laid over
   * every status, as dshd sets them on the instance; the captured units ran without labels.
   */
  function replay(answers: Partial<Record<'run' | 'get' | 'wait' | 'read', Answer[]>>) {
    let labels: Record<string, string> = {}
    const verbs: string[] = [], calls: string[][] = []
    const spawn = (spec: { argv: readonly string[] }) => {
      const argv = [...spec.argv], at = argv.indexOf('dshd')
      if (at < 0) return undefined
      const verb = argv[at + 1] as keyof typeof answers
      verbs.push(verb); calls.push(argv.slice(at))
      if (verb === 'run') labels = Object.fromEntries(argv.flatMap((item, index) => item === '--label' ? [argv[index + 1]!.split(/=(.*)/s).slice(0, 2)] : []))
      const queue = answers[verb] ?? []
      const { stdout = '', stderr = '', exit } = (queue.length > 1 ? queue.shift() : queue[0]) ?? { stderr: refusal('not-found'), exit: 3 }
      // What is not JSON, such as the tail of an output past the subprocess service's cap, is printed as it is.
      const value = (() => { try { return stdout ? JSON.parse(stdout) as Record<string, unknown> : undefined } catch { return undefined } })()
      const printed = value && 'labels' in value ? JSON.stringify({ ...value, labels }) : stdout
      const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
      return { done: Promise.resolve({ exitCode: exit, signal: null }), collected: { stdout: reader(printed), stderr: reader(stderr) } }
    }
    return { spawn, verbs, calls }
  }
  async function accepted(dshd: ReturnType<typeof replay> | FakeDshd, trigger = request('1')) {
    if (!h) h = await startRuntime(undefined, { machine: { executor: 'dshd', dshd: config }, spawn: spec => dshd.spawn(spec) })
    return (await h.acceptedTicket(trigger)).ticket
  }

  it('settles a Ticket failed and waiting for a person from the run and wait dshd printed for a task that exited 1', async () => {
    // The journal tail the probe kept, as `-o cat` prints it: the run's first lines are gone.
    const lines = ['dsh: UNKNOWN: dsh-claude: provider claude is available only to the claude preset',
      'dsh: fatal uncaught exception: Error: cannot get required service "agentPresets" in inactive context',
      'dshd-run: dsh exited with status 1; exiting 1', 'dshd-run: run ended: exit-code']
    const dshd = replay({ run: [{ stdout: RUN_CREATED, exit: 0 }], get: [{ stdout: RUN_CREATED, exit: 0 }, { stdout: WAIT_ENDED_FAILED, exit: 0 }],
      wait: [{ stdout: WAIT_ENDED_FAILED, exit: 0 }],
      read: [{ stdout: JSON.stringify({ name: 'probe-20261112-c1', invocationId: 'e8e5e47b097e4a8493e28d8a940eb779', complete: false, streams: ['stdout', 'stderr'], lines }), exit: 0 }] })
    const ticket = await accepted(dshd)
    const { name } = binding(ticket)
    // The tail names no Session and does not reach back to the run's start, so the run is read again for a longer stretch.
    expect(dshd.verbs).toEqual(['run', 'get', 'wait', 'get', 'read', 'read'])
    expect(binding(ticket)).toMatchObject({ state: 'ended', instanceId: '27e75458-14be-4037-b2f9-fe004c2c4b12', invocationId: 'e8e5e47b097e4a8493e28d8a940eb779',
      ended: { verdict: 'task-failed', exitCode: 1, ending: 'failed' } })
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: `Unit ${name} ended task-failed (exit 1).\n\nUnit ${name}; session unknown.` })
    expect(stored(ticket).ended).toBeUndefined()
    expect(waitsForPerson(stored(ticket))).toBe(true)
  })
  it('binds a unit dshd reports had already run on its last run\'s invocation, and settles it completed from the status dshd printed', async () => {
    const lines = ['dshd-run: run started', 'dshd-run: started dsh as pid 1684262 from /nix/store/db86dyhw6qhc18m21bv5i4mj1ha0jk9y-dshd-release-dsh-0.2.2-rc.1',
      'READY', 'dshd-run: dsh exited with status 0; exiting 0', 'dshd-run: run ended: success']
    // The refusal's shape is the one dshd prints for every error; its message text was not captured.
    const dshd = replay({ run: [{ stderr: refusal('task-already-ran'), exit: 4 }], get: [{ stdout: GET_EXITED, exit: 0 }],
      read: [{ stdout: JSON.stringify({ name: 'probe-20261112-g4', invocationId: 'f72771583e9a465d810ef7da34505aa6', complete: true, streams: ['stdout', 'stderr'], lines }), exit: 0 }] })
    const ticket = await accepted(dshd)
    const { name } = binding(ticket)
    expect(dshd.verbs).toEqual(['run', 'get', 'get', 'read'])
    expect(binding(ticket)).toMatchObject({ state: 'ended', invocationId: 'f72771583e9a465d810ef7da34505aa6', ended: { verdict: 'completed', exitCode: 0, ending: 'exited' } })
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: `Unit ${name} exited 0.` })
  })
  describe('a run longer than the 200 lines dshd read prints by default', () => {
    // A worker's whole journal: its session event, 300 steps, then a crash with no final event (the shape of the exit-1 tail above).
    const all = ['dshd-run: run started', JSON.stringify({ type: 'session', sessionId: 'session-long', cwd: '/srv/agency' }),
      ...Array.from({ length: 300 }, (_, step) => JSON.stringify({ type: 'status', phase: 'step_start', turn: 1, step: step + 1 })),
      'dsh: fatal uncaught exception: Error: the model went away', 'dshd-run: dsh exited with status 1; exiting 1', 'dshd-run: run ended: exit-code']
    const envelope = (lines: string[], complete: boolean) => JSON.stringify({ name: 'probe-20261112-c1', invocationId: 'e8e5e47b097e4a8493e28d8a940eb779',
      complete, streams: ['stdout', 'stderr'], lines })
    const failing = (longer: Answer) => replay({ run: [{ stdout: RUN_CREATED, exit: 0 }], get: [{ stdout: RUN_CREATED, exit: 0 }, { stdout: WAIT_ENDED_FAILED, exit: 0 }],
      wait: [{ stdout: WAIT_ENDED_FAILED, exit: 0 }], read: [{ stdout: envelope(all.slice(-200), false), exit: 0 }, longer] })
    const reported = () => h!.relays(h!.runtime.masterId).filter(item => item.kind === 'worker_report')

    it('reads it again with -n 65536 and names the Session that read found in the binding, the summary and the relay', async () => {
      const dshd = failing({ stdout: envelope(all, true), exit: 0 })
      const ticket = await accepted(dshd)
      const { name } = binding(ticket)
      expect(dshd.calls.filter(argv => argv[1] === 'read')).toEqual([['dshd', 'read', '--json', name], ['dshd', 'read', '--json', '-n', '65536', name]])
      expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-long', ended: { verdict: 'task-failed', exitCode: 1 } })
      expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: `Unit ${name} ended task-failed (exit 1).\n\nUnit ${name}; session session-long.` })
      expect(reported()).toEqual([expect.objectContaining({ state: 'failed', unit: name, session: 'session-long' })])
    })
    it('settles it with the Session unknown when the longer read is not readable, as past the client\'s read cap', async () => {
      // DSH's subprocess service keeps the tail of an output past its cap, which is no JSON.
      const ticket = await accepted(failing({ stdout: `"step":7}"],"name":"probe-20261112-c1"}`, exit: 0 }))
      const { name } = binding(ticket)
      expect(binding(ticket)).toMatchObject({ state: 'ended', ended: { verdict: 'task-failed', exitCode: 1 } })
      expect(binding(ticket)!.sessionId).toBeUndefined()
      expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'failed', summary: `Unit ${name} ended task-failed (exit 1).\n\nUnit ${name}; session unknown.` })
      expect(reported()).toEqual([expect.objectContaining({ unit: name, session: null })])
    })
    it('reads it again for its usage when its final event names the Session, and keeps that Session when the longer read reaches no further', async () => {
      const lines = [...all.slice(-198, -3), JSON.stringify({ type: 'final', sessionId: 'session-long', reason: { kind: 'completed' }, text: 'Done.' }),
        'dshd-run: dsh exited with status 0; exiting 0', 'dshd-run: run ended: success']
      const dshd = replay({ run: [{ stderr: refusal('task-already-ran'), exit: 4 }], get: [{ stdout: GET_EXITED, exit: 0 }],
        read: [{ stdout: JSON.stringify({ name: 'probe-20261112-g4', invocationId: 'f72771583e9a465d810ef7da34505aa6', complete: false, streams: ['stdout', 'stderr'], lines }), exit: 0 }] })
      const ticket = await accepted(dshd)
      expect(dshd.verbs).toEqual(['run', 'get', 'get', 'read', 'read'])
      expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-long', ended: { verdict: 'completed' } })
      // The newest lines do not reach back to the run's start, and neither does the longer read: the usage is not known.
      expect(binding(ticket).usage).toBeUndefined()
      expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'Done.' })
    })
    it('records on the binding the usage of every step of the whole run the longer read prints', async () => {
      const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 100 }
      const exited = (lines: string[], complete: boolean) => JSON.stringify({ name: 'probe-20261112-g4', invocationId: 'f72771583e9a465d810ef7da34505aa6',
        complete, streams: ['stdout', 'stderr'], lines })
      const whole = ['dshd-run: run started', JSON.stringify({ type: 'session', sessionId: 'session-long', cwd: '/srv/agency' }),
        ...Array.from({ length: 300 }, (_, step) => JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: step + 1, usage })),
        JSON.stringify({ type: 'final', sessionId: 'session-long', reason: { kind: 'completed' }, text: 'Done.' }),
        'dshd-run: dsh exited with status 0; exiting 0', 'dshd-run: run ended: success']
      const dshd = replay({ run: [{ stderr: refusal('task-already-ran'), exit: 4 }], get: [{ stdout: GET_EXITED, exit: 0 }],
        read: [{ stdout: exited(whole.slice(-200), false), exit: 0 }, { stdout: exited(whole, true), exit: 0 }] })
      const ticket = await accepted(dshd)
      expect(dshd.calls.filter(argv => argv[1] === 'read').map(argv => argv.slice(2))).toEqual([['--json', binding(ticket).name], ['--json', '-n', '65536', binding(ticket).name]])
      expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-long', usage: { inputTokens: 3000, outputTokens: 600, cacheReadTokens: 30000 },
        ended: { verdict: 'completed' } })
      expect(latestAssignment(stored(ticket))!.report).toMatchObject({ state: 'ready', summary: 'Done.' })
    })
  })
  it('words only the summary of a unit that exited 0 with no final answer as the workflow Source\'s NO_ANSWER reads it', async () => {
    // floor/workflow `src/sources/workflow-backend.ts` NO_ANSWER, copied: a change to either side must change the other in the same merge.
    const NO_ANSWER = /^Unit [a-z0-9][a-z0-9_-]* exited 0\.$/
    const fake = new FakeDshd()
    const ends: [Parameters<FakeDshd['end']>[1], boolean][] = [[{ lines: runLines('session-1') }, true], [{ lines: runLines('session-2', 'Done.') }, false],
      [{ lines: runLines('session-3', 'Unit sa-x-a1 exited 0. Then more.') }, false], [{ exitCode: 1, lines: runLines('session-4') }, false],
      [{ signal: 9, lines: [] }, false]]
    const summaries: string[] = []
    for (const [index, [how]] of ends.entries()) {
      const ticket = await accepted(fake, request(String(index + 1)))
      fake.end(binding(ticket).name, how)
      // The watch looks again later: time moves on and it runs now.
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 })
      try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
      summaries.push(latestAssignment(stored(ticket))!.report!.summary)
    }
    expect(summaries[0]).toBe(`Unit ${fake.runs[0]!.name} exited 0.`)
    expect(summaries.map(summary => NO_ANSWER.test(summary))).toEqual(ends.map(([, none]) => none))
    // Every name the executor gives a unit, named or not, is one NO_ANSWER's name pattern takes.
    for (const name of [...fake.runs.map(item => item.name), unitName('sa', 'x'.repeat(60), 'ticket-1', 1), unitName('sa', undefined, '0123456789abcdef', 999)]) {
      expect(NO_ANSWER.test(`Unit ${name} exited 0.`)).toBe(true)
    }
  })
  it('records failed without retrying for every refusal of dshd run that dshd 0.1.0 lists, and tries only an unavailable dshd again', async () => {
    const fake = new FakeDshd()
    const refused: [string, number][] = [['start-failed', 1], ['stop-failed', 1], ['release-invalid', 1], ['io', 1], ['inconsistent-state', 1],
      ['systemctl-failed', 1], ['invalid-argument', 2], ['invalid-name', 2], ['needs-target', 2], ['not-found', 3], ['release-not-found', 3],
      ['exists-different-recipe', 4], ['instance-running', 4], ['unit-masked', 4], ['attached-elsewhere', 4], ['not-running', 5],
      ['unsupported-transport', 6], ['unsupported-profile', 6], ['autostart-not-allowed', 6]]
    const tickets: Ticket[] = []
    for (const [index, [kind, exit]] of refused.entries()) {
      fake.failNext('run', exit, kind)
      tickets.push(await accepted(fake, request(String(index + 1))))
    }
    expect(fake.runs).toHaveLength(refused.length)
    expect(tickets.map(ticket => latestAssignment(stored(ticket))!.report?.state)).toEqual(refused.map(() => 'failed'))
    expect(tickets.map(ticket => latestAssignment(stored(ticket))!.report!.summary.replace(/^dshd refused \S+: /, '').split(':')[0]))
      .toEqual(refused.map(([kind]) => kind))
    // Exit 7 says dshd cannot reach systemd or its parts: the launch waits and tries again.
    fake.failNext('run', 7, 'template-missing')
    const unavailable = await accepted(fake, request('99'))
    expect(latestAssignment(stored(unavailable))).toMatchObject({ state: 'pending' })
    expect(latestAssignment(stored(unavailable))!.report).toBeUndefined()
    expect(h!.runtime.effects.pending('launch', latestAssignment(stored(unavailable))!.id)).toBe(true)
  })
})
