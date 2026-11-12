/** The dshd executor's opt-in removal of ended units (`dshd.removeEnded`), on the simulated DSH host with an in-memory dshd. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, type Ticket, type Trigger } from '../src/core/index.ts'
import { Config, machineOf, type DshdConfig } from '../src/deployment.ts'
import { BINDING } from '../src/executor/dshd.ts'
import { testDshd } from './fixtures/deployment.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const PAIRS = { opus: { profile: 'work-opus', env: {} } }
let h: Host | undefined
let fake: FakeDshd
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await h?.stop(); h = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const directory = () => { const made = mkdtempSync(join(tmpdir(), 'dshd-cleanup-')); directories.push(made); return made }
async function start(dshd: Partial<DshdConfig> = {}): Promise<Host> {
  fake = new FakeDshd()
  h = await startRuntime(undefined, { machine: { executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', ...dshd }) },
    spawn: spec => fake.spawn(spec) })
  return h
}
const request = (id: string): Trigger => { const trigger = feishu(id, `@bot 任务 ${id}`); return { ...trigger, meta: { ...trigger.meta, cwd: directory() } } }
const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
const binding = (ticket: Ticket, k = 1) => h!.runtime.store.get(BINDING(stored(ticket).assignments[k - 1]?.id ?? ''))
const nameOf = (ticket: Ticket, k = 1) => binding(ticket, k)!.name
let skew = 0
async function later(): Promise<void> {
  skew += 10 * 60_000
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
  try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
}

describe('dshd.removeEnded', () => {
  it('is off by default: a completed Ticket\'s unit stays in dshd', async () => {
    expect(machineOf(Config({ stateDir: '/srv/state' })).dshd).toMatchObject({ removeEnded: false })
    await start()
    const { ticket } = await h!.acceptedTicket(request('1'))
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') })
    await later(); await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(fake.removals).toEqual([])
    expect(fake.instances.has(nameOf(ticket))).toBe(true)
  })
  it('removes the unit of an ended Ticket once its binding records how it ended and its Session, and keeps the binding', async () => {
    await start({ removeEnded: true })
    const { ticket } = await h!.acceptedTicket(request('1'))
    const name = nameOf(ticket)
    fake.end(name, { lines: runLines('session-7', 'Cleaned the journal.') })
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(fake.removals).toEqual([name])
    expect(fake.instances.has(name)).toBe(false)
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-7', ended: { verdict: 'completed' }, removedAt: expect.any(String) })
    // A removal happens once: the next end of the same Ticket's effects does not call dshd rm again.
    await later()
    expect(fake.removals).toEqual([name])
  })
  it('keeps every unit while its Ticket is open, and removes all of them once it ends', async () => {
    await start({ removeEnded: true })
    const { ticket } = await h!.acceptedTicket(request('1'))
    const first = nameOf(ticket)
    fake.end(first, { exitCode: 2, lines: runLines('session-a', 'Tests fail.') })
    await later()
    // Failed: the Ticket waits for a person, and the unit is what the person reads.
    expect(stored(ticket).ended).toBeUndefined()
    expect(fake.removals).toEqual([])
    h!.runtime.engine.retryTicket(ticket.id); await later()
    expect(fake.removals).toEqual([])
    const second = nameOf(ticket, 2)
    fake.end(second, { lines: runLines('session-b', 'Done.') })
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect([...fake.removals].sort()).toEqual([first, second].sort())
  })
  it('records the Session of a unit a person stopped before it removes the unit', async () => {
    await start({ removeEnded: true })
    const { ticket } = await h!.acceptedTicket(request('1'))
    const name = nameOf(ticket)
    // The run printed its Session; the person's stop ends it before it answers.
    const stop = fake.stop.bind(fake)
    fake.stop = async unit => { const status = await stop(unit); fake.instances.get(unit)!.lines = runLines('session-s'); return status }
    h!.runtime.engine.stopTicket(ticket.id); await later()
    expect(fake.stops).toEqual([name])
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-s', ended: { verdict: 'stopped' }, removedAt: expect.any(String) })
    expect(fake.removals).toEqual([name])
  })
  it('never removes a unit that runs another invocation, carries another orchestrator\'s labels, or names no Session', async () => {
    await start({ removeEnded: true })
    const rerun = await h!.acceptedTicket(request('1'))
    const foreign = await h!.acceptedTicket(request('5'))
    const silent = await h!.acceptedTicket(request('9'))
    for (const { ticket } of [rerun, foreign, silent]) fake.end(nameOf(ticket), { exitCode: 1, lines: ticket === silent.ticket ? [] : runLines(`session-${ticket.id}`) })
    await later()
    // Someone ran the first unit again, and another orchestrator took over the second's name.
    fake.rerun(nameOf(rerun.ticket))
    const labels = fake.instances.get(nameOf(foreign.ticket))!.recipe.labels
    labels['superagent.orchestrator'] = 'another-orchestrator'
    for (const { ticket } of [rerun, foreign, silent]) h!.runtime.engine.stopTicket(ticket.id)
    await later(); await later()
    for (const { ticket } of [rerun, foreign, silent]) {
      expect(stored(ticket).ended).toBeDefined()
      expect(fake.instances.has(nameOf(ticket))).toBe(true)
      expect(binding(ticket)).not.toHaveProperty('removedAt')
    }
    expect(fake.removals).toEqual([])
    expect(latestAssignment(stored(silent.ticket))!.report!.summary).toContain('ended task-failed')
  })
  it('keeps the binding when dshd no longer knows the unit, and calls that removed', async () => {
    await start({ removeEnded: true })
    const { ticket } = await h!.acceptedTicket(request('1'))
    const name = nameOf(ticket)
    fake.end(name, { exitCode: 1, lines: runLines('session-g') })
    await later()
    fake.remove(name)
    h!.runtime.engine.stopTicket(ticket.id); await later()
    expect(binding(ticket)).toMatchObject({ state: 'ended', sessionId: 'session-g', removedAt: expect.any(String) })
    expect(fake.removals).toEqual([])
  })
  it('retries a removal dshd fails, and removes the unit then', async () => {
    await start({ removeEnded: true })
    fake.failNext('rm', 7, 'systemd-unavailable')
    const { ticket } = await h!.acceptedTicket(request('1'))
    const name = nameOf(ticket)
    fake.end(name, { lines: runLines('session-r', 'Done.') })
    await later()
    expect(fake.removals).toEqual([])
    await later()
    expect(fake.removals).toEqual([name])
  })
})
