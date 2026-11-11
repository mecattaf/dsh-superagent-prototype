/** The default route (C5.3): accept the first occurrence of a workflow, attach the next to its Ticket. PROVE P5.3. */
import { describe, expect, it, vi } from 'vitest'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { onDomainEvent, routeDefault, ticketOfWorkflow } from '../src/scheduled/default-route.ts'
import { quiet, recorder } from './scheduled-fixtures.ts'

const trigger = (workflow = 'master:nightly', occurrence = `${workflow}@2026-11-12T00:00:00.000Z`): Trigger => ({
  id: `scheduled:${occurrence}`, source: 'scheduled', threads: [{ source: 'scheduled', id: workflow }], actor: { source: 'scheduled', id: 'master' },
  human: false, standing: true, at: '2026-11-12T00:00:00.000Z', text: 'run', meta: { workflow, occurrence, name: 'Nightly' } })
const ticket = (id: string, workflow: string, patch: Partial<Ticket> = {}): Ticket => ({ id, createdAt: '2026-11-11T00:00:00.000Z',
  mandate: { basis: { via: 'schedule', workflow } }, assignments: [], inputs: [], undelivered: [], ...patch } as unknown as Ticket)
function host(tickets: Ticket[] = [], decide = vi.fn(() => ({ kind: 'accept', ticketId: 'T-new' })), triggers: Trigger[] = []) {
  const attach = vi.fn((ticketId: string) => tickets.find(t => t.id === ticketId)!)
  const r = recorder()
  return { r, decide, attach, host: { engine: { decide, attach }, log: r.log as never, defer: (run: () => void) => run(),
    store: { tickets: { list: () => tickets }, triggers: { get: (id: string) => triggers.find(t => t.id === id) },
      decisions: { get: (id: string) => (id === 'D1' ? { triggerIds: triggers.map(t => t.id), kind: 'unavailable' } : undefined) } } } }
}

describe('default route (C5.3)', () => {
  it('accepts the first occurrence of a workflow with reason defaultRoute and the stem as the worktree name', () => {
    const h = host()
    expect(routeDefault(h.host as never, trigger())).toBe('accept')
    expect(h.decide).toHaveBeenCalledWith('scheduled:master:nightly@2026-11-12T00:00:00.000Z', expect.objectContaining({
      kind: 'accept', title: 'Nightly', reason: { code: 'defaultRoute' }, name: 'nightly' }))
    expect(h.attach).not.toHaveBeenCalled()
    expect(h.r.lines[0]).toEqual(['default-route', expect.objectContaining({ workflow: 'master:nightly', action: 'accept' })])
  })
  it('attaches the next occurrence to the workflow\'s live Ticket', () => {
    const h = host([ticket('T-1', 'master:nightly')])
    expect(routeDefault(h.host as never, trigger('master:nightly', 'master:nightly@2026-11-13T00:00:00.000Z'))).toBe('attach')
    expect(h.attach).toHaveBeenCalledWith('T-1', 'scheduled:master:nightly@2026-11-13T00:00:00.000Z', expect.any(String))
    expect(h.decide).not.toHaveBeenCalled()
  })
  it('resumes a Ticket its Executor ended, but not one a person stopped', () => {
    const ended = ticket('T-ended', 'master:nightly', { ended: { at: '2026-11-11T01:00:00.000Z', by: 'executor' } } as never)
    expect(ticketOfWorkflow([ended], 'master:nightly')?.id).toBe('T-ended')
    const stopped = ticket('T-stopped', 'master:nightly', { ended: { at: '2026-11-11T01:00:00.000Z', by: 'human' } } as never)
    expect(ticketOfWorkflow([stopped], 'master:nightly')).toBeUndefined()
    expect(ticketOfWorkflow([ticket('T-other', 'master:other')], 'master:nightly')).toBeUndefined()
  })
  it('a refused or failing decide is reported as refused and logged', () => {
    const refused = host([], vi.fn(() => ({ kind: 'ignore' })))
    expect(routeDefault(refused.host as never, trigger())).toBe('refused')
    const throwing = host([], vi.fn(() => { throw new Error('boom') }))
    expect(routeDefault(throwing.host as never, trigger())).toBe('refused')
    expect(throwing.r.lines.some(([event]) => event === 'error')).toBe(true)
  })
  it('an unavailable Decision on a scheduled Thread routes its standing Triggers by the default rule', () => {
    const t = trigger()
    const h = host([], undefined, [t])
    onDomainEvent(h.host as never, { type: 'decision.recorded', data: { kind: 'unavailable', threadKey: 'scheduled:master:nightly', decisionId: 'D1' } } as never)
    expect(h.decide).toHaveBeenCalledTimes(1)
    // Other Decisions and other Threads are left to the main Session.
    onDomainEvent(h.host as never, { type: 'decision.recorded', data: { kind: 'accept', threadKey: 'scheduled:master:nightly', decisionId: 'D1' } } as never)
    onDomainEvent(h.host as never, { type: 'decision.recorded', data: { kind: 'unavailable', threadKey: 'github:x', decisionId: 'D1' } } as never)
    expect(h.decide).toHaveBeenCalledTimes(1)
  })
})
void quiet
