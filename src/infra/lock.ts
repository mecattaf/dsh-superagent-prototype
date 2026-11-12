/** The proper-lockfile directory locks of the state directory and the scheduled inbox: when one counts as stale, and the wait for it. */
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { check } from 'proper-lockfile'

/** Age at which a lock that its holder stopped refreshing counts as left by a process that died (proper-lockfile `stale`). */
export const LOCK_STALE_MS = 30_000

/**
 * Wait, for at most `waitMs`, until no live process holds the lock of `path`. A process killed before its shutdown leaves its lock
 * behind until it goes stale, so a start right after such a kill takes it over instead of failing. Returns when the lock is free, the time
 * is up or `signal` aborts; the caller's own `lockSync` then refuses a holder that is still alive.
 */
export async function lockReleased(path: string, waitMs: number, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + waitMs
  while (!signal.aborted && Date.now() < deadline && existsSync(path) && await check(path, { stale: LOCK_STALE_MS })) {
    await sleep(Math.min(1_000, deadline - Date.now()), undefined, { signal }).catch(() => { /* Aborted: the loop ends. */ })
  }
}
