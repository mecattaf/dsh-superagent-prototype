import { existsSync } from "node:fs";
import { check } from "proper-lockfile";
import { setTimeout } from "node:timers/promises";
//#region src/infra/lock.ts
/** The proper-lockfile directory locks of the state directory and the scheduled inbox: when one counts as stale, and the wait for it. */
/** Age at which a lock that its holder stopped refreshing counts as left by a process that died (proper-lockfile `stale`). */
const LOCK_STALE_MS = 3e4;
/**
* Wait, for at most `waitMs`, until no live process holds the lock of `path`. A process killed before its shutdown leaves its lock
* behind until it goes stale, so a start right after such a kill takes it over instead of failing. Returns when the lock is free, the time
* is up or `signal` aborts; the caller's own `lockSync` then refuses a holder that is still alive.
*/
async function lockReleased(path, waitMs, signal) {
	const deadline = Date.now() + waitMs;
	while (!signal.aborted && Date.now() < deadline && existsSync(path) && await check(path, { stale: 3e4 })) await setTimeout(Math.min(1e3, deadline - Date.now()), void 0, { signal }).catch(() => {});
}
//#endregion
export { lockReleased as n, LOCK_STALE_MS as t };
