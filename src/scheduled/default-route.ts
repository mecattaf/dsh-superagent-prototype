/**
 * The default route (DESIGN 7.4, C5.3): when nobody is in the loop, an Eval of a standing scheduled Trigger expires,
 * requeues twice and reads `unavailable`; the floor then issues the command the main Session's `orchestrator_route`
 * would: `accept` (title = the workflow name) when the workflow has no live Ticket, `attach` when it has one.
 *
 * Path chosen: `Engine.decide` accepts a Trigger with no open Eval through a direct Eval of it alone (`engine.ts` decide),
 * so after `unavailable` the floor decides each standing Trigger of that Decision itself. It runs on the next tick, outside
 * the Engine transaction that emitted the event.
 */
import type { DomainEvent, Ticket, Trigger } from '../core/index.ts'
import { liveTicket } from '../core/index.ts'
import { floorLog as defaultLog, type FloorEvent, type FloorField } from './log.ts'

export interface DefaultRouteHost {
  engine: {
    decide(triggerId: string, outcome: { kind: 'accept'; title: string; scope: string; reason: { code: string }; acknowledgement: string; name: string }): { kind: string; ticketId?: string }
    attach(ticketId: string, triggerId: string, note?: string): Ticket
  }
  store: {
    decisions: { get(id: string): { triggerIds: string[]; kind: string } | undefined }
    triggers: { get(id: string): Trigger | undefined }
    tickets: { list(): Ticket[] }
  }
  log?: (event: FloorEvent, fields?: Record<string, FloorField>) => void
  /** Defers the command until the emitting transaction ends; default `queueMicrotask`. */
  defer?: (run: () => void) => void
}

const scheduledTrigger = (trigger: Trigger | undefined): trigger is Trigger =>
  !!trigger && trigger.source === 'scheduled' && trigger.standing === true

/**
 * The workflow's standing Ticket (DESIGN 7.1: one per workflow): the newest one with a `schedule` basis for it, live or
 * ended by its Executor; `attach` resumes an ended one (c3). One a person stopped has withdrawn its Mandate and is skipped.
 */
export function ticketOfWorkflow(tickets: readonly Ticket[], workflow: string): Ticket | undefined {
  return tickets.filter(ticket => {
    const basis = ticket.mandate.basis as { via?: string; workflow?: string }
    return basis.via === 'schedule' && basis.workflow === workflow && (liveTicket(ticket) || ticket.ended?.by !== 'human')
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
}

/** A worktree name for the Ticket: the workflow stem, which `ticketWorktreeName` makes unique. */
const nameOf = (workflow: string) => workflow.slice(workflow.lastIndexOf(':') + 1).replace(/[^a-z0-9-]/gu, '-').slice(0, 40) || 'scheduled'

/** Routes one standing scheduled Trigger by the default rule; returns the action taken. */
export function routeDefault(host: DefaultRouteHost, trigger: Trigger): 'accept' | 'attach' | 'refused' {
  const log = host.log ?? defaultLog
  const meta = trigger.meta as { workflow?: string; occurrence?: string; name?: string }
  const workflow = meta.workflow ?? ''
  const live = ticketOfWorkflow(host.store.tickets.list(), workflow)
  try {
    if (live) {
      host.engine.attach(live.id, trigger.id, 'Default route: the next occurrence of this workflow.')
      log('default-route', { workflow, occ: meta.occurrence, action: 'attach', ticket: live.id })
      return 'attach'
    }
    const title = (meta.name || workflow).slice(0, 200)
    const decision = host.engine.decide(trigger.id, { kind: 'accept', title, scope: title, reason: { code: 'defaultRoute' },
      acknowledgement: `Scheduled run of ${workflow}.`, name: nameOf(workflow) })
    log('default-route', { workflow, occ: meta.occurrence, action: 'accept', decision: decision.kind, ticket: decision.ticketId })
    return decision.kind === 'accept' ? 'accept' : 'refused'
  } catch (error) {
    log('error', { workflow, occ: meta.occurrence, route: 'default', error: String(error) })
    return 'refused'
  }
}

/** Domain event hook: an `unavailable` Decision on a scheduled Thread routes its standing Triggers. */
export function onDomainEvent(host: DefaultRouteHost, event: DomainEvent): void {
  if (event.type !== 'decision.recorded' || event.data.kind !== 'unavailable' || !event.data.threadKey.startsWith('scheduled:')) return
  const defer = host.defer ?? queueMicrotask
  const decisionId = event.data.decisionId
  defer(() => {
    const decision = host.store.decisions.get(decisionId)
    for (const id of decision?.triggerIds ?? []) {
      const trigger = host.store.triggers.get(id)
      if (scheduledTrigger(trigger)) routeDefault(host, trigger)
    }
  })
}
