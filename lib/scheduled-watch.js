import { C as threadKey, o as health, p as key, r as pause, s as sourceContext } from "./poll-DAUMch_y.js";
import { n as lockReleased, t as LOCK_STALE_MS } from "./lock-YabPmt4q.js";
import { lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { lockSync } from "proper-lockfile";
import { z } from "zod";
import { access, mkdir, open, readdir, rename, stat, writeFile } from "node:fs/promises";
import s from "@deepseek-ai/schemastery";
//#region src/sources/scheduled.ts
const SOURCE = "scheduled";
const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);
const Instant = z.iso.datetime({ offset: true });
/** Version 1 of a scheduled occurrence record; a producer drops one file per occurrence into the inbox. */
const OccurrenceRecordSchema = z.object({
	v: z.literal(1),
	kind: z.enum(["schedule", "manual"]),
	/** Groups the producer's items; may contain '/'. */
	namespace: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/).max(200),
	item: Slug,
	name: z.string().min(1).max(80).optional(),
	/** The working directory of the work: absolute, and an existing directory when read. */
	cwd: z.string().regex(/^\//).max(4096),
	/** The file the producer read the item from, for people; never opened by the Source. */
	file: z.string().regex(/^\//).max(4096).optional(),
	/** The occurrence's due instant; for a manual run, when it was requested. */
	due: Instant,
	/** A manual run's id; required for kind manual, absent for kind schedule. */
	run: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
	/** Due instants of the item before `due` that got no record of their own. */
	missed: z.number().int().min(0).max(1e5),
	revision: z.string().regex(/^[0-9a-f]{12}$/),
	/** The work, frozen when the record was written. */
	text: z.string().min(1).max(32768),
	/** Names the compute pair the work runs on; absent means the Executor's default pair. */
	pair: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/).optional(),
	by: z.string().min(1).max(64),
	at: Instant
}).strict().refine((record) => record.kind === "manual" === (record.run !== void 0), {
	message: "run is required for kind manual and absent for kind schedule",
	path: ["run"]
});
/** Plugin configuration of the dsh-superagent-scheduled entry; changing any key remounts the plugin. */
const Config = s.object({
	inbox: s.string().pattern(/^(\/|$)/).default("").description("Directory scheduled occurrence records (*.json) are dropped into. Absolute path; empty for <stateDir>/inbox/scheduled. Read records move to .done/ beside them, invalid ones to .bad/."),
	doneMaxAgeDays: s.number().min(0).step(1).default(0).description("Days a read record stays in .done/, counted from its modification time; 0 keeps it however old. Only *.json files directly in .done/ are removed."),
	doneMaxCount: s.number().min(0).step(1).default(0).description("Most read records kept in .done/, the newest by modification time; 0 keeps every one.")
});
/** The inbox of this plugin: its configured path, else `<stateDir>/inbox/scheduled` of the deployment. */
const inboxOf = (config, deployment) => config.inbox || join(deployment.stateDir, "inbox", "scheduled");
const ScheduledSettingsSchema = z.object({ pollSeconds: z.number().int().min(2).max(600).default(10) }).strict();
/**
* The Thread of one occurrence, named by its record file without `.json`. Every occurrence has its own: on a Thread a live
* Ticket follows, a later occurrence would also become an Input of that Ticket. The label groups an item's occurrences.
*/
const occurrenceThread = (occurrence) => ({
	source: SOURCE,
	id: occurrence
});
/** A record field on one line: a line break in a name, a path or `by` would otherwise move where the frozen text starts. */
const line = (value) => value.replace(/[\r\n\u2028\u2029]+/g, " ");
/** `namespace:item — name`, the label of an item's occurrences. */
const title = (record) => `${record.namespace}:${record.item} — ${line(record.name ?? record.item)}`;
/** The two header lines a worker and the assessment read before the frozen text. */
function header(record, due, missed) {
	const facts = `Working directory: ${line(record.cwd)}. Item file: ${record.file === void 0 ? "not given" : line(record.file)}. Revision ${record.revision}. Pair: ${record.pair ?? "default"}.`;
	if (record.kind === "manual") return `[Scheduled item, run now] ${title(record)}\nRequested ${due} by ${line(record.by)}. ${facts}`;
	const earlier = missed === 0 ? "no earlier due occurrence was missed" : `${missed} earlier due occurrence(s) did not run`;
	return `[Scheduled occurrence] ${title(record)}\nDue ${due}; ${earlier}. ${facts}`;
}
/** What tells one occurrence of an item from another: the run id of a manual run, or the due instant of a schedule record. */
const instance = (record) => record.kind === "manual" ? `run:${record.run}` : new Date(record.due).toISOString();
/** The id a release before the namespace was part of it gave an occurrence; Triggers stored under it keep it. */
const unscopedId = (record) => key(SOURCE, record.cwd, record.item, instance(record));
/** Builds the Trigger of one record; equal records give equal Trigger ids, and two namespaces never share one. */
function scheduledTrigger(record, occurrence, extra) {
	const due = new Date(record.due).toISOString();
	const meta = {
		occurrence,
		namespace: record.namespace,
		item: record.item,
		cwd: record.cwd,
		kind: record.kind,
		due,
		missed: extra.missed,
		revision: record.revision,
		...record.pair ? { pair: record.pair } : {},
		...extra.superseded ? { superseded: true } : {}
	};
	return {
		id: key(SOURCE, record.namespace, record.cwd, record.item, instance(record)),
		source: SOURCE,
		threads: [occurrenceThread(occurrence)],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at: record.due,
		text: `${header(record, due, extra.missed)}\n\n${record.text}`,
		meta: { ...meta }
	};
}
const code = (error) => error?.code;
/** One line naming what makes a record invalid. */
const issues = (error) => error.issues.map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ");
/** Whether `path` is a directory; undefined when stat fails for a reason other than a missing path, which may pass. */
const directory = async (path) => {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		return code(error) === "ENOENT" || code(error) === "ENOTDIR" ? false : void 0;
	}
};
/** Moves `file` into `dir` under its own name; a name already taken there gets a numeric suffix, so nothing is overwritten. */
async function moveInto(file, dir) {
	const name = basename(file), extension = extname(name), stem = name.slice(0, name.length - extension.length);
	for (let attempt = 0;; attempt++) {
		const target = join(dir, attempt ? `${stem}.${attempt}${extension}` : name);
		if (!await access(target).then(() => true, () => false)) {
			await rename(file, target);
			return target;
		}
	}
}
/** Moves an invalid record into `.bad` with a one-line `.error` beside it; false when the producer withdrew the file first. */
async function quarantine(file, bad, reason) {
	let target;
	try {
		target = await moveInto(file, bad);
	} catch (error) {
		if (code(error) === "ENOENT") return false;
		throw error;
	}
	await writeFile(`${target}.error`, `${reason.replace(/\s*\n\s*/g, " ")}\n`, { mode: 384 });
	return true;
}
/** The valid record a file holds, or the reason it is not one; undefined when the file is gone or cannot be read. */
async function readRecord(file, tally) {
	let text, owner;
	try {
		const handle = await open(file, "r");
		try {
			owner = (await handle.stat()).uid;
			text = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (code(error) !== "ENOENT") tally.unreadable += 1;
		return;
	}
	const uid = process.getuid?.();
	if (uid !== void 0 && owner !== uid) return `owned by uid ${owner}, not by this user`;
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return `not JSON: ${error instanceof Error ? error.message : String(error)}`;
	}
	const parsed = OccurrenceRecordSchema.safeParse(value);
	if (!parsed.success) return issues(parsed.error);
	const found = await directory(parsed.data.cwd);
	if (found === void 0) {
		tally.unreadable += 1;
		return;
	}
	return found ? parsed.data : `cwd is not a directory: ${parsed.data.cwd}`;
}
/**
* Reads every waiting record of `inbox` once, oldest name first, and moves each one it received out of the way. Older
* schedule records of an item are received first as superseded, and the ones that did not run go into the item's latest
* record's count. `read` counts the live and manual records received, `superseded` the older ones. A throw from `receive`
* ends the round and leaves its record, and the ones after it, for the next. A superseded record moves only after its item's
* live record is committed, so a round cut between the two, by a throw, an abort or a crash, reads both again and the live
* record's `missed` still counts the superseded ones. Every file call is a promise, so a round of many records does not hold
* up the Sessions and the web app the process also serves.
*/
async function readInbox(ctx, inbox, signal) {
	const done = join(inbox, ".done"), bad = join(inbox, ".bad");
	await mkdir(done, {
		recursive: true,
		mode: 448
	});
	await mkdir(bad, {
		recursive: true,
		mode: 448
	});
	const tally = {
		read: 0,
		superseded: 0,
		invalid: 0,
		unreadable: 0
	};
	const entries = [];
	for (const name of (await readdir(inbox)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort()) {
		const file = join(inbox, name);
		const record = await readRecord(file, tally);
		if (typeof record === "string") {
			if (await quarantine(file, bad, record)) {
				tally.invalid += 1;
				tally.lastInvalid = name;
			}
		} else if (record) entries.push({
			name,
			file,
			record
		});
	}
	const latest = /* @__PURE__ */ new Map();
	const itemOf = (record) => JSON.stringify([
		record.namespace,
		record.cwd,
		record.item
	]);
	for (const { record } of entries) if (record.kind === "schedule") latest.set(itemOf(record), Math.max(latest.get(itemOf(record)) ?? -Infinity, Date.parse(record.due)));
	const older = (record) => record.kind === "schedule" && Date.parse(record.due) < latest.get(itemOf(record));
	const superseded = entries.filter((entry) => older(entry.record)), live = entries.filter((entry) => !older(entry.record));
	const kept = (trigger, record) => {
		const stored = ctx.triggers.get(unscopedId(record));
		return stored?.source === "scheduled" && stored.meta.namespace === record.namespace ? {
			...trigger,
			id: stored.id
		} : trigger;
	};
	/** Receives one record's Trigger and labels its Thread; the receive's answer, or undefined once aborted. */
	const take = async (entry, trigger) => {
		if (signal?.aborted) return void 0;
		const result = await ctx.receive(trigger);
		if (result !== "filtered") {
			const { record } = entry;
			const due = record.kind === "manual" ? {
				zh: "请求时间",
				en: "Requested"
			} : {
				zh: "到期",
				en: "Due"
			};
			ctx.threads.describe(threadKey(trigger.threads[0]), {
				label: title(record),
				facts: {
					due: {
						label: due,
						value: String(trigger.meta.due)
					},
					revision: {
						label: {
							zh: "版本",
							en: "Revision"
						},
						value: record.revision
					}
				}
			});
		}
		return result;
	};
	/** Moves a received record into `.done`: only after its Trigger is committed, so a crash between the two re-reads it and answers duplicate. */
	const finish = async (file) => {
		try {
			await moveInto(file, done);
		} catch (error) {
			if (code(error) !== "ENOENT") throw error;
		}
	};
	const missed = /* @__PURE__ */ new Map();
	const waiting = /* @__PURE__ */ new Map();
	for (const entry of superseded) {
		const trigger = kept(scheduledTrigger(entry.record, entry.name.slice(0, -5), {
			missed: entry.record.missed,
			superseded: true
		}), entry.record);
		if (await take(entry, trigger) === void 0) return tally;
		tally.superseded += 1;
		if (ctx.triggers.get(trigger.id)?.meta.superseded === true) missed.set(itemOf(entry.record), (missed.get(itemOf(entry.record)) ?? 0) + 1 + entry.record.missed);
		waiting.set(itemOf(entry.record), [...waiting.get(itemOf(entry.record)) ?? [], entry.file]);
	}
	for (const entry of live) {
		if (await take(entry, kept(scheduledTrigger(entry.record, entry.name.slice(0, -5), { missed: entry.record.missed + (entry.record.kind === "schedule" ? missed.get(itemOf(entry.record)) ?? 0 : 0) }), entry.record)) === void 0) return tally;
		if (entry.record.kind === "schedule") {
			for (const file of waiting.get(itemOf(entry.record)) ?? []) await finish(file);
			waiting.delete(itemOf(entry.record));
		}
		await finish(entry.file);
		tally.read += 1;
	}
	return tally;
}
const DAY_MS = 864e5;
/**
* Removes read records from `<inbox>/.done` beyond the configured retention, and returns how many it removed; with both bounds
* 0 it lists nothing. Only regular `*.json` files directly in `.done` count, which is what a round moves there: `.bad`, the
* waiting records, dot-files, other names, folders and links are never removed, and a link is never followed. A record's age
* is its modification time, which its producer set when it wrote it; past `doneMaxCount`, the oldest go first.
*/
function pruneDone(inbox, retention, now = Date.now()) {
	const { doneMaxAgeDays, doneMaxCount } = retention;
	if (!doneMaxAgeDays && !doneMaxCount) return 0;
	const done = join(inbox, ".done");
	const records = [];
	for (const entry of readdirSync(done, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
		const file = join(done, entry.name);
		let modified;
		try {
			modified = lstatSync(file).mtimeMs;
		} catch (error) {
			if (code(error) === "ENOENT") continue;
			throw error;
		}
		records.push({
			file,
			name: entry.name,
			modified
		});
	}
	records.sort((a, b) => b.modified - a.modified || (a.name < b.name ? 1 : -1));
	let removed = 0;
	for (const [index, { file, modified }] of records.entries()) {
		if (!(doneMaxAgeDays > 0 && now - modified > doneMaxAgeDays * DAY_MS) && !(doneMaxCount > 0 && index >= doneMaxCount)) continue;
		try {
			unlinkSync(file);
		} catch (error) {
			if (code(error) !== "ENOENT") throw error;
			continue;
		}
		removed += 1;
	}
	return removed;
}
/** The ready health of the Source: what it read since it started, and what it could not read in its last round. */
function readyDetail(total, unreadable) {
	return `Read ${total.read}; superseded ${total.superseded}; invalid ${total.invalid}${total.lastInvalid ? `, last: ${total.lastInvalid}` : ""}` + (unreadable ? `; unreadable ${unreadable}` : "");
}
/**
* Creates the inbox (0700) and takes its proper-lockfile lock, so one process reads it; throws while another holds it, and
* for an inbox another user owns or that group or others can write, since a record in it runs with this process's permissions.
*/
function lockInbox(inbox, compromised) {
	mkdirSync(inbox, {
		recursive: true,
		mode: 448
	});
	const info = statSync(inbox), uid = process.getuid?.();
	if (uid !== void 0 && info.uid !== uid || info.mode & 18) throw new Error(`The inbox ${inbox} must be owned by this user and not writable by group or others (mode ${(info.mode & 511).toString(8)}, uid ${info.uid})`);
	return lockSync(inbox, {
		stale: LOCK_STALE_MS,
		onCompromised: compromised
	});
}
async function watch(ctx, config, signal) {
	await ctx.ready;
	if (!ctx.configured()) {
		ctx.report(SOURCE, health("paused", "setupPending"));
		return;
	}
	const inbox = inboxOf(config, ctx.deployment);
	const total = {
		read: 0,
		superseded: 0,
		invalid: 0
	};
	while (!signal.aborted) {
		await lockReleased(inbox, ctx.deployment.lockWaitMs, signal);
		if (signal.aborted) return;
		const lost = new AbortController();
		const release = lockInbox(inbox, (error) => {
			ctx.report(SOURCE, {
				state: "error",
				detail: `The inbox lock was lost: ${error.message}`
			});
			lost.abort();
		});
		try {
			await rounds(ctx, config, inbox, AbortSignal.any([signal, lost.signal]), total);
		} finally {
			try {
				release();
			} catch (error) {
				if (!lost.signal.aborted) throw error;
			}
		}
		if (lost.signal.aborted) await pause(LOCK_STALE_MS, signal);
	}
}
/** Reads the inbox every `pollSeconds` until `stop`, adding what each round read to `total`. */
async function rounds(ctx, config, inbox, stop, total) {
	let failures = 0;
	while (!stop.aborted) {
		const settings = ctx.config(SOURCE);
		if (!settings) ctx.report(SOURCE, health("paused", "sourceOff"));
		else {
			const at = (/* @__PURE__ */ new Date()).toISOString();
			try {
				const round = await readInbox(ctx, inbox, stop);
				if (!stop.aborted) pruneDone(inbox, config);
				failures = 0;
				total.read += round.read;
				total.superseded += round.superseded;
				total.invalid += round.invalid;
				if (round.lastInvalid) total.lastInvalid = round.lastInvalid;
				if (!stop.aborted) ctx.report(SOURCE, {
					state: "ready",
					at,
					detail: readyDetail(total, round.unreadable)
				});
			} catch (error) {
				failures += 1;
				if (!stop.aborted) ctx.report(SOURCE, health("error", "pollFailures", {
					count: String(failures),
					error: String(error)
				}));
			}
		}
		await pause((settings?.pollSeconds ?? 10) * 1e3, stop);
	}
}
const EMPTY = {
	DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: "",
	DSH_SUPERAGENT_SCHEDULED_ITEM: "",
	DSH_SUPERAGENT_SCHEDULED_DUE: "",
	DSH_SUPERAGENT_SCHEDULED_CWD: ""
};
/** The scheduled Source kind of a plugin configuration; its inbox shows as a read-only fact. */
function scheduledKind(config) {
	return {
		kind: SOURCE,
		title: {
			zh: "定时项",
			en: "Scheduled items"
		},
		description: {
			zh: "读取收件目录里每个到期发生的记录，一次发生一个触发。",
			en: "Reads one record per due occurrence from an inbox directory; one Trigger per occurrence."
		},
		schema: ScheduledSettingsSchema,
		fields: [{
			key: "inbox",
			type: "fact",
			label: {
				zh: "收件目录",
				en: "Inbox"
			}
		}, {
			key: "pollSeconds",
			type: "number",
			advanced: true,
			min: 2,
			max: 600,
			label: {
				zh: "读取间隔 / 秒",
				en: "Read interval / seconds"
			}
		}],
		facts: (deployment) => ({ inbox: deployment ? inboxOf(config, deployment) : config.inbox }),
		health: [SOURCE],
		scope: ({ meta }) => meta.superseded === true ? {
			listened: false,
			reason: "superseded"
		} : {
			listened: true,
			observed: true,
			row: "occurrence"
		},
		find: (query) => ({
			threads: /^\S+~[a-z0-9-]+@\S+$/.test(query.trim()) ? [`${SOURCE}:${query.trim()}`] : [],
			terms: query.trim() ? [query.trim()] : []
		}),
		policy: {
			schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).max(0).default([]) }).strict(),
			fields: [],
			explicit: {
				zh: "从不：发生没有发送者，也不会 @ 智能体。",
				en: "Never: an occurrence has no sender and does not address the agent."
			},
			rows: () => [{
				id: "occurrence",
				label: {
					zh: "到期的定时项",
					en: "Due scheduled items"
				},
				note: {
					zh: "没有发送者",
					en: "No sender"
				},
				cells: {
					listedUnaddressed: false,
					unlistedAddressed: false,
					unlistedUnaddressed: true
				}
			}]
		},
		environment: {
			variables: [
				{
					key: "DSH_SUPERAGENT_SCHEDULED_OCCURRENCE",
					ticket: true,
					description: {
						zh: "开始工单的定时发生记录的文件名，不含 .json；工单不是从定时发生开始时为空",
						en: "Record file name, without .json, of the occurrence that started the ticket; else empty"
					}
				},
				{
					key: "DSH_SUPERAGENT_SCHEDULED_ITEM",
					ticket: true,
					description: {
						zh: "开始工单的定时项，写作 namespace:item；工单不是从定时发生开始时为空",
						en: "Scheduled item that started the ticket, as namespace:item; else empty"
					}
				},
				{
					key: "DSH_SUPERAGENT_SCHEDULED_DUE",
					ticket: true,
					description: {
						zh: "这次发生的到期时间（ISO 8601，UTC）；手动运行时是请求的时间；工单不是从定时发生开始时为空",
						en: "Due instant (ISO 8601, UTC) of the occurrence that started the ticket, or a manual run's request time; else empty"
					}
				},
				{
					key: "DSH_SUPERAGENT_SCHEDULED_CWD",
					ticket: true,
					description: {
						zh: "这次发生为工作指定的工作目录；工单不是从定时发生开始时为空",
						en: "Working directory named by the occurrence that started the ticket; else empty"
					}
				}
			],
			values: ({ trigger }) => {
				if (trigger?.source !== "scheduled") return { ...EMPTY };
				const meta = trigger.meta;
				return {
					DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: meta.occurrence ?? "",
					DSH_SUPERAGENT_SCHEDULED_ITEM: meta.namespace && meta.item ? `${meta.namespace}:${meta.item}` : "",
					DSH_SUPERAGENT_SCHEDULED_DUE: meta.due ?? "",
					DSH_SUPERAGENT_SCHEDULED_CWD: meta.cwd ?? ""
				};
			}
		}
	};
}
const name = "dsh-superagent-scheduled";
const inject = ["orchestrator"];
/** Refuses configuration keys the entry does not use, so a misspelt `inbox` fails the load instead of reading the default inbox. */
function checked(config) {
	const unknown = Object.keys(config).filter((key) => !(key in (Config.dict ?? {})));
	if (unknown.length) throw new Error(`dsh-superagent-scheduled configuration has keys it does not use: ${unknown.join(", ")}; docs/006-deployment.md lists the keys`);
	return config;
}
function apply(ctx, config) {
	const kind = scheduledKind(checked(config));
	ctx.effect(() => ctx.orchestrator.sources.register(kind), "scheduled: source kind");
	ctx.effect(() => {
		const source = sourceContext(ctx.orchestrator, kind);
		const controller = new AbortController();
		const running = watch(source, config, controller.signal).catch((error) => {
			source.report(SOURCE, {
				state: "error",
				detail: String(error)
			});
		});
		return async () => {
			controller.abort();
			await running;
		};
	}, "scheduled: inbox watch");
}
//#endregion
export { Config, OccurrenceRecordSchema, SOURCE, ScheduledSettingsSchema, apply, inboxOf, inject, name, occurrenceThread, pruneDone, readInbox, scheduledKind, scheduledTrigger };
