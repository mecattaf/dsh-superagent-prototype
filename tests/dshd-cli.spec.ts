/** The dshd client: the argv it gives DSH's subprocess service, and the JSON and error objects of dshd it reads. */
import { describe, expect, it, vi } from 'vitest'
import { DshdCli, DshdUnavailable, invocationOf, type DshdRecipe } from '../src/executor/dshd-cli.ts'
import { eventsOf } from '../src/executor/dshd.ts'

/** A subprocess service whose every command exits with `exitCode`, printing `stdout` and `stderr`, as in tests/fixtures/host.ts. */
function answering(stdout = '', stderr = '', exitCode: number | null = 0) {
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return { spawn: vi.fn((_spec: { argv: readonly string[]; cwd: string }) => ({ done: Promise.resolve({ exitCode, signal: null }), collected: { stdout: reader(stdout), stderr: reader(stderr) } })) }
}
const cli = (subprocess: ReturnType<typeof answering>) => new DshdCli(subprocess as never, 'dshd')
const signal = new AbortController().signal
const status = (overrides: Record<string, unknown> = {}) => ({ name: 'sa-fix-a1', id: 'instance-1', unit: 'dshd@sa-fix-a1.service', state: 'running',
  invocationId: 'invocation-1', labels: { 'superagent.ticket': 't1' }, environmentNames: ['HOME'], resources: { memoryPeak: null },
  lastRun: { startedAt: 1, invocationId: 'invocation-1', ending: null, endedAt: null, serviceResult: null, exitCode: null, exitStatus: null, child: null, thisBoot: true },
  remedy: null, ...overrides })
const refusal = (kind: string) => JSON.stringify({ error: { kind, message: `refused: ${kind}`, hint: null } })
const recipe: DshdRecipe = { name: 'sa-fix-a1', cwd: '/srv/agency', labels: { 'superagent.ticket': 't1', 'superagent.assignment': 'a1' },
  profile: 'work-opus', args: ['--approval-policy', 'never'], task: '{"ticket_id":"t1"}', env: { PATH: '/bin', HOME: '/srv', CONFIG_DIR: '/srv/config' } }

describe('DshdCli', () => {
  it('builds env -i with the passed and configured names, then dshd run --bg --json --name --cwd, sorted labels, --, the pair profile, its args, --json and the task', async () => {
    const subprocess = answering(JSON.stringify({ outcome: 'created', warnings: [], ...status() }))
    await cli(subprocess).run(recipe, signal)
    const [spec] = subprocess.spawn.mock.calls[0]!
    expect(spec.argv).toEqual(['env', '-i', 'CONFIG_DIR=/srv/config', 'HOME=/srv', 'PATH=/bin', 'dshd', 'run', '--bg', '--json', '--name', 'sa-fix-a1',
      '--cwd', '/srv/agency', '--label', 'superagent.assignment=a1', '--label', 'superagent.ticket=t1', '--', 'work-opus', '--approval-policy', 'never',
      '--json', '{"ticket_id":"t1"}'])
    expect(spec.cwd).toBe('/srv/agency')
  })
  it('reads created, started and already-running as launched, with the unit\'s invocationId and instance id', async () => {
    for (const outcome of ['created', 'started', 'already-running']) {
      const result = await cli(answering(JSON.stringify({ outcome, warnings: [], ...status() }))).run(recipe, signal)
      expect(result).toMatchObject({ outcome, id: 'instance-1', invocationId: 'invocation-1', state: 'running' })
    }
  })
  it('reads task-already-ran, exists-different-recipe, invalid-name, unsupported-profile and start-failed from the stderr error object with their exit codes', async () => {
    for (const [kind, exit] of [['task-already-ran', 4], ['exists-different-recipe', 4], ['invalid-name', 2], ['unsupported-profile', 6], ['start-failed', 1]] as const) {
      expect(await cli(answering('', refusal(kind), exit)).run(recipe, signal)).toEqual({ refused: kind, exit, message: `refused: ${kind}` })
    }
    // Output that is not dshd's error object is no refusal to act on.
    await expect(cli(answering('', 'Segmentation fault', 139)).run(recipe, signal)).rejects.toThrow('dshd run sa-fix-a1 exited with 139: Segmentation fault')
  })
  it('throws DshdUnavailable on exit 7', async () => {
    await expect(cli(answering('', refusal('systemd-unavailable'), 7)).run(recipe, signal)).rejects.toBeInstanceOf(DshdUnavailable)
    await expect(cli(answering('', refusal('tool-missing'), 7)).get('sa-fix-a1', signal)).rejects.toBeInstanceOf(DshdUnavailable)
  })
  it('reads get --json state, invocationId, labels and lastRun, and exit 3 as not-found', async () => {
    const ended = status({ state: 'stopped', invocationId: null,
      lastRun: { startedAt: 1, invocationId: 'invocation-1', ending: 'exited', endedAt: 2, serviceResult: 'success', exitCode: 'exited', exitStatus: '0', child: { exitCode: 0 }, thisBoot: true } })
    const subprocess = answering(JSON.stringify(ended))
    const read = await cli(subprocess).get('sa-fix-a1', signal)
    expect(read).toEqual({ name: 'sa-fix-a1', id: 'instance-1', state: 'stopped', invocationId: null, labels: { 'superagent.ticket': 't1' },
      lastRun: { invocationId: 'invocation-1', ending: 'exited', endedAt: 2, child: { exitCode: 0 } } })
    expect(subprocess.spawn.mock.calls[0]![0].argv).toEqual(['dshd', 'get', '--json', 'sa-fix-a1'])
    // An ended headless unit names its invocation only in its last run.
    expect(invocationOf(read as never)).toBe('invocation-1')
    expect(await cli(answering('', refusal('not-found'), 3)).get('sa-fix-a1', signal)).toBe('not-found')
    await expect(cli(answering('', refusal('inconsistent-state'), 1)).get('sa-fix-a1', signal)).rejects.toThrow('refused: inconsistent-state')
  })
  it('reads wait --json ended with exitCode and signal, and still-running', async () => {
    const subprocess = answering(JSON.stringify({ outcome: 'ended', warnings: [], exitCode: 1, signal: null, reason: 'dsh exited with status 1', ...status({ state: 'failed' }) }))
    expect(await cli(subprocess).wait('sa-fix-a1', 30, signal)).toEqual({ outcome: 'ended', exitCode: 1, signal: null, reason: 'dsh exited with status 1' })
    expect(subprocess.spawn.mock.calls[0]![0].argv).toEqual(['dshd', 'wait', '--json', '--timeout', '30', 'sa-fix-a1'])
    const still = JSON.stringify({ outcome: 'still-running', warnings: [], exitCode: 124, signal: null, reason: 'still running after 30 s', ...status() })
    expect(await cli(answering(still)).wait('sa-fix-a1', 30, signal)).toEqual({ outcome: 'still-running' })
    expect(await cli(answering(still, '', 124)).wait('sa-fix-a1', 30, signal)).toEqual({ outcome: 'still-running' })
  })
  it('finds the session id in the first session event and the answer in the last final event of read --json, skipping lines that are not JSON', async () => {
    const lines = ['dshd-run: run started', '{"type":"session","sessionId":"session-1","cwd":"/srv/agency"}', '{"type":"text","text":"Looking."}',
      'dsh: a diagnostic', '{"type":"session","sessionId":"session-2"}', '{"type":"final","text":"First."}', '{"type":"final","text":"Done."}', '{not json']
    const subprocess = answering(JSON.stringify({ name: 'sa-fix-a1', invocationId: 'invocation-1', complete: true, streams: ['stdout', 'stderr'], lines }))
    const read = await cli(subprocess).read('sa-fix-a1', signal)
    expect(read).toEqual({ invocationId: 'invocation-1', complete: true, lines })
    expect(eventsOf(read as never)).toEqual({ sessionId: 'session-1', final: 'Done.' })
    expect(eventsOf({ lines: ['dshd-run: run started'] })).toEqual({})
  })
  it('asks read for its newest -n lines only when given a count, and takes the session id from the final event once no session event is left', async () => {
    const lines = ['{"type":"text","text":"Still working."}', '{"type":"final","sessionId":"session-1","reason":{"kind":"completed"},"text":"Done."}',
      'dshd-run: run ended: success']
    const subprocess = answering(JSON.stringify({ name: 'sa-fix-a1', invocationId: 'invocation-1', complete: false, streams: ['stdout', 'stderr'], lines }))
    const read = await cli(subprocess).read('sa-fix-a1', signal)
    await cli(subprocess).read('sa-fix-a1', signal, 65536)
    expect(subprocess.spawn.mock.calls.map(([spec]) => spec.argv)).toEqual([['dshd', 'read', '--json', 'sa-fix-a1'], ['dshd', 'read', '--json', '-n', '65536', 'sa-fix-a1']])
    expect(eventsOf(read as never)).toEqual({ sessionId: 'session-1', final: 'Done.' })
    // The session event still names the Session while it is in the lines; a final event without one, as before dsh 0.2.2, names none.
    expect(eventsOf({ lines: ['{"type":"session","sessionId":"session-0"}', lines[1]!] })).toEqual({ sessionId: 'session-0', final: 'Done.' })
    expect(eventsOf({ lines: ['{"type":"final","text":"Done."}'] })).toEqual({ final: 'Done.' })
  })
  it('reads a stop as the status it leaves, and refuses output it cannot read', async () => {
    expect(await cli(answering(JSON.stringify({ outcome: 'stopped', warnings: [], ...status({ state: 'stopped' }) }))).stop('sa-fix-a1', signal))
      .toMatchObject({ state: 'stopped' })
    await expect(cli(answering('ok')).get('sa-fix-a1', signal)).rejects.toThrow('printed what dsh-superagent does not read: ok')
  })
  it('runs dshd rm --json NAME, reads the status before removal, not-found as such, and throws on a running instance', async () => {
    const subprocess = answering(JSON.stringify({ outcome: 'removed', warnings: [], ...status({ state: 'stopped' }) }))
    expect(await cli(subprocess).rm('sa-fix-a1', signal)).toMatchObject({ state: 'stopped' })
    expect(subprocess.spawn.mock.calls[0]![0].argv).toEqual(['dshd', 'rm', '--json', 'sa-fix-a1'])
    expect(await cli(answering('', refusal('not-found'), 3)).rm('sa-fix-a1', signal)).toBe('not-found')
    await expect(cli(answering('', refusal('instance-running'), 4)).rm('sa-fix-a1', signal)).rejects.toThrow('dshd rm sa-fix-a1 refused: instance-running')
  })
})
