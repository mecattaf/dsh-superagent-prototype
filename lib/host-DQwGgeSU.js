import { createHash } from "node:crypto";
//#region src/core/model.ts
/** Stable key of a thread across the whole domain. */
const threadKey = (ref) => `${ref.source}:${ref.id}`;
/**
* Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
* values that do not parse as a timestamp are returned unchanged.
*/
function isoTime(value) {
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : value;
}
/**
* The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
* and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
* while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
* an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
* main Session may only stop the work on it.
*/
function followupOwners(trigger, records) {
	if (!trigger.human) return [];
	const disposition = records.triggers.disposition(trigger.id);
	if (!disposition || disposition.requeued) return [];
	const returned = new Set(disposition.handbacks?.map((item) => item.ticketId));
	const reached = disposition.fanout.filter((id) => !returned.has(id) && !disposition.context?.includes(id));
	if (!reached.length || records.threads.get(threadKey(trigger.threads[0]))?.evaluating?.triggerIds.includes(trigger.id)) return [];
	return reached.filter((id) => {
		const ticket = records.tickets.get(id);
		return !!ticket && (liveTicket(ticket) || ticket.ended?.by !== "human" && ticket.inputs.some((input) => input.kind === "trigger" && input.triggerId === trigger.id && ticket.undelivered.includes(input.id)));
	});
}
/**
* Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
* work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
*/
const settled = (decision) => !["stop", "unavailable"].includes(decision.kind) && !decision.reason.some((reason) => [
	"stopNotExplicit",
	"stopUnknown",
	"routed"
].includes(reason.code));
/** Whether a ticket is open: it has not ended. */
const liveTicket = (ticket) => !ticket.ended;
/** How a ticket ended. */
const ticketOutcome = (ticket) => ticket.ended?.outcome;
const runningAssignment = (ticket) => ticket.assignments.find((assignment) => assignment.state === "running");
/**
* Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
* to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
*/
function reached(ticket, trigger, thread, context = true) {
	if (ticket.origin.triggerId === trigger.id) return true;
	const input = ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === trigger.id);
	return trigger.threads.some((ref) => {
		const current = thread(threadKey(ref));
		return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id));
	}) || input && (context || !trigger.threads.every((ref) => thread(threadKey(ref))?.context?.includes(ticket.id)));
}
const latestAssignment = (ticket) => ticket.assignments.at(-1);
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
const latestReport = (ticket) => ticket.assignments.findLast((assignment) => assignment.report)?.report;
/**
* Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
* is false, or the end of its latest turn, whichever is later.
*/
function readUntil(ticket, progress = true) {
	return [(ticket.assignments.findLast((assignment) => assignment.report && (progress || assignment.report.state !== "progress"))?.report)?.at ?? "", ...ticket.assignments.map((assignment) => assignment.idleAt ?? "")].reduce((a, b) => a > b ? a : b);
}
/**
* Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
* since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
*/
function waitsForPerson(ticket) {
	const report = latestAssignment(ticket)?.report;
	if (report?.state !== "blocked" && report?.state !== "failed") return false;
	return !ticket.inputs.some((input) => input.kind === "trigger" && input.human && !input.context && input.at > report.at);
}
//#endregion
//#region src/core/ids.ts
/** Stable content-derived identifiers; equal inputs always produce the same id. */
function key(...values) {
	return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}
//#endregion
//#region src/infra/text.ts
/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter("zh", { granularity: "word" });
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
function wordCount(text) {
	let count = 0;
	for (const segment of words.segment(text)) if (segment.isWordLike) count++;
	return count;
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
function checkedImText(text) {
	const count = wordCount(text);
	if (count > 100) throw new Error(`IM message has ${count} words; maximum is 100. Rewrite as a short high-level update. Do not split it into multiple messages.`);
	return text;
}
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
/** Case-insensitive comparison for GitHub logins and repository names. */
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
//#endregion
//#region src/sources/host.ts
/** Fixed English health templates (`{name}` placeholders); the panel localizes each `code` in the interface language. */
const HEALTH_TEXT = {
	setupPending: "Waiting for the deployment check",
	sourceOff: "Off",
	feishuCliUnset: "The Source is on, and its bot lark-cli is not set",
	feishuBotMissing: "Waiting for the Feishu bot",
	pollFailures: "{count} consecutive failed polls; last: {error}"
};
function health(state, code, values = {}) {
	return {
		state,
		detail: fill(HEALTH_TEXT[code], values),
		code,
		...Object.keys(values).length ? { values } : {}
	};
}
const sourceContext = (host, kind) => host.context(kind);
//#endregion
export { settled as _, fill as a, waitsForPerson as b, key as c, latestAssignment as d, latestReport as f, runningAssignment as g, readUntil as h, escapeRegExp as i, followupOwners as l, reached as m, sourceContext as n, sameName as o, liveTicket as p, checkedImText as r, wordCount as s, health as t, isoTime as u, threadKey as v, ticketOutcome as y };
