import { p as liveTicket } from "./host-DQwGgeSU.js";
//#region src/sources/poll.ts
/** Shared polling helpers for subscribed threads, overlap-safe cursors, and timer-friendly delays. */
/** How long a subscribed Thread with no live Ticket continues to be polled after its last Trigger or Ticket end. */
const POLL_HORIZON_MS = 12096e5;
/** True when a subscribed thread has a live ticket or recent activity/completion within `POLL_HORIZON_MS`. */
function polled(ctx, thread, now = Date.now()) {
	const tickets = thread.subscriptions.map((id) => ctx.tickets.get(id));
	if (tickets.some((ticket) => !!ticket && liveTicket(ticket))) return true;
	const times = [thread.lastAt ?? thread.createdAt, ...tickets.map((ticket) => ticket?.ended?.at ?? "")].map(Date.parse).filter(Number.isFinite);
	return now - Math.max(...times) < POLL_HORIZON_MS;
}
/** Steps a poll start timestamp back by 5 seconds so late-arriving remote events are not missed; deterministic trigger IDs deduplicate overlaps. */
const cursorAt = (started) => (/* @__PURE__ */ new Date(Date.parse(started) - 5e3)).toISOString();
/** Polls each subscribed Thread of `source` within the horizon independently; records failures on the Thread as `pollError` (unless `stopped()`) and clears `pollError` on success. */
async function pollThreads(ctx, source, stopped, poll, skip = () => false) {
	for (const thread of ctx.threads.subscribed(source)) {
		if (stopped()) return;
		if (skip(thread) || !polled(ctx, thread)) continue;
		try {
			await poll(thread);
			ctx.threads.patch(thread.key, { pollError: void 0 });
		} catch (error) {
			if (stopped()) return;
			ctx.threads.patch(thread.key, { pollError: String(error) });
		}
	}
}
/** Waits `ms` or until `signal` aborts using global `setTimeout` so test fake timers can drive polling loops. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const stop = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}
//#endregion
export { polled as a, pollThreads as i, cursorAt as n, pause as r, POLL_HORIZON_MS as t };
