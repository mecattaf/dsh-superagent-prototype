/** The Executor as Runtime uses it: the core port plus preparing new Tickets and the host's lifecycle. */
import type { AssessmentOutcome, Executor, Ticket } from '../core/index.ts'

/** What Runtime uses of its Executor beyond the core port. DshExecutor satisfies it unchanged. */
export interface ExecutorPort extends Executor {
  /** A newly accepted Ticket with its `execution` attributes: its name, directory and assignment text. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket
  /** Subscribes to what the host tells the Executor, once at startup. */
  install(): void
  /** Reconciles running and pending Assignments after a host start. */
  resume(): void
  /** Stops what the Executor runs in this process when the host stops. */
  shutdown(): Promise<void>
  /** Releases the Executor's subscriptions and timers. */
  dispose(): void
  /** Number of open Tickets whose worker holds a worker slot. */
  activeCount(): number
}
