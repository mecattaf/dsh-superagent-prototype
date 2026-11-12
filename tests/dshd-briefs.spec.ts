/** The briefs the dshd executor writes under stateDir/briefs: kept while their Ticket is open, removed once it has ended. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { BINDING } from '../src/executor/dshd.ts'
import { testDshd } from './fixtures/deployment.ts'
import { FakeDshd, runLines } from './fixtures/fake-dshd.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
let fake: FakeDshd
const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await h?.stop(); h = undefined
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const directory = () => { const made = mkdtempSync(join(tmpdir(), 'dshd-agency-')); directories.push(made); return made }
async function start(): Promise<Host> {
  fake = new FakeDshd()
  h = await startRuntime(undefined, { machine: { executor: 'dshd', dshd: testDshd({ pairs: { opus: { profile: 'work-opus', env: {} } }, defaultPair: 'opus',
    briefArgvMaxChars: 1000 }) }, spawn: spec => fake.spawn(spec) })
  return h
}
/** A request whose brief is longer than briefArgvMaxChars, so it goes to a file. */
function long(id: string): Trigger {
  const trigger = feishu(id, `@bot ${'整理日志。'.repeat(300)}`)
  return { ...trigger, meta: { ...trigger.meta, cwd: directory() } }
}
const stored = (ticket: Ticket) => h!.runtime.store.tickets.get(ticket.id)!
const nameOf = (ticket: Ticket) => h!.runtime.store.get(BINDING(stored(ticket).assignments[0]!.id))!.name
const briefOf = (ticket: Ticket) => join(h!.directory, 'briefs', `${stored(ticket).assignments[0]!.id}.json`)
let skew = 0
async function later(): Promise<void> {
  skew += 10 * 60_000
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + skew })
  try { await h!.runtime.pump(); await h!.runtime.idle() } finally { vi.useRealTimers() }
}

describe('briefs', () => {
  it('removes the brief of a Ticket its unit\'s end completed', async () => {
    await start()
    const { ticket } = await h!.acceptedTicket(long('1'))
    expect(fake.runs[0]!.task).toBe(`Read and follow the task in ${briefOf(ticket)}.`)
    expect(existsSync(briefOf(ticket))).toBe(true)
    fake.end(nameOf(ticket), { lines: runLines('session-1', 'Done.') })
    await later()
    expect(stored(ticket).ended?.outcome).toBe('completed')
    expect(existsSync(briefOf(ticket))).toBe(false)
  })
  it('keeps the brief of a Ticket that stays open after its unit failed, and removes it once a person stops the Ticket', async () => {
    await start()
    const { ticket } = await h!.acceptedTicket(long('1'))
    fake.end(nameOf(ticket), { exitCode: 3, lines: runLines('session-1', 'Tests fail.') })
    await later()
    expect(stored(ticket).ended).toBeUndefined()
    expect(existsSync(briefOf(ticket))).toBe(true)
    h!.runtime.engine.stopTicket(ticket.id); await h!.runtime.idle()
    expect(stored(ticket).ended).toBeDefined()
    expect(existsSync(briefOf(ticket))).toBe(false)
  })
  it('sweeps the briefs no open Ticket holds when a Ticket ends, and leaves the other open Tickets\' briefs and other files alone', async () => {
    await start()
    const briefs = join(h!.directory, 'briefs')
    mkdirSync(briefs, { recursive: true })
    // Left by a Ticket that ended before this process swept, and a file the executor did not write.
    writeFileSync(join(briefs, 'assignment-gone.json'), '{}')
    writeFileSync(join(briefs, 'notes.txt'), 'kept')
    const ending = await h!.acceptedTicket(long('1'))
    const open = await h!.acceptedTicket(long('5'))
    fake.end(nameOf(ending.ticket), { lines: runLines('session-1', 'Done.') })
    await later()
    expect(existsSync(briefOf(ending.ticket))).toBe(false)
    expect(existsSync(join(briefs, 'assignment-gone.json'))).toBe(false)
    expect(existsSync(briefOf(open.ticket))).toBe(true)
    expect(existsSync(join(briefs, 'notes.txt'))).toBe(true)
  })
})
