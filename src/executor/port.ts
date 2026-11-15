/** The Executor as Runtime uses it: the core port plus preparing new Tickets and the host's lifecycle. */
import type { DshExecutor } from './dsh.ts'

/** What Runtime uses of its Executor, picked from DshExecutor so the two cannot drift apart; DshdExecutor implements it too. */
export type ExecutorPort = Pick<DshExecutor, 'prepare' | 'start' | 'stop' | 'deliver' | 'install' | 'resume' | 'shutdown' | 'dispose' | 'activeCount'
  | 'needsAccount' | 'workerEnvironment'> & {
  /**
   * `false` when a running Assignment reads only its brief, so an Input that arrives while it runs is not delivered to it
   * (`deliver` does nothing). Absent, the in-process Executor's default, a running worker receives Inputs at its next step.
   */
  readonly takesInput?: boolean
}
/**
 * Where an Executor's workers get their environment: `process`, this process's, which Setup's git variables and command shims and
 * the Ticket's execution environment reach; `own`, an explicit one each worker is started with, which none of those reach.
 */
export type WorkerEnvironment = 'process' | 'own'
