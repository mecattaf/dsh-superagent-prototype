/** The Executor as Runtime uses it: the core port plus preparing new Tickets and the host's lifecycle. */
import type { DshExecutor } from './dsh.ts'

/** What Runtime uses of its Executor, picked from DshExecutor so the two cannot drift apart; DshdExecutor implements it too. */
export type ExecutorPort = Pick<DshExecutor, 'prepare' | 'start' | 'stop' | 'deliver' | 'install' | 'resume' | 'shutdown' | 'dispose' | 'activeCount'>
