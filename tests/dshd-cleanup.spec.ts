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
  it('never removes a unit that runs or ran another invocation, carries another orchestrator\'s labels, dshd cannot tell about, or names no Session', async () => {
    await start({ removeEnded: true })
    const settings = h!.runtime.store.settings()
    h!.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 5 } })
    const running = await h!.acceptedTicket(request('1'))
    const rerun = await h!.acceptedTicket(request('5'))
    const foreign = await h!.acceptedTicket(request('9'))
    const uncertain = await h!.acceptedTicket(request('13'))
    const silent = await h!.acceptedTicket(request('17'))
    const all = [running, rerun, foreign, uncertain, silent]
    for (const { ticket } of all) fake.end(nameOf(ticket), { exitCode: 1, lines: ticket === silent.ticket ? [] : runLines(`session-${ticket.id}`) })
    await later()
    // Someone ran the first unit again, and the second again to its end; another orchestrator took over the third's name; dshd
    // can no longer tell about the fourth.
    fake.rerun(nameOf(running.ticket))
    fake.rerun(nameOf(rerun.ticket)); fake.end(nameOf(rerun.ticket), { lines: runLines('session-other', 'Another answer.') })
    fake.instances.get(nameOf(foreign.ticket))!.recipe.labels['superagent.orchestrator'] = 'another-orchestrator'
    fake.instances.get(nameOf(uncertain.ticket))!.state = 'orphaned'
    for (const { ticket } of all) h!.runtime.engine.stopTicket(ticket.id)
    await later(); await later()
    for (const { ticket } of all) {
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
  it('sweeps at a start the units of Tickets that ended while it was off, and keeps those of open Tickets', async () => {
    await start()
    const done = await h!.acceptedTicket(request('1'))
    const failed = await h!.acceptedTicket(request('5'))
    fake.end(nameOf(done.ticket), { lines: runLines('session-d', 'Done.') })
    fake.end(nameOf(failed.ticket), { exitCode: 2, lines: runLines('session-f', 'Tests fail.') })
    await later(); await later()
    expect(stored(done.ticket).ended?.outcome).toBe('completed')
    expect(stored(failed.ticket).ended).toBeUndefined()
    // A start with the key still off sweeps nothing.
    await h!.restart(); await later()
    expect(fake.removals).toEqual([])
    await h!.restart({ executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', removeEnded: true }) }); await later()
    expect(fake.removals).toEqual([nameOf(done.ticket)])
    expect(binding(done.ticket)).toMatchObject({ state: 'ended', sessionId: 'session-d', removedAt: expect.any(String) })
    expect(fake.instances.has(nameOf(failed.ticket))).toBe(true)
    expect(binding(failed.ticket)).not.toHaveProperty('removedAt')
    // The next start finds nothing left to remove.
    await h!.restart({ executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', removeEnded: true }) }); await later()
    expect(fake.removals).toEqual([nameOf(done.ticket)])
  })
  it('queues at most 64 removals a start, the units that ended first, and leaves the rest to the next start', async () => {
    await start()
    const { ticket } = await h!.acceptedTicket(request('1'))
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') })
    await later(); await later()
    // 65 more ended units of the same ended Ticket, which dshd no longer knows, ended before the real one.
    const ended = binding(ticket)!
    const extra = Array.from({ length: 65 }, (_, i) => `extra-${String(i).padStart(2, '0')}`)
    for (const [i, id] of extra.entries()) {
      h!.runtime.store.set(BINDING(id), { ...ended, name: `gone-${i}`, ended: { ...ended.ended!, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() } })
    }
    const removed = () => extra.filter(id => h!.runtime.store.get(BINDING(id))?.removedAt)
    const on = { executor: 'dshd' as const, dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', removeEnded: true }) }
    await h!.restart(on); await later()
    expect(removed()).toEqual(extra.slice(0, 64))
    expect(fake.removals).toEqual([])
    await h!.restart(on); await later()
    expect(removed()).toEqual(extra)
    expect(fake.removals).toEqual([nameOf(ticket)])
  })
  it('leaves at a start the units another host launched to that host', async () => {
    await start()
    const { ticket } = await h!.acceptedTicket(request('1'))
    fake.end(nameOf(ticket), { lines: runLines('session-h', 'Done.') })
    await later(); await later()
    const assignmentId = stored(ticket).assignments[0]!.id
    h!.runtime.store.set(BINDING(assignmentId), { ...binding(ticket)!, host: 'another-host' })
    await h!.restart({ executor: 'dshd', dshd: testDshd({ pairs: PAIRS, defaultPair: 'opus', removeEnded: true }) }); await later()
    expect(fake.removals).toEqual([])
    expect(h!.runtime.effects.pending('dshd-rm', assignmentId)).toBe(false)
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
