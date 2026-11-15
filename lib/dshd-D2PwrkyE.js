import { C as threadKey, S as settled, T as waitsForPerson, _ as latestReport, c as checkedImText, d as sameName, f as wordCount, g as latestAssignment, m as followupOwners, p as key, v as liveTicket, x as runningAssignment, y as reached } from "./poll-DAUMch_y.js";
import { d as WORKER_COMMANDS, h as verifyDirectory, m as runAsWorker, t as KV, w as LIMITS } from "./kv-DjFMz5fG.js";
import { i as pullOf, m as readRepositoryPath, p as readGithub } from "./github-pull-ByXsb1ef.js";
import { b as feishuTriggerId, f as feishuRead, g as feishuRef, m as readFeishuLink, p as feishuReferences, r as feishuSettings } from "./feishu-BPXQ8Uei.js";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
//#region src/core/errors.ts
/** User-facing error codes mapped to their category ('missing' or 'refused') and English message template. */
const USER_ERRORS = {
	unknownTicket: ["missing", "Unknown ticket"],
	unknownProblem: ["missing", "Unavailable Eval not found"],
	unknownTrigger: ["missing", "Unknown trigger"],
	unknownAssignment: ["missing", "Unknown assignment"],
	unknownBlock: ["missing", "Unknown settings block: {block}"],
	unknownPromptRevision: ["missing", "Unknown prompt revision {revision}"],
	unknownPromptPart: ["refused", "Unknown built-in prompt part {part}"],
	ticketEnded: ["refused", "Ticket has ended"],
	assignmentEnded: ["refused", "Assignment has ended; a newer assignment owns this ticket"],
	evalFinished: ["refused", "Eval {eval} has finished or a later eval replaced it; decide the trigger's current eval"],
	notAdmissible: ["refused", "Trigger is not admissible: {reason}"],
	notExplicit: ["refused", "An accept through orchestrator_route is for explicit requests from allowed senders; assess proactive candidates with orchestrator_eval and orchestrator_eval_decide"],
	ticketStopped: ["refused", "A person stopped this ticket; new work needs an accept through orchestrator_route"],
	mandateRevoked: ["refused", "The current policy no longer holds this ticket's mandate; new work needs an accept through orchestrator_route"],
	notRetryable: ["refused", "Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed"],
	sourceThread: ["refused", "This is the thread the ticket started on; it stays subscribed"],
	followedThread: ["refused", "This thread is the ticket's own, such as its pull request's; it stays subscribed"],
	notFollowing: ["refused", "This ticket does not follow that thread"],
	questionWithResult: ["refused", "A question for a person cannot also be a ready result or an answer; report it separately"],
	askerWithoutQuestion: ["refused", "The message that raised a question needs the question it raised"],
	notAsker: ["refused", "A question must name the person's message that raised it, which reached this ticket"],
	notAnswerable: ["refused", "An answer must name the person's question it answers, which reached this ticket"],
	ackEnded: ["refused", "Ticket ended; do not acknowledge historical requests"],
	notReached: ["refused", "Trigger does not belong to this worker"],
	handedBack: ["refused", "This ticket handed that trigger back already"],
	handedBackHere: ["refused", "The worker of this ticket handed that trigger back as beyond it: accept it as new work, attach it to another ticket, or ignore it"],
	workerDecides: ["refused", "This message reached ticket {tickets} on its thread: its worker decides whether it belongs there and hands back what does not, which then arrives as a candidate. Only a stop goes through orchestrator_route, with kind stop"],
	ackNoChannel: ["refused", "Acknowledgement requires an assigned human source message"],
	ackNotPerson: ["refused", "Use the original human trigger, not a bot, CI or worker report"],
	notReady: ["refused", "Ticket is not ready for delivery. Keep progress internal and wait for a verified ready report; do not relabel progress as an answer or send it through another channel."],
	notAttention: ["refused", "Attention requires the ticket's current attention question in human_action. Routine unfinished work stays internal."],
	notQuestion: ["refused", "An answer must target the original human question, not a worker report or automated trigger"],
	noAnswer: ["refused", "No worker answer is ready for this human trigger. Wait for the worker's report, or request one with orchestrator_ticket_request_status, which acts only on a worker that reported waiting; ordinary progress cannot be relabelled as an answer."],
	noChannel: ["refused", "No reply channel for this ticket or trigger"],
	panelOnlyEnvironment: ["refused", "The execution environment (ticket directory, prepare command, blocked commands) can only be changed in the management panel"],
	panelOnlyAccounts: ["refused", "Source fields that setup reads, such as account CLIs, can only be changed in the management panel"],
	setupComplete: ["refused", "Setup is complete"],
	modelUnavailable: ["refused", "The {block} model is not available: {error}"],
	promptTooLong: ["refused", "Prompt configuration exceeds {limit} characters"],
	promptPlaceholders: ["refused", "The “{part}” template must keep {placeholders}, which the system fills in"],
	promptPartEmpty: ["refused", "The “{part}” part cannot be empty; reset it to follow its built-in text"],
	sourceNotInstalled: ["refused", "The {source} Source kind is not installed"],
	noLabels: ["refused", "This Source has no names to refresh"],
	nothingToSync: ["refused", "The {source} Source's part of the Policy has nothing to sync from, or the Source is off or waiting for setup"],
	sourceNotRunning: ["refused", "The {source} Source is not running: it is off, stopping or waiting for setup; retry once it runs"],
	unknownWorkflowRun: ["missing", "Unknown workflow run {run}; orchestrator_workflow_status without run_id lists the newest runs"],
	workflowCwd: ["refused", "cwd must be an absolute path to an existing directory, which {cwd} is not"],
	workflowScript: ["refused", "Cannot read the workflow script {script} ({error}); name an existing script, absolute or relative to cwd"],
	workflowMeta: ["refused", "The workflow script {script} must export a valid meta ({error})"]
};
/**
* Structured error thrown by Engine parts and application services when a caller request is invalid or references missing state.
* Tool handlers and HTTP routes inspect its code and missing flag to return appropriate status responses, while the web panel localizes the code.
*/
var UserError = class extends Error {
	code;
	values;
	missing;
	constructor(code, values = {}) {
		const [kind, text] = USER_ERRORS[code];
		super(text.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match));
		this.code = code;
		this.values = values;
		this.missing = kind === "missing";
	}
};
//#endregion
//#region src/core/stage.ts
/** Ticket stage classification and retry eligibility (docs/003). */
/** Classifies a ticket's stage; the rules follow the table in docs/003 in order, where the first matching row wins. */
function ticketStage(ticket) {
	if (ticket.ended) return { stage: "ended" };
	if (ticket.delivery) return {
		stage: "person",
		action: "delivery"
	};
	if (ticket.attention) return {
		stage: "person",
		action: "answer"
	};
	const assignment = latestAssignment(ticket);
	const report = assignment?.report?.state;
	if (report === "ready") return {
		stage: "person",
		action: "review"
	};
	if ((report === "blocked" || report === "failed") && waitsForPerson(ticket)) return {
		stage: "person",
		action: report
	};
	if (!assignment || assignment.state === "pending") return {
		stage: "working",
		action: "queued"
	};
	if (report === "waiting" || assignment.state === "ended") return { stage: "idle" };
	return { stage: "working" };
}
/** True when an open ticket is stalled on a blocked/failed report without a newer human follow-up, or has a failed input delivery. */
function canRetry(ticket) {
	return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery);
}
//#endregion
//#region src/core/reasons.ts
/**
* Structured reason codes and templates for decisions, filtered triggers, and ended assignments.
* Policy gates and source scopes may also emit their own literal reason codes.
*/
const REASONS = {
	said: "{text}",
	timeout: "Assessment timed out",
	policyChanged: "Policy changed during assessment",
	noAdmissible: "No admissible trigger",
	startedTicket: "Already started ticket {ticket}",
	acceptedBefore: "Trigger {trigger} was accepted before",
	routed: "Routed to ticket {ticket}",
	explicitRouted: "Explicit request from an allowed sender routed by the orchestrator",
	humanStop: "Human asked to stop",
	legacyImport: "Imported from the pre-domain-model task record",
	forwarded: "Forwarded to the worker of the Ticket already on this Thread",
	senderNotMember: "The sender is not on the Source's list",
	retried: "Retried by a person",
	hostRestarted: "dsh-superagent restarted",
	stopUnknown: "Stop target is unknown or already ended",
	stopNotExplicit: "A stop needs an explicit request from a sender on the list",
	directionUnsettled: "Implementation intent or target direction is not established, or a product/design decision is still required",
	noRuleMatched: "No enabled admission rule matched",
	ignoredFromCard: "Ignored from its card, without a rule assessment",
	observed: "Observe mode: would accept ({text})"
};
const said = (text) => ({
	code: "said",
	values: { text }
});
/** Formats reasons in English (prefixed by `triggerId` when present) for agent consumption. */
function reasonText(reasons) {
	return [reasons ?? []].flat().map((reason) => {
		const text = (REASONS[reason.code] ?? reason.code).replace(/\{(\w+)\}/g, (match, name) => reason.values?.[name] ?? match);
		return reason.triggerId ? `${reason.triggerId}: ${text}` : text;
	}).join("; ");
}
//#endregion
//#region src/admission.ts
/** Default admission rules (matching pre-table behavior): unaddressed messages from listed senders are inferred candidates; unlisted senders are ignored. */
const ADMISSION_DEFAULTS = {
	listedUnaddressed: "inferred",
	unlistedAddressed: "ignore",
	unlistedUnaddressed: "ignore"
};
//#endregion
//#region src/policy.ts
/**
* Runtime settings schemas, assessment validation, and policy gate evaluation.
* Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
*/
const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const RuleAssessmentSchema = z.object({
	rule_id: RuleIdSchema,
	reason: z.string().trim().min(1).max(500)
}).strict().extend({ matched: z.boolean() }).strict();
const AdmissionDirectionSchema = z.object({
	implementation_requested: z.boolean(),
	target_basis: z.enum([
		"specified",
		"existing-standard",
		"undetermined"
	]),
	requires_design_decision: z.boolean(),
	evidence: z.string().trim().min(1).max(700)
}).strict();
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
function directionAllowed(value) {
	const result = AdmissionDirectionSchema.safeParse(value);
	return result.success && result.data.implementation_requested && result.data.target_basis !== "undetermined" && !result.data.requires_design_decision;
}
/**
* Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
* Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
* inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
* @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
*/
function assessmentOutcome(assessment, settings, strength) {
	const enabled = settings.policy.rules.filter((rule) => rule.enabled);
	const judged = assessment.rule_assessments;
	const ids = new Set(judged.map((item) => item.rule_id));
	if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some((rule) => !ids.has(rule.id))) throw new Error("Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed");
	const matches = judged.filter((item) => item.matched).map(({ rule_id, reason }) => ({
		rule_id,
		reason
	}));
	const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {};
	const audit = {
		matches,
		rule_assessments: judged,
		direction: assessment.direction,
		...evidence
	};
	if (assessment.decision !== "accept") return {
		kind: assessment.decision,
		reason: assessment.reason,
		audit
	};
	if (!directionAllowed(assessment.direction)) return {
		kind: "ignore",
		audit,
		reason: { code: "directionUnsettled" }
	};
	if (!matches.length) return {
		kind: "ignore",
		audit,
		reason: { code: "noRuleMatched" }
	};
	if (!assessment.intent_evidence) throw new Error("Acceptance requires intent_evidence");
	const { title, scope, worktree_name: name } = assessment;
	if (strength === "inferred" && settings.eval.mode !== "auto") {
		const proposal = {
			title,
			scope,
			worktree_name: name
		};
		return {
			kind: "ignore",
			audit: {
				...audit,
				would_accept: true,
				proposal
			},
			reason: {
				code: "observed",
				values: { text: assessment.reason }
			}
		};
	}
	return {
		kind: "accept",
		title,
		scope,
		reason: assessment.reason,
		...assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {},
		rules: matches.map((match) => match.rule_id),
		audit,
		...name ? { name } : {}
	};
}
const DEFAULT_RULES = [{
	id: "copy",
	name: "Copy fixes",
	enabled: true,
	instruction: "Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning."
}, {
	id: "visual",
	name: "Visual fixes",
	enabled: true,
	instruction: "Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question."
}];
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
const RuleSchema = z.object({
	id: RuleIdSchema,
	name: z.string().trim().min(1).max(LIMITS.ruleName),
	enabled: z.boolean(),
	instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction)
}).strict();
const RoleModelSchema = z.object({
	provider: z.string().trim().min(1),
	model: z.string().trim().min(1),
	reasoningEffort: z.string().trim().min(1).optional()
}).strict();
const AllowedSchema = z.object({
	id: z.string().trim().min(1).max(200),
	name: z.string().trim().max(100).optional()
}).strict();
const Weak = z.enum(["inferred", "ignore"]);
const AdmissionRowSchema = z.object({
	listedUnaddressed: Weak.optional(),
	unlistedAddressed: z.enum([
		"explicit",
		"inferred",
		"ignore"
	]).optional(),
	unlistedUnaddressed: Weak.optional()
}).strict();
const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema);
const SourcePolicySchema = z.object({
	allowed: z.array(AllowedSchema).default([]),
	admission: AdmissionTableSchema.default({})
}).catchall(z.unknown());
const PolicyConfigSchema = z.object({
	rules: z.array(RuleSchema).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Duplicate rule IDs").default(DEFAULT_RULES),
	sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({})
}).strict();
const EvalConfigSchema = z.object({
	mode: z.enum([
		"off",
		"observe",
		"auto"
	]).default("observe"),
	timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
	model: RoleModelSchema.nullable().default(null)
}).strict();
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine((name) => name !== "." && name !== "..", "Not a command name").refine((name) => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(", ")} cannot be blocked`);
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, and blocked commands. */
const ExecutorConfigSchema = z.object({
	model: RoleModelSchema.nullable().default(null),
	maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
	directory: z.string().trim().refine((path) => path === "" || path.startsWith("/"), "An absolute path, or empty for <stateDir>/work").default(""),
	prepare: z.string().max(LIMITS.prepareCommand).default(""),
	blockedCommands: z.array(CommandNameSchema).default([])
}).strict();
const SourceInstanceSchema = z.object({
	enabled: z.boolean().default(true),
	config: z.record(z.string(), z.unknown()).default({})
}).strict();
const SettingsSchema = z.object({
	paused: z.boolean().default(false),
	sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
	policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
	eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
	executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({}))
}).strict();
const POLICY_REVISION = "mandate-v3";
/**
* Compute a version hash for settings that affect work authorization.
* Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
*/
function policyVersion(settings) {
	return key(POLICY_REVISION, JSON.stringify({
		rules: settings.policy.rules,
		mode: settings.eval.mode,
		sources: settings.policy.sources
	}));
}
function allowedSender(settings, actor) {
	return settings.policy.sources[actor.source]?.allowed.find((entry) => sameName(entry.id, actor.id));
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
function listedBot(settings, actor) {
	return z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? []).find((entry) => sameName(entry.id, actor.id));
}
const anyoneAllowed = (settings) => Object.values(settings.policy.sources).some((part) => part.allowed.length > 0);
const senderName = (entry) => entry.name || entry.id;
/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread, tickets) => [...thread.subscriptions, ...tickets.map((ticket) => ticket.id)].some((id) => !thread.context?.includes(id));
const listened = (sources, source, meta) => sources.scope({
	source,
	meta
});
function admissionCell(allowed, addressed) {
	return allowed ? addressed ? void 0 : "listedUnaddressed" : addressed ? "unlistedAddressed" : "unlistedUnaddressed";
}
function admissionOf(settings, source, row, cell) {
	return (row === void 0 ? void 0 : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell];
}
const STRENGTH = {
	ignore: 0,
	inferred: 1,
	explicit: 2
};
/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
function policyEffects(tickets, old, now, scope) {
	const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now));
	const effects = /* @__PURE__ */ new Map();
	for (const ticket of tickets) {
		const rules = (ticket.mandate.basis.rules ?? []).flatMap((id) => {
			const was = old.policy.rules.find((rule) => rule.id === id), is = now.policy.rules.find((rule) => rule.id === id);
			if (!is?.enabled) return was?.enabled ? [{
				id,
				name: was.name,
				change: "disabled"
			}] : [];
			return JSON.stringify(was) === JSON.stringify(is) ? [] : [{
				id,
				name: is.name,
				change: "changed",
				instruction: is.instruction
			}];
		});
		const effect = rules.length ? { rules } : {};
		if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
			if (!settingsPolicy({
				...now,
				eval: old.eval,
				policy: {
					...now.policy,
					rules: old.policy.rules
				}
			}, scope(now)).revalidate(ticket.mandate)) Object.assign(effect, {
				requesterAllowed: false,
				requester: ticket.mandate.actor
			});
			else if (ticket.mandate.strength === "inferred" && old.eval.mode === "auto" && now.eval.mode !== "auto") effect.proactive = false;
		}
		if (Object.keys(effect).length) effects.set(ticket.id, effect);
	}
	return effects;
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
function settingsPolicy(settings, sources) {
	const version = policyVersion(settings);
	const mode = settings.eval.mode;
	/** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
	const machineGate = (trigger) => {
		const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : void 0;
		if (trigger.actor.id && !bot) return {
			admissible: false,
			reason: "not_human"
		};
		const scope = listened(sources, trigger.source, trigger.meta);
		if (!scope.listened || !(trigger.addressed || scope.observed)) return {
			admissible: false,
			reason: "not_human"
		};
		const recorded = {
			source: trigger.source,
			scope: trigger.meta,
			...scope.row === void 0 ? {} : { row: scope.row }
		};
		const addressed = trigger.addressed ? { addressed: trigger.addressed } : {};
		if (bot) {
			if (mode === "off") return {
				admissible: false,
				reason: "admission_ignored"
			};
			return {
				admissible: true,
				strength: "inferred",
				basis: {
					...recorded,
					via: "bot",
					sender: senderName(bot),
					...addressed,
					observation: { mode }
				}
			};
		}
		const cell = "unlistedUnaddressed";
		if (admissionOf(settings, trigger.source, scope.row, cell) !== "inferred" || mode === "off") return {
			admissible: false,
			reason: "admission_ignored"
		};
		return {
			admissible: true,
			strength: "inferred",
			basis: {
				...recorded,
				via: "admission",
				cell,
				observation: { mode }
			}
		};
	};
	return {
		version,
		paused: settings.paused,
		evalTimeoutMs: settings.eval.timeoutSeconds * 1e3,
		gate(trigger, thread, tickets) {
			if (!trigger.human) return machineGate(trigger);
			const allowed = allowedSender(settings, trigger.actor);
			const scope = listened(sources, trigger.source, trigger.meta);
			const row = scope.listened ? scope.row : void 0;
			const recorded = {
				source: trigger.source,
				scope: trigger.meta,
				...row === void 0 ? {} : { row },
				...allowed ? { sender: senderName(allowed) } : {}
			};
			if (allowed && trigger.addressed) return {
				admissible: true,
				strength: "explicit",
				basis: {
					...recorded,
					via: "addressed",
					addressed: trigger.addressed
				}
			};
			const cell = admissionCell(!!allowed, !!trigger.addressed);
			const receivable = !!trigger.addressed || scope.listened && scope.observed;
			const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : "ignore";
			const basis = {
				...recorded,
				via: "admission",
				cell,
				...trigger.addressed ? { addressed: trigger.addressed } : {}
			};
			if (admission === "explicit") return {
				admissible: true,
				strength: "explicit",
				basis
			};
			if (!(trigger.addressed === "direct" && !allowed) && (allowed || mode !== "off") && participating(thread, tickets)) return {
				admissible: true,
				strength: allowed ? "explicit" : "inferred",
				basis: {
					...recorded,
					via: "followup"
				}
			};
			if (admission === "inferred" && mode !== "off") return {
				admissible: true,
				strength: "inferred",
				basis: {
					...basis,
					observation: { mode }
				}
			};
			return {
				admissible: false,
				reason: !allowed ? "not_a_member" : receivable && admission === "ignore" ? "admission_ignored" : "no_mention"
			};
		},
		admitsInferred: (rules) => mode === "auto" && rules.length > 0 && rules.every((id) => settings.policy.rules.some((rule) => rule.enabled && rule.id === id)),
		revalidate(mandate) {
			const { basis } = mandate;
			const { source } = basis;
			const current = source && basis.scope ? listened(sources, source, basis.scope) : void 0;
			if (current && !current.listened) return false;
			const rulesOn = (rules) => (rules ?? []).every((id) => settings.policy.rules.some((rule) => rule.enabled && rule.id === id));
			if (basis.via === "followup") return mandate.strength === "explicit" || mode === "auto" && rulesOn(basis.rules);
			if (basis.via === "bot" && !listedBot(settings, mandate.actor)) return false;
			if (basis.via === "admission") {
				const { cell } = basis;
				const listed = !!allowedSender(settings, mandate.actor);
				if (cell === "unlistedAddressed" && listed) return true;
				const now = cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : cell;
				if (now === "listedUnaddressed" && !listed) return false;
				const admission = admissionOf(settings, source ?? "", current?.listened ? current.row : void 0, now);
				if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false;
				if (mandate.strength === "explicit") return true;
			} else if (basis.via !== "bot" && !allowedSender(settings, mandate.actor)) return false;
			if ((basis.via === "admission" || basis.via === "listed" || basis.via === "bot") && basis.observation) return mode === "auto" && rulesOn(basis.rules);
			return true;
		}
	};
}
//#endregion
//#region src/app/execution-environment.ts
/** Execution environment variables exposed to prepare commands and documented in worker Session instructions; never contains credentials. */
/** Variables registered by the Executor; `ticket` entries are populated only when a ticket is present. */
const EXECUTOR_VARIABLES = [
	{
		key: "DSH_SUPERAGENT_DIR",
		ticket: true,
		description: {
			zh: "这个工单的执行目录；执行器 Session 在其中工作",
			en: "This ticket's directory; the executor Session works in it"
		}
	},
	{
		key: "DSH_SUPERAGENT_NAME",
		ticket: true,
		description: {
			zh: "工单的短名，也是执行目录的名字",
			en: "The ticket's short name, also its directory's name"
		}
	},
	{
		key: "DSH_SUPERAGENT_TICKET",
		ticket: true,
		description: {
			zh: "工单 id",
			en: "The ticket id"
		}
	},
	{
		key: "DSH_SUPERAGENT_BLOCKED_COMMANDS",
		description: {
			zh: "这个执行环境禁止调用的命令，以空格分隔；不要运行它们",
			en: "Commands blocked in this execution environment, separated by spaces; never run them"
		}
	}
];
const executionRoot = (settings, stateDir) => settings.executor.directory || join(stateDir, "work");
/** Lists all declared variables grouped by owner; `enabled` is false for Sources that are currently switched off. */
function declaredVariables(sources, settings) {
	const on = new Set(sources.environments(settings).map((item) => item.kind.kind));
	return [{
		owner: "executor",
		enabled: true,
		variables: EXECUTOR_VARIABLES
	}, ...sources.declarations().map(({ kind, variables }) => ({
		owner: kind,
		enabled: on.has(kind),
		variables
	}))];
}
function environmentOf(input) {
	const { deployment, sources, settings, ticket, trigger } = input;
	const executor = {
		DSH_SUPERAGENT_BLOCKED_COMMANDS: settings.executor.blockedCommands.join(" "),
		...ticket ? {
			DSH_SUPERAGENT_DIR: ticket.directory,
			DSH_SUPERAGENT_NAME: ticket.name,
			DSH_SUPERAGENT_TICKET: ticket.id
		} : {}
	};
	const result = EXECUTOR_VARIABLES.filter((spec) => !spec.ticket || ticket).map((spec) => ({
		key: spec.key,
		value: executor[spec.key] ?? "",
		description: spec.description,
		owner: "executor"
	}));
	for (const { kind, environment, config } of sources.environments(settings)) {
		const values = environment.values({
			deployment,
			config,
			...trigger ? { trigger } : {}
		});
		for (const spec of environment.variables.filter((spec) => !spec.ticket || ticket)) result.push({
			key: spec.key,
			value: values[spec.key] ?? "",
			description: spec.description,
			owner: kind.kind
		});
	}
	return result;
}
/** Combines a ticket's fixed directory, name, and origin trigger with the deployment's current settings. */
function ticketEnvironment(input) {
	const { ticket, trigger, ...rest } = input;
	const values = {
		id: ticket.id,
		name: ticket.execution?.name ?? "",
		directory: ticket.execution?.directory ?? ""
	};
	return environmentOf({
		...rest,
		ticket: values,
		...trigger ? { trigger } : {}
	});
}
function environmentLines(variables) {
	return variables.map((variable) => `- ${variable.key} = ${JSON.stringify(variable.value)}: ${variable.description.en}.`).join("\n");
}
//#endregion
//#region src/app/effects.ts
/**
* Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
* Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
*/
var Later = class extends Error {};
/**
* Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
* Coordinates per-kind handlers, concurrency limits, exponential backoff, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
*/
var Effects = class {
	store;
	board;
	now;
	handlers = /* @__PURE__ */ new Map();
	health = /* @__PURE__ */ new Map();
	tasks = /* @__PURE__ */ new Set();
	/** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
	broken = /* @__PURE__ */ new Set();
	seq;
	scheduled = false;
	/** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
	started = false;
	stopped = false;
	constructor(store, board, now = () => Date.now()) {
		this.store = store;
		this.board = board;
		this.now = now;
		this.seq = Number(store.db.prepare("SELECT IFNULL(MAX(seq), 0) AS seq FROM effect").get()?.seq ?? 0);
	}
	/** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
	enqueue(kind, key, payload) {
		this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`).run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString());
		this.kick();
	}
	handle(kind, run, options = {}) {
		if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`);
		this.health.set(kind, this.board.claim(kind));
		const { limit = () => 1, retry = [2e3, 6e4], ordered = false, quiet = false } = options;
		this.handlers.set(kind, {
			run,
			limit: ordered ? () => Math.min(1, limit()) : limit,
			retry,
			ordered,
			quiet
		});
		this.report(kind);
		this.kick();
	}
	pending(kind, key) {
		return key === void 0 ? !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? LIMIT 1").get(kind) : !!this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? AND key = ?").get(kind, key);
	}
	/** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
	cancel(kind, key) {
		this.store.db.prepare("DELETE FROM effect WHERE kind = ? AND key = ?").run(kind, key);
		this.store.afterCommit(() => {
			this.report(kind);
		});
	}
	start() {
		this.started = true;
		this.kick();
	}
	kick() {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.dispatch();
		});
	}
	/** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
	async idle(kind) {
		for (;;) {
			this.dispatch();
			const running = [...this.tasks].filter((task) => kind === void 0 || task.kind === kind).map((task) => task.done);
			if (!running.length) return;
			await Promise.allSettled(running);
		}
	}
	/** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
	async drain() {
		this.stopped = true;
		await Promise.allSettled([...this.tasks].map((task) => task.done));
	}
	dispatch() {
		if (!this.started || this.stopped) return;
		for (const [kind, handler] of this.handlers) try {
			const running = new Set([...this.tasks].filter((task) => task.kind === kind).map((task) => task.key));
			const rows = handler.ordered ? this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1").all(kind) : this.store.db.prepare("SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?").all(kind, this.now(), 16 + running.size);
			const ready = handler.ordered && running.size ? [] : rows.filter((row) => row.due <= this.now() && !running.has(row.key));
			let room = ready.length ? handler.limit() - running.size : 0;
			for (const row of ready) {
				if (room-- <= 0) break;
				this.run(kind, handler, row);
			}
			if (this.broken.delete(kind)) this.report(kind);
		} catch (error) {
			this.failed(kind, error);
		}
	}
	run(kind, handler, row) {
		const task = {
			kind,
			key: row.key,
			done: Promise.resolve()
		};
		task.done = this.attempt(kind, handler, row).catch((error) => {
			this.failed(kind, error);
		}).finally(() => {
			this.tasks.delete(task);
			this.kick();
		});
		this.tasks.add(task);
	}
	async attempt(kind, handler, row) {
		let failure;
		try {
			await handler.run(JSON.parse(row.value), row.key);
		} catch (error) {
			failure = { error };
		}
		const own = "kind = ? AND key = ? AND seq = ? AND generation = ?", ownRow = [
			kind,
			row.key,
			row.seq,
			row.generation
		];
		if (!failure) this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow);
		else if (this.stopped) return;
		else if (failure.error instanceof Later) this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow);
		else {
			const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16));
			this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`).run(String(failure.error).slice(0, 1e3), this.now() + delay, ...ownRow);
		}
		if (!this.stopped) this.report(kind);
	}
	failed(kind, error) {
		this.broken.add(kind);
		this.health.get(kind)?.set({
			state: "error",
			detail: `The effect queue failed: ${String(error)}`,
			at: new Date(this.now()).toISOString()
		});
	}
	report(kind) {
		const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind);
		const waiting = Number(row?.waiting ?? 0);
		const failing = Number(row?.attempts ?? 0) >= 3 && !this.handlers.get(kind)?.quiet;
		const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : "Nothing waiting";
		this.health.get(kind)?.set(failing ? {
			state: "error",
			detail: `${detail}; the last failure: ${String(row?.error)}`,
			at: new Date(this.now()).toISOString()
		} : {
			state: "ready",
			detail,
			at: new Date(this.now()).toISOString()
		});
	}
};
//#endregion
//#region src/sources/admission-context.ts
/** Selects the first five thread messages plus five messages on either side of `sourceId`, recording omitted gap counts. */
function threadWindow(messages, sourceId) {
	const trigger = messages.findIndex((message) => message.id === sourceId);
	const selected = messages.map((message, index) => ({
		message,
		index
	})).filter(({ index }) => index < 5 || trigger >= 0 && Math.abs(index - trigger) <= 5);
	let previous = -1;
	return {
		entries: selected.map(({ message, index }) => {
			const omitted_before = index - previous - 1;
			previous = index;
			return {
				message,
				position: index + 1,
				omitted_before
			};
		}),
		source_found: trigger >= 0,
		loaded_messages: messages.length,
		omitted_after: messages.length - previous - 1
	};
}
/**
* Reads up to `maxPages` of a trigger's thread and builds the bounded message window around the trigger; counts describe
* only this loaded snapshot (never unread history), and `status` reports fallback modes such as `chat_neighbours`.
*/
async function admissionContext(context, commands, maxPages) {
	const messages = [];
	const seen = /* @__PURE__ */ new Set();
	const cursors = /* @__PURE__ */ new Set();
	let next;
	let status;
	let more = true;
	for (let page = 0; more && page < maxPages; page++) {
		const result = await context.read(commands, "thread", next);
		for (const message of result.messages) if (!seen.has(message.id)) {
			seen.add(message.id);
			messages.push(message);
		}
		status ??= result.status;
		next = result.next;
		more = next !== void 0;
		if (next !== void 0 && cursors.has(next)) throw new Error("Thread pagination repeated a cursor; context is incomplete");
		if (next !== void 0) cursors.add(next);
	}
	return {
		messages,
		window: threadWindow(messages, context.messageId),
		complete: !more,
		next: more ? next ?? null : null,
		...status ? { status } : {}
	};
}
//#endregion
//#region src/app/cards.ts
/** Compact, bounded model-facing projections of triggers, tickets, threads, and decisions; full texts stay behind readable resources. */
/** Collapses whitespace and truncates text for display previews while keeping code, angle brackets, and links intact for model readers. */
function preview$1(text) {
	return text.replace(/\s+/g, " ").slice(0, 160);
}
function triggerCard$1(trigger, disposition) {
	return {
		trigger_id: trigger.id,
		source: trigger.source,
		...trigger.url ? { source_url: trigger.url } : {},
		actor: trigger.actor.id,
		thread: threadKey(trigger.threads[0]),
		human: trigger.human,
		at: trigger.at,
		preview: preview$1(trigger.text),
		chars: trigger.text.length,
		read: `trigger/${trigger.id}`,
		...disposition ? { disposition: {
			...disposition.filtered ? { filtered: reasonText(disposition.filtered) } : {},
			...disposition.decisionId ? { decision_id: disposition.decisionId } : {},
			delivered_to: disposition.fanout
		} } : {}
	};
}
function cardState(ticket) {
	if (ticket.ended) return ticket.ended.outcome;
	const stage = ticketStage(ticket);
	if (stage.stage === "person") return `person/${stage.action}`;
	return stage.stage === "idle" ? "idle" : stage.stage === "working" && stage.action ? "working/queued" : "working";
}
function ticketCard(ticket) {
	const ended = ticket.ended && {
		at: ticket.ended.at,
		by: ticket.ended.by,
		reason: ticket.ended.reason ?? ticket.ended.outcome
	};
	const { attention } = ticket;
	return {
		ticket_id: ticket.id,
		title: ticket.title,
		state: cardState(ticket),
		strength: ticket.mandate.strength,
		...pullOf(ticket) ? { pr_number: pullOf(ticket) } : {},
		...ended ? { ended } : {},
		...attention ? { attention: {
			question: attention.question,
			...attention.triggerId ? { trigger_id: attention.triggerId } : {}
		} } : {},
		preview: preview$1(latestReport(ticket)?.summary ?? ""),
		read: `ticket/${ticket.id}`
	};
}
/** Strips `policyVersion`, an internal hash that callers never query by. */
const mandateOf = ({ policyVersion: _version, ...mandate }) => mandate;
const INPUT_TEXT = 80;
/** Summarizes a ticket input inline for short text or as a resource reference, omitting decision IDs for worker Sessions. */
function inputLine(ticket, input, worker = false) {
	const read = { read: inputResource(ticket.id, input.id) };
	const names = input.kind === "trigger" || input.kind === "resumed" ? { trigger_id: input.triggerId } : input.kind === "reopen" && !worker ? { decision_id: input.decisionId } : input.kind !== "text" ? read : input.text.length <= INPUT_TEXT ? { text: input.text } : {
		preview: preview$1(input.text).slice(0, INPUT_TEXT),
		chars: input.text.length,
		...read
	};
	return {
		kind: input.kind,
		at: input.at,
		...names,
		...ticket.undelivered.includes(input.id) ? { undelivered: true } : {}
	};
}
function assignmentLine(ticket, item) {
	return {
		id: item.id,
		state: item.state,
		at: item.createdAt,
		...item.endedReason ? { ended_reason: reasonText({ code: item.endedReason }) } : {},
		...item.report ? { report: {
			state: item.report.state,
			at: item.report.at,
			preview: preview$1(item.report.summary).slice(0, 100),
			chars: item.report.summary.length,
			read: `ticket/${ticket.id}/report/${item.id}`
		} } : {}
	};
}
function newestPage(items, offset, size, line, next) {
	const newest = items.slice().reverse();
	const more = offset + size < newest.length;
	return {
		items: newest.slice(offset, offset + size).map(line),
		...more ? {
			next_resource: next,
			next_offset: offset + size
		} : {}
	};
}
/** Projects a ticket with its linked triggers, threads, and first pages of assignments and inputs, omitting decision IDs for workers. */
function ticketDetails(ticket, threads, batch, worker = false) {
	const { preview: _preview, ...card } = ticketCard(ticket);
	return {
		...card,
		trigger_id: ticket.origin.triggerId,
		...batch.length ? { batch: batch.map(batchLine) } : {},
		...worker ? {} : { decision_id: ticket.decisionId },
		threads,
		directory: ticket.execution?.directory,
		scope: ticket.mandate.scope,
		requested_by: ticket.mandate.actor.id,
		assignments: newestPage(ticket.assignments, 0, 3, (item) => assignmentLine(ticket, item), `ticket/${ticket.id}/assignments`),
		inputs: newestPage(ticket.inputs, 0, 10, (input) => inputLine(ticket, input, worker), `ticket/${ticket.id}/inputs`),
		assignment: `ticket/${ticket.id}/assignment`,
		result: `ticket/${ticket.id}/result`,
		transcript: `ticket/${ticket.id}/transcript`
	};
}
function threadCard(thread, label) {
	return {
		thread: thread.key,
		label,
		source: thread.ref.source,
		tickets: thread.subscriptions,
		...thread.evaluating ? { evaluating: {
			since: thread.evaluating.startedAt,
			deadline: thread.evaluating.deadline
		} } : {},
		pending: thread.pending.length,
		...thread.meta.pollError ? { error: preview$1(String(thread.meta.pollError)) } : {},
		...thread.meta.url ? { url: thread.meta.url } : {},
		read: `thread/${thread.key}`
	};
}
function decisionCard(decision) {
	return {
		decision_id: decision.id,
		kind: decision.kind,
		reason: reasonText(decision.reason),
		strength: decision.strength,
		thread: decision.threadKey,
		trigger_ids: decision.triggerIds,
		...decision.ticketId ? { ticket_id: decision.ticketId } : {},
		at: decision.at,
		read: `decision/${decision.id}`
	};
}
function decisionDetails(decision) {
	return {
		...decisionCard(decision),
		...decision.mandate ? { mandate: mandateOf(decision.mandate) } : {},
		...decision.audit ? { audit: decision.audit } : {}
	};
}
/** Slices text by UTF-16 code units so concatenated pages reconstruct the exact string. */
function textPage(resource, text, offset, limit) {
	const end = Math.min(text.length, offset + limit);
	return {
		resource,
		offset,
		total_chars: text.length,
		next_offset: end < text.length ? end : null,
		text: text.slice(offset, end)
	};
}
function relatedTickets(tickets) {
	return {
		related_tickets: [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1).slice(0, 8).map(ticketCard),
		tickets_total: tickets.length
	};
}
//#endregion
//#region src/infra/paths.ts
/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
let cached;
function packageRoot() {
	if (cached) return cached;
	let directory = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 6; depth++) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) try {
			if (JSON.parse(readFileSync(manifest, "utf8")).name === "dsh-superagent") return cached = directory;
		} catch {}
		directory = dirname(directory);
	}
	throw new Error("dsh-superagent package root not found");
}
const packagePath = (...parts) => join(packageRoot(), ...parts);
//#endregion
//#region src/app/skill-files.ts
/** Loads packaged built-in skill definitions and prompt templates from disk. */
/**
* Reads a packaged text file with normalized Unix line endings.
* @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
*/
function packaged(...parts) {
	const path = packagePath(...parts);
	let text;
	try {
		text = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
	} catch (error) {
		throw error.code === "ENOENT" ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error;
	}
	if (!text.trim()) throw new Error(`Empty packaged file: ${path}`);
	return {
		path,
		text
	};
}
function load(name) {
	const { path, text } = packaged("skills", `dsh-superagent-${name}`, "SKILL.md");
	const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text);
	if (!match) throw new Error(`Invalid packaged skill: ${path}`);
	return {
		name: match[1],
		description: match[2],
		content: match[3],
		path
	};
}
const bundledSkills = {
	feishu: load("feishu"),
	github: load("github")
};
/**
* Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
* readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
*/
function promptFile(name) {
	return packaged("prompts", `${name}.md`).text.trim().split(/\n(?:[ \t]*\n)+/).map((paragraph) => paragraph.split("\n").map((line) => line.trim()).join(" ")).join("\n");
}
//#endregion
//#region src/app/context.ts
/** Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions. */
/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
const sharedPrompt = promptFile("shared");
const masterPrompt = promptFile("orchestrator");
const workerPrompt = promptFile("worker");
/** Built-in policy sections referenced by role prompts; a team may override them. */
const guides = Object.fromEntries([
	"subscriptions",
	"replies",
	"dispatch",
	"work"
].map((name) => [name, promptFile(name)]));
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
const sourceSkills = {
	feishu: bundledSkills.feishu.content,
	github: bundledSkills.github.content
};
const cliNotes = promptFile("cli");
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
const teamDefaults = {
	communication: promptFile("team/communication"),
	scope: promptFile("team/scope"),
	delivery: promptFile("team/delivery")
};
const mainAdmissionPolicy = promptFile("admission");
const handoff = {
	shared: promptFile("handoff"),
	orchestrator: promptFile("handoff-orchestrator"),
	worker: promptFile("handoff-worker")
};
const handoffPolicy = (role) => `${handoff.shared}\n${handoff[role]}`;
const autoMergeThreshold = (lines) => `it changes fewer than ${lines} lines (additions plus deletions);`;
/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
function transcriptEntry(event) {
	if (event.type !== "user/message" && event.type !== "tool/result" && event.type !== "assistant/message") return void 0;
	const message = event.type === "user/message" ? event.data : event.data.message;
	return {
		type: event.type,
		message: {
			role: message.role,
			content: message.content.filter((block) => block.type !== "reasoning")
		}
	};
}
//#endregion
//#region src/app/views/text.ts
/** Text sanitization and formatting helpers for plain-text previews and HTML-free Markdown in views. */
const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	"#39": "'",
	nbsp: " "
};
/** Strips HTML comments and tags, decodes basic entities, and strips again to catch entity-encoded tags. */
const withoutHtml = (text) => text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_match, name) => ENTITIES[name]).replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[a-zA-Z][^>]*>/g, "");
function plain(text, lines = false) {
	const result = withoutHtml(text).replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, "[image]").replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1").replace(/^#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, lines ? "• " : "").replace(/(\*\*|__|`)/g, "");
	return lines ? result.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : result.replace(/\s+/g, " ").trim();
}
const markdown = (text) => withoutHtml(text).replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]/g, "[image]").trim();
const scalar = (value) => value === null || typeof value !== "object";
function inline(value) {
	if (scalar(value)) return value === null ? "" : String(value);
	return (Array.isArray(value) ? value : Object.values(value)).map(inline).filter(Boolean).join(Array.isArray(value) ? ", " : " · ");
}
function jsonLines(value) {
	if (Array.isArray(value) && !value.every(scalar)) return value.map((item) => `- ${inline(item)}`);
	if (value && typeof value === "object" && !Array.isArray(value)) return Object.entries(value).flatMap(([name, item]) => scalar(item) || Array.isArray(item) && item.every(scalar) ? [`${name}: ${inline(item)}`] : [`${name}:`, ...jsonLines(item)]);
	return [inline(value)];
}
/** Formats JSON payloads (or `label: <JSON>` notices) as key-value lines; returns non-JSON text unchanged. */
function readable$1(text) {
	const match = /^(?:([^\n{[]{1,200}): )?(\{[\s\S]*\}|\[[\s\S]*\])$/.exec(text.trim());
	if (!match) return text;
	try {
		return [...match[1] ? [match[1]] : [], ...jsonLines(JSON.parse(match[2]))].join("\n");
	} catch (error) {
		return text;
	}
}
function preview(text, length = 160) {
	return plain(readable$1(text)).slice(0, length);
}
const attribute = (value) => typeof value === "string" && value ? value : void 0;
//#endregion
//#region src/app/views/records.ts
/** Shared view projections for triggers, tickets, threads, decisions, and channel links. */
const page = (items, offset, limit) => ({
	items: items.slice(offset, offset + limit),
	total: items.length,
	next_offset: offset + limit < items.length ? offset + limit : null
});
const DAY = 864e5;
const dayAgo = () => (/* @__PURE__ */ new Date(Date.now() - DAY)).toISOString();
const newestFirst = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
/**
* The owners of follow-ups as one request reads them: the rows of a page share their tickets and Threads, so each is read
* once however many rows it decides.
*/
function ownersOf(store) {
	const once = (read) => {
		const seen = /* @__PURE__ */ new Map();
		return (id) => {
			if (!seen.has(id)) seen.set(id, read(id));
			return seen.get(id);
		};
	};
	const records = {
		tickets: { get: once((id) => store.tickets.get(id)) },
		threads: { get: once((key) => store.threads.get(key)) },
		triggers: store.triggers
	};
	return (trigger) => followupOwners(trigger, records);
}
function snapshot(host) {
	const { store, sources } = host;
	let subscribed;
	const threadsOf = (ticketId) => {
		if (!subscribed) {
			subscribed = /* @__PURE__ */ new Map();
			for (const thread of store.read.subscribedThreads()) for (const id of thread.subscriptions) subscribed.set(id, [...subscribed.get(id) ?? [], thread]);
		}
		return subscribed.get(ticketId) ?? [];
	};
	const settings = store.settings();
	const rules = new Map(settings.policy.rules.map((rule) => [rule.id, rule.name]));
	const named = (name) => ({
		zh: name,
		en: name
	});
	const actor = ({ source, id }, human) => {
		if (!id) return {
			source,
			id
		};
		const entry = allowedSender(settings, {
			source,
			id
		}) ?? listedBot(settings, {
			source,
			id
		});
		if (entry) return {
			source,
			id,
			name: named(entry.name || entry.id)
		};
		const unnamed = sources.kind(source)?.policy?.unnamed;
		return {
			source,
			id,
			name: unnamed ? human === false ? unnamed.bot : unnamed.person : named(id)
		};
	};
	return {
		...host,
		threadsOf,
		rule: (id) => ({
			id,
			name: rules.get(id) ?? id
		}),
		actor,
		owners: ownersOf(store)
	};
}
/**
* The Triggers of a Thread's queue that wait for an Eval: a person's follow-up a ticket still decides, which an older
* version queued, leaves the queue with the next Eval without one.
*/
const awaitingEval = ({ store, owners }, thread) => thread.pending.filter((id) => {
	const trigger = store.triggers.get(id);
	return !trigger || !owners(trigger).length;
});
/**
* A trigger with where it went: queued for Eval, the Decision that consumed it, the Tickets it fanned out to, `delivered`
* when it is a person's follow-up that a ticket's worker decides without an Eval, and the Tickets that handed it back for
* a new Eval, with why; `requeue` when a person may send it to Eval, which is where no Eval reached a judgement: its Source
* filtered it, its Eval was unavailable, a ticket's worker still decides it, or it reached a ticket and nothing decided it,
* such as a message a worker neither acknowledged, answered nor handed back, or one only a stop was decided on.
*/
function triggerView(view, trigger, threadDecisions) {
	const { store } = view;
	const disposition = store.triggers.disposition(trigger.id);
	const home = store.threads.get(threadKey(trigger.threads[0]));
	const decision = disposition?.decisionId ? store.decisions.get(disposition.decisionId) : (threadDecisions ?? (home ? store.decisions.byThread(home.key) : [])).filter((item) => item.triggerIds.includes(trigger.id)).at(-1);
	const delivered = view.owners(trigger).length > 0;
	const queued = !!home?.pending.includes(trigger.id) && !delivered;
	const evaluating = !!home?.evaluating?.triggerIds.includes(trigger.id);
	const decided = !!disposition?.acked?.length || !!decision && settled(decision);
	const unjudged = !!disposition?.filtered || decision?.kind === "unavailable" || delivered || !!disposition?.fanout.length && !decided || !!decision && !decided;
	const requeue = trigger.human && !queued && !evaluating && unjudged;
	return {
		id: trigger.id,
		source: trigger.source,
		actor: view.actor(trigger.actor, trigger.human),
		human: trigger.human,
		at: trigger.at,
		text: plain(readable$1(trigger.text), true),
		preview: preview(trigger.text),
		url: trigger.url,
		threads: trigger.threads.map(threadKey),
		actions: { requeue },
		disposition: {
			queued,
			evaluating,
			delivered,
			filtered: disposition?.filtered,
			fanout: disposition?.fanout ?? [],
			handbacks: (disposition?.handbacks ?? []).map((item) => ({
				...item,
				title: store.tickets.get(item.ticketId)?.title ?? item.ticketId
			})),
			decision: decision ? {
				id: decision.id,
				outcome: outcomeOf(decision),
				reason: decision.reason,
				ticketId: decision.ticketId
			} : void 0
		}
	};
}
/** Single-line summary of why a ticket in the `person` stage is waiting on human action (omitted once answered and back with the Executor). */
function ticketNote(ticket, stage) {
	if (stage.stage !== "person") return void 0;
	if (stage.action === "answer" && ticket.attention) return {
		text: preview(ticket.attention.question),
		error: false
	};
	if (stage.action === "delivery" && ticket.delivery) return {
		text: preview(ticket.delivery.error),
		error: true
	};
	const summary = latestReport(ticket)?.summary;
	if (stage.action !== "blocked" && stage.action !== "failed" || !summary) return void 0;
	return {
		text: preview(summary.split("\n")[0]),
		error: stage.action === "failed"
	};
}
function ticketSummary(ticket) {
	const stage = ticketStage(ticket);
	const note = ticketNote(ticket, stage);
	const state = liveTicket(ticket) ? "open" : "ended";
	return {
		id: ticket.id,
		title: ticket.title,
		state,
		...stage,
		...note ? { note } : {},
		actions: {
			retry: canRetry(ticket),
			stop: liveTicket(ticket)
		},
		strength: ticket.mandate.strength,
		ended: ticket.ended,
		attention: ticket.attention && {
			...ticket.attention,
			question: markdown(ticket.attention.question)
		},
		assignments: ticket.assignments.length,
		inputs: ticket.inputs.length,
		undelivered: ticket.undelivered.length,
		deliveryError: attribute(ticket.delivery?.error),
		sessionId: ticket.assignments.some((item) => item.startedAt) ? workerSessionId(ticket.id) : "",
		directory: attribute(ticket.execution?.directory),
		summary: latestReport(ticket)?.summary ?? "",
		createdAt: ticket.createdAt,
		updatedAt: ticket.updatedAt
	};
}
function threadUrl(store, thread) {
	return attribute(thread.meta.url) ?? store.read.firstTrigger(thread.key)?.url;
}
function threadFacts(store, thread) {
	const url = threadUrl(store, thread);
	return {
		key: thread.key,
		source: thread.ref.source,
		title: threadTitle(store, thread),
		...url ? { url } : {},
		facts: thread.meta.facts ?? {}
	};
}
const ticketLine = (view, ticket) => ({
	...ticketSummary(ticket),
	threads: view.threadsOf(ticket.id).map((thread) => threadFacts(view.store, thread))
});
function threadTitle(store, thread) {
	const label = attribute(thread.meta.label);
	if (label) return label;
	const first = store.read.firstTrigger(thread.key, true) ?? store.read.firstTrigger(thread.key);
	return first ? preview(first.text, 80) : thread.key;
}
function latestOnThread(view, thread) {
	const trigger = view.store.read.threadTriggers(thread.key, 1)[0];
	if (!trigger) return void 0;
	return {
		actor: view.actor(trigger.actor, trigger.human),
		human: trigger.human,
		at: trigger.at,
		preview: preview(trigger.text, 120)
	};
}
function threadStage(thread, pending, tickets) {
	if (attribute(thread.meta.pollError)) return "error";
	if (thread.evaluating) return "evaluating";
	if (pending) return "queued";
	if (tickets.some((ticket) => ticket.state === "open")) return "subscribed";
	return tickets.length ? "dormant" : "unsubscribed";
}
function threadSummary(view, thread) {
	const { store } = view;
	const tickets = thread.subscriptions.map((id) => {
		const ticket = store.tickets.get(id);
		return {
			id,
			title: ticket?.title ?? id,
			state: !ticket ? "unknown" : liveTicket(ticket) ? "open" : "ended"
		};
	});
	const pending = awaitingEval(view, thread).length;
	return {
		key: thread.key,
		source: thread.ref.source,
		title: threadTitle(store, thread),
		stage: threadStage(thread, pending, tickets),
		latest: latestOnThread(view, thread),
		lastAt: thread.lastAt ?? thread.createdAt,
		createdAt: thread.createdAt,
		subscriptions: thread.subscriptions.length,
		tickets,
		evaluating: thread.evaluating ? {
			id: thread.evaluating.id,
			strength: thread.evaluating.strength,
			triggers: thread.evaluating.triggerIds.length,
			startedAt: thread.evaluating.startedAt,
			deadline: thread.evaluating.deadline
		} : void 0,
		pending,
		pollError: attribute(thread.meta.pollError),
		url: threadUrl(store, thread),
		facts: thread.meta.facts ?? {}
	};
}
/** Resolves a channel link, preferring the specific trigger URL when the source link references a trigger. */
function channelLink({ store, links }, channel) {
	const { url, label, triggerId } = links(channel);
	return {
		source: channel.source,
		url: triggerId && store.triggers.get(triggerId)?.url || url,
		label
	};
}
/** Parses stored assessment audit metadata, tolerating fields omitted or shaped differently by older versions. */
const AuditSchema = z.object({
	would_accept: z.boolean().optional().catch(void 0),
	rule_assessments: z.array(z.object({
		rule_id: z.string(),
		matched: z.boolean(),
		reason: z.string()
	})).optional().catch(void 0),
	matches: z.array(z.object({
		rule_id: z.string(),
		reason: z.string()
	})).optional().catch(void 0),
	direction: z.object({
		implementation_requested: z.boolean(),
		target_basis: z.string(),
		requires_design_decision: z.boolean(),
		evidence: z.string()
	}).optional().catch(void 0)
}).catch({});
const outcomeOf = (decision) => decision.kind === "ignore" && AuditSchema.parse(decision.audit ?? {}).would_accept ? "wouldAccept" : decision.kind;
function decisionView(view, decision) {
	const { store } = view;
	const thread = store.threads.get(decision.threadKey);
	const texts = decision.triggerIds.flatMap((id) => {
		const trigger = store.triggers.get(id);
		return trigger ? [preview(trigger.text)] : [];
	});
	const audit = AuditSchema.parse(decision.audit ?? {});
	const judged = audit.rule_assessments ?? audit.matches?.map((match) => ({
		...match,
		matched: true
	})) ?? [];
	return {
		id: decision.id,
		kind: decision.kind,
		outcome: outcomeOf(decision),
		reason: decision.reason,
		at: decision.at,
		strength: decision.strength,
		ticketId: decision.ticketId,
		triggerIds: decision.triggerIds,
		thread: decision.threadKey,
		rules: judged.map((rule) => ({
			...view.rule(rule.rule_id),
			matched: rule.matched,
			reason: rule.reason
		})),
		...audit.direction ? { direction: audit.direction } : {},
		...thread ? { threadTitle: threadTitle(store, thread) } : {},
		preview: texts.join(" / "),
		ticketTitle: decision.ticketId ? store.tickets.get(decision.ticketId)?.title : void 0
	};
}
//#endregion
//#region src/app/links.ts
/** Resolves and caches a trigger's external message URL, falling back to a readable resource path when lookup fails. */
async function sourceLink(host, trigger, signal) {
	if (trigger.url) return { source_url: trigger.url };
	const ref = feishuRef(trigger);
	if (!ref) return {};
	const cacheKey = `${ref.chatId}:${ref.messageId}`;
	const cached = host.links.get(cacheKey);
	if (cached) return { source_url: cached };
	let url;
	try {
		const timeout = AbortSignal.timeout(feishuSettings(host.sources).linkTimeoutMs);
		url = await readFeishuLink(host.commands.withSignal(AbortSignal.any([signal ?? host.lifetime, timeout])), ref);
	} catch {
		host.lifetime.throwIfAborted();
		signal?.throwIfAborted();
		return { source_url_read: `feishu/${trigger.id}/message` };
	}
	host.links.set(cacheKey, url);
	return { source_url: url };
}
function repliedTo({ store, sources }, trigger) {
	const parent = sources.repliesTo(trigger);
	return parent === void 0 ? void 0 : store.triggers.get(parent);
}
/** Finds tickets subscribed to threads referenced in `trigger.text` (such as `#12` or URLs) that are not already in `known`. */
function referencedTickets(host, trigger, known) {
	const threads = (trigger.text.match(/#\d+|https?:\/\/[^\s)>\]]+/g) ?? []).flatMap((reference) => host.sources.find(reference).threads);
	const ids = new Set(threads.flatMap((thread) => host.store.threads.get(thread)?.subscriptions ?? []));
	for (const ticket of known) ids.delete(ticket.id);
	return [...ids].flatMap((id) => host.store.tickets.get(id) ?? []).slice(0, 4);
}
/** Builds the main Session's candidate card with routing metadata, handback history, and related or referenced tickets. */
async function candidateCard(host, candidate) {
	const primary = candidate.triggers.at(-1);
	const settings = host.store.settings();
	const delivered = host.store.triggers.disposition(primary.id)?.fanout ?? [];
	const referenced = referencedTickets(host, primary, candidate.tickets);
	const handedBack = candidate.triggers.flatMap((trigger) => (host.store.triggers.disposition(trigger.id)?.handbacks ?? []).map((item) => ({
		trigger_id: trigger.id,
		ticket_id: item.ticketId,
		reason: item.reason
	})));
	const others = candidate.triggers.filter((trigger) => trigger.id !== primary.id);
	return {
		...triggerMessage(primary, await sourceLink(host, primary), void 0, repliedTo(host, primary)),
		strength: candidate.strength,
		mode: settings.eval.mode,
		...others.length ? { batch: others.map((trigger) => triggerCard$1(trigger)) } : {},
		...handedBack.length ? { handed_back: handedBack } : {},
		...relatedTickets(candidate.tickets),
		...delivered.length ? { delivered_to: delivered } : {},
		...referenced.length ? { referenced_tickets: referenced.map(ticketCard) } : {},
		next_action: candidate.strength === "explicit" ? "Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore." : "Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide."
	};
}
//#endregion
//#region src/app/notices.ts
/** Formats background notices and steering relays delivered to the main Session via the effect queue. */
/** Builds a notice for a saved prompt configuration revision, coalescing under `'prompts'`. */
const promptsNotice = (revision) => [
	"prompts",
	{
		prompt_config_saved: revision,
		effect: "next-request",
		read: `prompts/${revision}`
	},
	`Prompt configuration saved (revision ${revision})`
];
/**
* Builds a notice for a saved settings block with the changed dot-separated paths (coalescing per block under
* `settings:<block>`), or for the whole settings on legacy saves that recorded no block.
*/
const settingsNotice = (block, changed = []) => block ? [
	`settings:${block}`,
	{
		settings_saved: block,
		changed,
		read: `settings/${block}`
	},
	`Settings saved: ${block}`
] : [
	"settings",
	{
		settings_saved: true,
		read: "settings"
	},
	"Settings saved"
];
/** Returns up to 20 dot-separated paths where two values differ (e.g. `eval.mode` or `policy.rules.1.enabled`). */
function changedPaths(before, after, path = "") {
	if (JSON.stringify(before) === JSON.stringify(after)) return [];
	if (!before || !after || typeof before !== "object" || typeof after !== "object") return [path];
	const keys = [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])];
	const at = (value, name) => value[name];
	return keys.flatMap((name) => changedPaths(at(before, name), at(after, name), path ? `${path}.${name}` : name)).slice(0, 20);
}
/** Strips the latest report preview from a ticket card when the relay already carries or does not need the summary. */
function brief(ticket) {
	const { preview: _preview, ...card } = ticketCard(ticket);
	return card;
}
/** Creates a one-off receipt notice with a unique `name` key so repeated occurrences of the same event are each delivered instead of coalescing. */
const receiptNotice = (value, summary) => [
	key("receipt", randomUUID()),
	value,
	summary
];
/** Builds a notice that a person removed a thread's subscriptions at `at`; a later removal of the same thread replaces an unsent waiting notice. */
const subscriptionNotice = (thread, at) => [
	`subscription:${thread}`,
	{
		subscription_changes: [{
			thread,
			removed: true
		}],
		...at ? { at } : {}
	},
	`Removed the subscriptions on thread ${thread}`
];
/**
* Converts an unsolicited domain event into a main-Session notice (`ticket.ended`, `trigger.requeued`, or
* `thread.unsubscribed` by a person or executor); returns `undefined` for events that require no notice.
*/
function eventNotice(event, ticket = () => void 0) {
	const { at } = event;
	if (event.type === "ticket.ended") {
		const { ticketId, by, outcome, reason = outcome } = event.data;
		const ended = ticket(ticketId);
		return receiptNotice(ended ? { ticket_ended: brief(ended) } : {
			ticket_ended: ticketId,
			by,
			outcome,
			reason,
			at
		}, `Ticket ${ticketId} ended (${reason})`);
	}
	if (event.type === "trigger.requeued") {
		const id = event.data.triggerId;
		return receiptNotice({
			trigger_requeued: id,
			read: `trigger/${id}`,
			at
		}, `Trigger ${id} queued for a fresh assessment`);
	}
	if (event.type === "thread.unsubscribed" && event.data.by === "person") return subscriptionNotice(event.data.threadKey, at);
	if (event.type === "thread.unsubscribed") {
		const { ticketId, threadKey: thread, reason } = event.data;
		return receiptNotice({
			thread_unrelated: {
				ticket_id: ticketId,
				thread,
				reason
			},
			at,
			note: "Its Executor found this thread unrelated after reading it; attach later triggers there to this ticket only when they point at it explicitly."
		}, `Ticket ${ticketId} no longer follows thread ${thread}: ${reason}`);
	}
}
/** Builds a background notice when a ticket's worker subscribes to a related thread for context only. */
const threadFollowedNotice = (ticketId, thread, reason) => receiptNotice({
	thread_followed: {
		ticket_id: ticketId,
		thread,
		reason
	},
	note: "For context only: its messages reach this ticket and grant nothing."
}, `Ticket ${ticketId} follows thread ${thread} for context: ${reason}`);
/** What a follow-up asks of the main Session: nothing but a stop the person asks for, since its ticket's worker decides it. */
const FOLLOWUP_NOTE = "Its ticket's worker has it and decides; act only if the person asks to stop the work (orchestrator_route kind stop with this trigger_id).";
/**
* Builds a steering relay for a human follow-up trigger that reached at least one live ticket (including an ended ticket
* that resumed on the follow-up), with the trigger rendered as workers read it, the replied-to message, and the open
* tickets it reached; returns `undefined` while no ticket's worker decides it (see `followupOwners`) or it reached no live ticket.
*/
function followupNotice(store, sources, triggerId) {
	const trigger = store.triggers.get(triggerId);
	const disposition = store.triggers.disposition(triggerId);
	if (!trigger || !followupOwners(trigger, store).length) return void 0;
	const tickets = disposition.fanout.flatMap((id) => {
		const ticket = store.tickets.get(id);
		const context = disposition.context?.includes(id) ? { context: true } : {};
		return ticket && liveTicket(ticket) ? [{
			ticket_id: id,
			title: ticket.title,
			state: ticketCard(ticket).state,
			...context
		}] : [];
	});
	if (!tickets.length) return void 0;
	return followupRelay(triggerMessage(trigger, {}, void 0, repliedTo({
		store,
		sources
	}, trigger)), tickets);
}
/**
* A person's message that reached tickets, as the main Session hears of it: the message as their workers read it, and the
* tickets it reached with their state. Their workers decide it; the main Session may only stop the work on it.
*/
function followupRelay(message, tickets) {
	return {
		id: `followup:${message.trigger_id}`,
		text: JSON.stringify({
			kind: "follow_up",
			...message,
			delivered_to: tickets,
			note: FOLLOWUP_NOTE
		})
	};
}
/** Formats a worker report relay for the main Session (truncating summaries over 600 characters behind `ticket/<id>/result`); `replyTo` names the human question trigger it answers. */
function resultRelay(ticket, state, text, replyTo) {
	const id = key("worker-result", ticket.id, ticket.updatedAt, text);
	const summary = text.length > 600 ? {
		summary: text.slice(0, 600),
		chars: text.length
	} : { summary: text };
	const report = {
		kind: "worker_report",
		ticket: brief(ticket),
		trigger_id: ticket.origin.triggerId,
		state,
		...replyTo ? { answer_to: replyTo } : {},
		...summary,
		read: `ticket/${ticket.id}/result`
	};
	return {
		id: `report:${id}`,
		text: JSON.stringify(report)
	};
}
/**
* Converts a worker report recorded on `ticket` into a main-Session relay: a question for a person produces a
* `worker_attention` relay, and a result, blocker, end, or answer to a question produces a `worker_report` relay, while
* routine `progress` reports without `answers` stay internal.
* @returns The steering `Relay`, or `undefined` when the report is not relayed to the main Session.
*/
function reportRelay(ticket, report) {
	const asked = report.question ? ticket.attention : void 0;
	if (asked) return {
		id: `attention:${ticket.id}:${asked.id}`,
		text: JSON.stringify({
			kind: "worker_attention",
			ticket: brief(ticket),
			state: report.state,
			read: `ticket/${ticket.id}/result`
		})
	};
	if (report.state === "progress" && !report.answers) return void 0;
	return resultRelay(ticket, report.state, report.summary, report.answers);
}
//#endregion
//#region src/app/versions.ts
/**
* Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
* Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
* Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
*/
var Versions = class {
	store;
	pointer;
	family;
	constructor(store, pointer, family) {
		this.store = store;
		this.pointer = pointer;
		this.family = family;
	}
	/** Current revision number, or `0` before the first save. */
	revision() {
		return this.store.get(this.pointer) ?? 0;
	}
	/** Current snapshot, or `undefined` before the first save. */
	current() {
		const revision = this.store.get(this.pointer);
		return revision === void 0 ? void 0 : this.get(revision);
	}
	get(revision) {
		return this.store.get(this.family(revision));
	}
	save(make) {
		return this.store.atomic(() => {
			const version = make(this.revision() + 1);
			this.store.set(this.family(version.revision), version);
			this.store.set(this.pointer, version.revision);
			return version;
		});
	}
	/** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
	keep(version) {
		this.store.set(this.family(version.revision), version);
	}
	list(limit = Infinity) {
		return this.store.keys(this.family).flatMap((name) => this.store.get(name) ?? []).sort((a, b) => b.revision - a.revision).slice(0, limit);
	}
};
//#endregion
//#region src/app/prompts.ts
/** Manages versioned role prompts, behavioral policies, and operational skills independently of access settings. */
/** Prompt sections the team writes; the built-in parts follow dsh-superagent's text until the team overrides them. */
const TEAM_SECTIONS = [
	"communication",
	"scope",
	"delivery"
];
/** Markdown headings for each team section; fixed prompt sections refer to them by these exact names. */
const TEAM_HEADINGS = {
	communication: "Communication",
	scope: "Ticket scope",
	delivery: "Delivery requirements"
};
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
/** Prefix prepended to skill names when registering them in DSH Sessions. */
const SKILL_PREFIX = "dsh-superagent-";
const SkillNameSchema = z.string().regex(SKILL_NAME).refine((name) => !Object.keys(sourceSkills).includes(name), "This name belongs to a built-in skill");
/** A team's text for a built-in part, and `base`, the key of the built-in text it was edited from. */
const OverrideSchema = z.object({
	text: z.string(),
	base: z.string().optional().describe("Key of the built-in text it was edited from; copy as read, or omit.")
}).strict();
/**
* A configuration, whose overrides may name a part a later version no longer has, which `Prompts.validate` drops when the
* saved version holds it and refuses otherwise.
*/
const PromptConfigSchema = z.object({
	communication: z.string(),
	scope: z.string(),
	delivery: z.string(),
	skills: z.record(SkillNameSchema, z.string()),
	overrides: z.record(z.string(), OverrideSchema).optional().describe("Text in place of a built-in part, by its key in prompts/defaults; a part not named follows its built-in text.")
}).strict();
const defaultPrompts = () => ({
	...teamDefaults,
	skills: {}
});
const ENVIRONMENT_HEADING = "Execution environment (from this installation's settings; it takes precedence over any repository or account named elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a ticket directory reads the same variables:";
const POLICY_HEAD = "## Policy\nPolicy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.";
const BOTH = ["orchestrator", "worker"];
const MAIN = ["orchestrator"];
const WORKER = ["worker"];
let parts;
/**
* The built-in parts of both roles' prompts, the two Source skills, and the templates of the generated parts, whose data the
* system fills in, by the key an override names them by. Built on first use, as the texts it reads are imported in a cycle.
*/
const builtInParts = () => parts ??= {
	"runtime/shared": {
		roles: BOTH,
		text: sharedPrompt
	},
	"runtime/orchestrator": {
		roles: MAIN,
		text: masterPrompt
	},
	"runtime/worker": {
		roles: WORKER,
		text: workerPrompt
	},
	"runtime/subscriptions": {
		roles: BOTH,
		text: `## subscriptions\n${guides.subscriptions}`
	},
	"runtime/replies": {
		roles: BOTH,
		text: `## replies\n${guides.replies}`
	},
	"runtime/dispatch": {
		roles: MAIN,
		text: `## dispatch\n${guides.dispatch}`
	},
	"runtime/work": {
		roles: WORKER,
		text: `## work\n${guides.work}`
	},
	"runtime/admission": {
		roles: MAIN,
		text: mainAdmissionPolicy
	},
	"runtime/handoff/orchestrator": {
		roles: MAIN,
		text: handoffPolicy("orchestrator")
	},
	"runtime/handoff/worker": {
		roles: WORKER,
		text: handoffPolicy("worker")
	},
	"runtime/environment": {
		roles: BOTH,
		text: `${ENVIRONMENT_HEADING}\n{variables}`,
		placeholders: ["{variables}"]
	},
	"runtime/policy": {
		roles: MAIN,
		text: `${POLICY_HEAD} The enabled rules, by name and id:\n{rules}`,
		placeholders: [
			"{version}",
			"{mode}",
			"{rules}"
		]
	},
	"runtime/policy/none": {
		roles: MAIN,
		text: `${POLICY_HEAD} No rule is enabled: a proactive candidate can only be ignored.`,
		placeholders: ["{version}", "{mode}"]
	},
	"skill/feishu": {
		roles: BOTH,
		text: `${sourceSkills.feishu}\n\n## CLI usage\n${cliNotes}`
	},
	"skill/github": {
		roles: BOTH,
		text: `${sourceSkills.github}\n\n## CLI usage\n${cliNotes}`
	}
};
/** The key of a built-in text, which an override's `base` records. */
const builtInBase = (text) => key("prompt-built-in", text);
/** The built-in part a key names, if any; a name an object's prototype has names none. */
const builtInPart = (part) => Object.hasOwn(builtInParts(), part) ? builtInParts()[part] : void 0;
/** The text of a built-in part: the team's override, else the built-in one. */
const builtIn = (config, part) => (config.overrides && Object.hasOwn(config.overrides, part) ? config.overrides[part].text : void 0) ?? builtInParts()[part].text;
/** Fill a template's placeholders in one pass, so text filled in is not read for placeholders again. */
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? values[name] : match);
/** The execution environment part: its template with the variables, or, while setup waits, that it waits. */
function environmentSection(config, variables) {
	return variables ? fill(builtIn(config, "runtime/environment"), { variables: environmentLines(variables) }) : "Execution environment: dsh-superagent is waiting for setup; the management panel names what is missing.";
}
/**
* The main Session's Policy section: the Policy version and accept mode it judges proactive candidates by, and every enabled
* rule, as the settings hold them, each on one line, so a line of an instruction reads as no rule or heading of its own; the
* settings bound each instruction (`LIMITS.ruleInstruction`). `key` names the template it was filled from.
*/
function policySection(settings, config = defaultPrompts()) {
	const line = (text) => text.replace(/\s*\n\s*/g, " ");
	const rules = settings.policy.rules.filter((rule) => rule.enabled).map(({ id, name, instruction }) => `- ${line(name)} (${id}): ${line(instruction)}`);
	const part = rules.length ? "runtime/policy" : "runtime/policy/none";
	return {
		key: part,
		text: fill(builtIn(config, part), {
			version: policyVersion(settings),
			mode: settings.eval.mode,
			rules: rules.join("\n")
		})
	};
}
/**
* Assemble a role's system prompt sections in order from fixed templates, team sections, the generated execution environment
* and, last, the main Session's generated Policy section, which nothing follows, and whose change leaves the rest unchanged.
*/
function promptParts(config, role, environment, policy) {
	const fixed = (name, part = name) => ({
		name,
		kind: "fixed",
		key: part,
		text: builtIn(config, part)
	});
	const team = (name) => ({
		name,
		kind: "team",
		heading: `## ${TEAM_HEADINGS[name]}`,
		text: config[name] ? `## ${TEAM_HEADINGS[name]}\n${config[name]}` : ""
	});
	return [
		fixed("runtime/shared"),
		fixed(`runtime/${role}`),
		...TEAM_SECTIONS.map(team),
		...[
			"subscriptions",
			"replies",
			role === "orchestrator" ? "dispatch" : "work"
		].map((name) => fixed(`runtime/${name}`)),
		...role === "orchestrator" ? [fixed("runtime/admission")] : [],
		fixed("runtime/handoff", `runtime/handoff/${role}`),
		...environment ? [{
			name: "runtime/environment",
			kind: "generated",
			key: "runtime/environment",
			text: environment
		}] : [],
		...role === "orchestrator" && policy ? [{
			name: "runtime/policy",
			kind: "generated",
			...policy
		}] : []
	].filter((part) => part.text);
}
function composePrompt(config, role, environment, policy) {
	return promptParts(config, role, environment, policy).map((part) => part.text).join("\n\n");
}
function composeSkill(config, name) {
	return name === "feishu" || name === "github" ? builtIn(config, `skill/${name}`) : config.skills[name] ?? "";
}
/**
* Indicates an optimistic concurrency conflict when saving a prompt configuration against a stale base revision.
* Thrown by `Prompts.save` and translated into an HTTP 409 response by the management routes.
*/
var PromptConflict = class extends Error {};
/**
* Stores numbered prompt configurations in `Store` via `Versions` and composes role system prompts and skills with the execution environment.
* `Sessions` reads the composed prompts and skills for orchestrator and worker runs, while management routes and tools validate, preview, and save revisions through it.
*/
var Prompts = class {
	store;
	maxChars;
	environment;
	feishu;
	versions;
	constructor(store, maxChars, environment, feishu) {
		this.store = store;
		this.maxChars = maxChars;
		this.environment = environment;
		this.feishu = feishu;
		this.versions = new Versions(store, KV.prompts.revision, KV.prompts.version);
	}
	/** A role's prompt; the main Session's Policy section follows the settings as they are now, at each model request. */
	compose(config, role, variables = this.environment()) {
		return composePrompt(config, role, environmentSection(config, variables), role === "orchestrator" ? policySection(this.store.settings(), config) : void 0);
	}
	/** Returns skills to register in every Session: built-in Source skills (`feishu` only when a Feishu bot is configured) followed by team skills. */
	skills(config) {
		return [
			...this.feishu() ? ["feishu"] : [],
			"github",
			...Object.keys(config.skills)
		].map((name) => [name, composeSkill(config, name)]);
	}
	current() {
		const revision = this.versions.revision();
		return revision ? this.version(revision) : {
			revision: 0,
			previousRevision: null,
			savedAt: "",
			source: "defaults",
			config: defaultPrompts()
		};
	}
	/** Reads a revision by number; revision 0 resolves to built-in defaults before the first save persists it. */
	version(revision) {
		const version = this.versions.get(revision) ?? (revision === 0 && this.versions.revision() === 0 ? this.current() : void 0);
		if (!version) throw new UserError("unknownPromptRevision", { revision: String(revision) });
		return version;
	}
	/**
	* Parse a configuration: an override names a built-in part, holds text and keeps its template's placeholders, and records the
	* built-in text it was edited from: the saved override's unless it names one, else the current one. It goes once its text is
	* the built-in text again, and so does one of a part this version no longer has, which the saved version holds.
	*/
	validate(value) {
		const { overrides, ...config } = PromptConfigSchema.parse(value);
		const saved = this.current().config.overrides ?? {};
		const kept = Object.entries(overrides ?? {}).flatMap(([name, override]) => {
			const part = builtInPart(name);
			if (!part && Object.hasOwn(saved, name)) return [];
			if (!part) throw new UserError("unknownPromptPart", { part: name });
			if (!override.text.trim()) throw new UserError("promptPartEmpty", { part: name });
			const missing = (part.placeholders ?? []).filter((placeholder) => !override.text.includes(placeholder));
			if (missing.length) throw new UserError("promptPlaceholders", {
				part: name,
				placeholders: missing.join(", ")
			});
			const base = override.base ?? (Object.hasOwn(saved, name) ? saved[name].base : void 0) ?? builtInBase(part.text);
			return override.text === part.text ? [] : [[name, {
				text: override.text,
				base
			}]];
		});
		const result = {
			...config,
			...kept.length ? { overrides: Object.fromEntries(kept) } : {}
		};
		const limit = this.maxChars();
		if (JSON.stringify(result).length > limit) throw new UserError("promptTooLong", { limit: String(limit) });
		return result;
	}
	/**
	* The overrides of `config` whose built-in part changed since the team edited it, by the `base` they were edited from, each
	* with the built-in text of that base when this installation kept it, and those of a part this version no longer has.
	*/
	defaultChanged(config) {
		return Object.entries(config.overrides ?? {}).flatMap(([part, { base }]) => {
			const now = builtInPart(part);
			if (!now) return [{
				part,
				...base === void 0 ? {} : { base },
				removed: true
			}];
			if (base === void 0 || base === builtInBase(now.text)) return [];
			const previous = this.store.get(KV.prompts.builtIn(base));
			return [{
				part,
				base,
				...previous === void 0 ? {} : { previous }
			}];
		});
	}
	preview(value) {
		const config = this.validate(value);
		const environment = environmentSection(config, this.environment()), policy = policySection(this.store.settings(), config);
		return {
			orchestrator: composePrompt(config, "orchestrator", environment, policy),
			worker: composePrompt(config, "worker", environment),
			parts: {
				orchestrator: promptParts(config, "orchestrator", environment, policy),
				worker: promptParts(config, "worker", environment)
			},
			skills: Object.fromEntries(this.skills(config)),
			scope: "Team sections, skills, and overrides of built-in parts, which follow their built-in text until overridden. Workers additionally inherit the host prompt and repository AGENTS.md. Prompt text changes what the agents are told, not what dsh-superagent allows: tool permissions, the gate and account wrappers stay."
		};
	}
	save(value, baseRevision, source) {
		const config = this.validate(value);
		return this.store.atomic(() => {
			const previous = this.current();
			if (previous.revision !== baseRevision) throw new PromptConflict(`Prompt version changed to ${previous.revision}; compare the latest version before saving`);
			if (previous.revision === 0 && !this.versions.get(0)) this.versions.keep(previous);
			for (const [part, { base }] of Object.entries(config.overrides ?? {})) {
				const text = builtInParts()[part].text;
				if (base === builtInBase(text) && this.store.get(KV.prompts.builtIn(base)) === void 0) this.store.set(KV.prompts.builtIn(base), text);
			}
			return this.versions.save((revision) => ({
				revision,
				previousRevision: previous.revision,
				savedAt: (/* @__PURE__ */ new Date()).toISOString(),
				source,
				config
			}));
		});
	}
	history(offset = 0, limit = 20) {
		const current = this.current();
		const revisions = Array.from({ length: Math.min(limit, Math.max(0, current.revision + 1 - offset)) }, (_, i) => {
			const version = current.revision - offset - i === 0 && current.revision === 0 ? current : this.version(current.revision - offset - i);
			const { config, ...summary } = version;
			const previous = version.previousRevision === null ? void 0 : this.versions.get(version.previousRevision)?.config;
			if (version.legacy || version.previousRevision !== null && this.versions.get(version.previousRevision)?.legacy) return {
				...summary,
				changed: ["legacy"]
			};
			const entries = (value) => ({
				communication: value.communication,
				scope: value.scope,
				delivery: value.delivery,
				...Object.fromEntries(Object.entries(value.skills).map(([name, text]) => ["skill/" + name, text])),
				...Object.fromEntries(Object.entries(value.overrides ?? {}).map(([part, override]) => [part, JSON.stringify(override)]))
			});
			const before = previous ? entries(previous) : {};
			const after = entries(config);
			const changed = previous ? [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]) : [];
			return {
				...summary,
				changed
			};
		});
		return {
			revisions,
			next_offset: offset + revisions.length <= current.revision ? offset + revisions.length : null
		};
	}
};
/** Save a new prompt revision and notify the main Session when the change originated outside its own tool call. */
async function savePrompts(host, config, baseRevision, origin) {
	return {
		revision: host.store.atomic(() => {
			const saved = host.prompts.save(config, baseRevision, origin);
			if (origin !== "tool") host.sessions.notify(...promptsNotice(saved.revision));
			return saved;
		}).revision,
		effect: "next-request",
		context_delivery: await host.sessions.delivery("prompts")
	};
}
//#endregion
//#region src/app/resources.ts
/** Resource descriptors exposed via orchestrator_read, marking which resources worker sessions may also read for their own ticket. */
const RESOURCES = [
	{
		name: "tickets",
		holds: "ticket cards, newest first; a card's state is person/review after a ready report, person/blocked or person/failed after those reports, person/answer with a question, person/delivery when an input could not reach the worker, working or working/queued while it works, idle once the worker ended its turn without a report, else how the ticket ended"
	},
	{
		name: "triggers",
		holds: "trigger cards with where each went, newest first"
	},
	{
		name: "threads",
		holds: "subscribed threads, newest activity first, with their labels, tickets, current assessment and polling errors"
	},
	{
		name: "thread/<key>",
		holds: "one thread: its label and link, its tickets and latest decisions, and its triggers, newest first",
		executor: true
	},
	{
		name: "decisions",
		holds: "decisions, newest first"
	},
	{
		name: "decision/<id>",
		holds: "one decision with its audit"
	},
	{
		name: "ticket/<id>",
		holds: "a ticket's card, the trigger, decision and threads it is tied to, its latest assignments with the start of each report, and its inputs, newest first",
		executor: true
	},
	{
		name: "ticket/<id>/assignment",
		holds: "its assignment text",
		executor: true
	},
	{
		name: "ticket/<id>/assignments",
		holds: "its assignments, newest first, with the start of each report",
		executor: true
	},
	{
		name: "ticket/<id>/inputs",
		holds: "its inputs, newest first",
		executor: true
	},
	{
		name: "ticket/<id>/result",
		holds: "its latest report",
		executor: true
	},
	{
		name: "ticket/<id>/report/<id>",
		holds: "the report of one of its assignments",
		executor: true
	},
	{
		name: "ticket/<id>/transcript",
		holds: "its Executor Session's messages, newest first",
		executor: true
	},
	{
		name: "ticket/<id>/message/<n>",
		holds: "one message of that transcript",
		executor: true
	},
	{
		name: "ticket/<id>/input/<id>",
		holds: "one input it was delivered",
		executor: true
	},
	{
		name: "trigger/<id>",
		holds: "a trigger's text, where it went, the message it replies to and the messages around it on its thread",
		executor: true
	},
	{
		name: "settings",
		holds: "settings by block, each with the revision a save names: the small blocks whole, the Policy and the Source instances summarized"
	},
	{
		name: "settings/<block>",
		holds: "one settings block whole, as orchestrator_settings_save takes it: policy, eval, executor, pause or source:<id>"
	},
	{
		name: "prompts",
		holds: "the prompt revision each Session reads, the skills, and the saved versions"
	},
	{
		name: "prompts/<revision>",
		holds: "one prompt version by number, or current, the one the Session works under",
		executor: true
	},
	{
		name: "prompts/defaults",
		holds: "the built-in prompt configuration, and the built-in parts by the key an override names"
	},
	{
		name: "prompt-preview/<id>",
		holds: "a composed prompt that orchestrator_prompts_save previewed"
	},
	{
		name: "models",
		holds: "model providers, the DSH default and each role's model"
	},
	{
		name: "models/<provider>",
		holds: "one provider's models"
	},
	{
		name: "feishu/<trigger-id>/…",
		holds: "a Feishu original, as the dsh-superagent-feishu skill describes",
		executor: true
	},
	{
		name: "github/…",
		holds: "a GitHub original, as the dsh-superagent-github skill describes",
		executor: true
	}
];
const resourceGrammar = (executor) => RESOURCES.filter((resource) => !executor || resource.executor).map((resource) => `${resource.name}: ${resource.holds}`).join("; ");
/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }) => {
	if (ticketId || !("settings" in host)) throw new Error("This resource belongs to the main Session");
	return host;
};
const text = ({ resource, offset, limit }, body) => textPage(resource, body, offset, limit ?? 4e3);
function list({ offset, limit }, fetch) {
	const size = Math.min(limit ?? 20, 50);
	const items = fetch(offset, size + 1);
	return {
		items: items.slice(0, size),
		next_offset: items.length > size ? offset + size : null
	};
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host, ticket, trigger) => reached(ticket, trigger, (key) => host.store.threads.get(key)) || ticket.origin.triggerIds.includes(trigger.id) || trigger.threads.some((ref) => ticket.follows?.some((follow) => follow.thread === threadKey(ref)));
const trigger = (host, id, ticketId) => {
	const found = host.store.triggers.get(id);
	if (!found) throw new UserError("unknownTrigger");
	const ticket = ticketId ? host.store.tickets.get(ticketId) : void 0;
	if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError("notReached");
	return found;
};
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read, source, fetch) {
	const { host, resource, offset, sessionId } = read;
	const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`);
	if (body === void 0) throw new Error(`Read this ${source === "feishu" ? "Feishu" : "GitHub"} resource from offset 0 first`);
	if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body);
	return text(read, body);
}
const triggerLine = (trigger) => ({
	trigger_id: trigger.id,
	actor: trigger.actor.id,
	human: trigger.human,
	at: trigger.at,
	preview: preview$1(trigger.text),
	chars: trigger.text.length,
	read: `trigger/${trigger.id}`
});
async function transcript(host, ticketId) {
	return (await host.context.sessionController.inspect(workerSessionId(ticketId))).events;
}
const ROUTES = [
	["tickets", (read) => {
		const host = main(read), tickets = host.store.tickets.list();
		const card = (ticket) => ({
			...ticketCard(ticket),
			...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id))
		});
		return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card));
	}],
	["triggers", (read) => {
		const { store } = main(read);
		return list(read, (offset, count) => store.read.recentTriggers(offset, count).map((item) => triggerCard$1(item, store.triggers.disposition(item.id))));
	}],
	["threads", (read) => {
		const { store } = main(read);
		const threads = store.read.subscribedThreads().sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt));
		return list(read, (offset, count) => threads.slice(offset, offset + count).map((thread) => threadCard(thread, threadTitle(store, thread))));
	}],
	["thread/", (read) => {
		const { host, rest, ticketId } = read;
		const thread = host.store.threads.get(rest);
		const ticket = ticketId ? host.store.tickets.get(ticketId) : void 0;
		if (!thread || ticketId && !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some((follow) => follow.thread === rest))) throw new Error("Unknown or inaccessible thread");
		const { store } = host;
		const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread));
		const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine));
		if (ticketId) return {
			...card,
			...page
		};
		const tickets = ids.flatMap((id) => {
			const found = store.tickets.get(id);
			return found ? [ticketCard(found)] : [];
		});
		const decisions = store.decisions.byThread(thread.key).slice(-5).reverse().map(decisionCard);
		return {
			...card,
			tickets,
			decisions,
			...page
		};
	}],
	["decisions", (read) => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard))],
	["decision/", (read) => {
		const decision = main(read).store.decisions.get(read.rest);
		if (!decision) throw new Error("Unknown decision");
		return decisionDetails(decision);
	}],
	["settings", (read) => main(read).settings.view()],
	["settings/", (read) => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
	["prompts", (read) => {
		const host = main(read), current = host.prompts.current(), status = host.sessions.status();
		const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)), skills = host.prompts.skills(current.config).map(([name]) => name);
		const changes = host.prompts.defaultChanged(current.config);
		const changed = changes.filter((item) => !item.removed).map((item) => item.part);
		const removed = changes.filter((item) => item.removed).map((item) => item.part);
		return {
			revision: status.revision,
			read: `prompts/${current.revision}`,
			notification_pending: status.notificationPending,
			...changed.length ? { default_changed: changed } : {},
			...removed.length ? { removed_parts: removed } : {},
			sessions: status.sessions.map((session) => ({
				session_id: session.sessionId,
				revision: session.revision
			})),
			skills: {
				built_in: skills.filter((name) => !(name in current.config.skills)).map((name) => `dsh-superagent-${name}`),
				team: Object.keys(current.config.skills).map((name) => `dsh-superagent-${name}`)
			},
			items: history.revisions.map(({ previousRevision, savedAt, ...version }) => ({
				...version,
				previous_revision: previousRevision,
				saved_at: savedAt
			})),
			next_offset: history.next_offset
		};
	}],
	["prompts/", (read) => {
		const { host, resource, rest, sessionId, ticketId } = read;
		const prompts = host.prompts;
		const bound = host.promptVersion(sessionId);
		const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]));
		const version = rest === "current" ? bound : rest === "defaults" && !ticketId ? {
			revision: 0,
			config: defaultPrompts(),
			parts: parts()
		} : /^\d+$/.test(rest) ? Number(rest) === 0 && prompts.current().revision === 0 ? prompts.current() : prompts.version(Number(rest)) : void 0;
		if (!version || ticketId && !host.mayRead(sessionId, version.revision)) throw new Error("Unknown or inaccessible prompt version");
		return text({
			...read,
			resource: rest === "current" ? `prompts/${version.revision}` : resource
		}, JSON.stringify(version));
	}],
	["prompt-preview/", (read) => {
		const body = main(read).pages.get(`${read.sessionId}:${read.resource}`);
		if (body === void 0) throw new Error("Unknown preview for this Session");
		return text(read, body);
	}],
	["models", async (read) => {
		const host = main(read), catalog = await host.context.sessionController.modelCatalog(), settings = host.store.settings();
		const roles = {
			orchestrator: settings.eval.model,
			worker: settings.executor.model
		};
		return {
			default: catalog.default,
			roles,
			failures: catalog.failures,
			providers: catalog.groups.map((group) => ({
				id: group.id,
				name: group.name,
				count: group.models.length,
				read: `models/${group.id}`
			}))
		};
	}],
	["models/", async (read) => {
		const models = (await main(read).context.sessionController.modelCatalog()).groups.find((group) => group.id === read.rest)?.models;
		if (!models) throw new Error("Unknown model provider");
		return list(read, (offset, count) => models.slice(offset, offset + count));
	}],
	["feishu/", async (read) => {
		const source = trigger(read.host, read.rest.split("/")[0], read.ticketId);
		const ref = feishuRef(source);
		if (!ref) throw new Error("A Feishu source trigger is required");
		const commands = read.host.commands.withSignal(read.signal);
		return sourcePage(read, "feishu", () => feishuRead(commands, ref, read.resource, read.host.feishuPageSize()));
	}],
	["github/", (read) => sourcePage(read, "github", () => readGithub(read.host.commands.withSignal(read.signal), read.resource))],
	["trigger/", async (read) => {
		const { host, rest, ticketId, offset, signal } = read;
		if (!rest || rest.includes("/")) throw new Error("Unknown context resource");
		const found = trigger(host, rest, ticketId);
		const ref = feishuRef(found);
		const ticket = ticketId ? host.store.tickets.get(ticketId) : void 0;
		const shown = (item) => item && (!ticket || readable(host, ticket, item)) ? item : void 0;
		const disposition = host.store.triggers.disposition(found.id);
		const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard$1(found, disposition && ticket ? {
			...disposition,
			decisionId: void 0,
			fanout: disposition.fanout.filter((id) => id === ticket.id)
		} : disposition);
		const parent = found.source === "feishu" && typeof found.meta.parentId === "string" ? found.meta.parentId : void 0;
		const repliedTo = shown(parent ? host.store.triggers.get(feishuTriggerId(parent)) : void 0);
		const neighbours = host.store.read.neighbours(threadKey(found.threads[0]), found.at, found.id);
		const around = {
			before: shown(neighbours.before),
			after: shown(neighbours.after)
		};
		return {
			...card,
			...await host.sourceLink(found, signal),
			acknowledgement: host.store.replyStatus(key("ack", found.id)) ?? "not_requested",
			...ref ? { context: feishuReferences(ref) } : {},
			...offset === 0 ? {
				...repliedTo ? { replied_to: triggerLine(repliedTo) } : {},
				around: {
					...around.before ? { before: triggerLine(around.before) } : {},
					...around.after ? { after: triggerLine(around.after) } : {}
				}
			} : {},
			...text(read, found.text)
		};
	}],
	["ticket/", async (read) => {
		const { host, resource, rest, ticketId, signal } = read;
		const [id, section, part, ...more] = rest.split("/");
		if (!id || more.length) throw new Error("Unknown context resource");
		if (ticketId && ticketId !== id) throw new Error("Ticket does not belong to this worker");
		const ticket = host.store.tickets.get(id);
		if (!ticket) throw new UserError("unknownTicket");
		if (section === void 0) {
			const running = runningAssignment(ticket) && workerSessionId(ticket.id);
			const retry = "sessions" in host ? host.sessions.modelRetry(running) : {};
			const bound = new Set((ticket.follows ?? []).map((follow) => follow.thread));
			const subscribed = host.store.read.subscribedThreads().filter((thread) => thread.subscriptions.includes(id));
			const marked = (key, context) => ({
				thread: key,
				...context ? { context: true } : {},
				...bound.has(key) ? { bound: true } : {}
			});
			return {
				...ticketDetails(ticket, [...subscribed.map((thread) => marked(thread.key, !!thread.context?.includes(id))), ...[...bound].filter((key) => !subscribed.some((thread) => thread.key === key)).map((key) => marked(key, false))], batchOf(host, ticket), !!ticketId),
				...retry
			};
		}
		if (section === "assignments" || section === "inputs") {
			if (part !== void 0) throw new Error("Unknown context resource");
			const size = Math.min(read.limit ?? (section === "assignments" ? 3 : 10), 50);
			const { items, next_offset } = section === "assignments" ? newestPage(ticket.assignments, read.offset, size, (item) => assignmentLine(ticket, item), resource) : newestPage(ticket.inputs, read.offset, size, (input) => inputLine(ticket, input, !!ticketId), resource);
			return {
				items,
				next_offset: next_offset ?? null
			};
		}
		let body;
		if (section === "input" && part) {
			const input = ticket.inputs.find((item) => key(item.id) === part || item.id === part);
			const trigger = input?.kind === "trigger" ? host.store.triggers.get(input.triggerId) : void 0;
			const card = trigger && input?.kind === "trigger" ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note) : void 0;
			const message = input && inputMessage(input, card);
			if (message === void 0) throw new Error("Unknown ticket input");
			body = message;
		} else if (section === "message" && part && /^\d+$/.test(part)) {
			const event = (await transcript(host, id))[Number(part)];
			const entry = event && transcriptEntry(event);
			if (!entry) throw new Error("Unknown transcript entry");
			body = JSON.stringify(entry);
		} else if (section === "report" && part) {
			const report = ticket.assignments.find((item) => item.id === part)?.report;
			if (!report) throw new Error("Unknown assignment report");
			body = report.summary;
		} else if (part !== void 0) throw new Error("Unknown context resource");
		else if (section === "assignment") body = ticket.execution?.assignment ?? "";
		else if (section === "result") body = latestReport(ticket)?.summary ?? "";
		else if (section === "transcript") body = (await transcript(host, id)).flatMap((event, index) => {
			const entry = transcriptEntry(event);
			const said = entry?.message.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join(" ") ?? "";
			return entry ? [{
				type: entry.type,
				preview: preview$1(said).slice(0, 80),
				chars: JSON.stringify(entry).length,
				read: `ticket/${id}/message/${index}`
			}] : [];
		}).reverse().map((event) => JSON.stringify(event)).join("\n");
		else throw new Error("Unknown context resource");
		return text(read, body);
	}]
];
/**
* Read a paginated resource for the main Session or a ticket's worker Session.
* Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
*/
async function readResource(host, resource, offset, limit, ticketId, signal) {
	const name = resource.replace(/^event\//, "trigger/").replace(/^task\//, "ticket/").replace(/^observation\//, "decision/");
	const route = ROUTES.find(([route]) => route.endsWith("/") ? name.startsWith(route) : name === route);
	if (!route) throw new Error("Unknown context resource");
	const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId;
	const rest = route[0].endsWith("/") ? name.slice(route[0].length) : "";
	return route[1]({
		host,
		resource: name,
		rest,
		offset,
		sessionId,
		...limit ? { limit } : {},
		...ticketId ? { ticketId } : {},
		...signal ? { signal } : {}
	});
}
//#endregion
//#region src/app/tools/tool.ts
/** Shared tool primitives and schemas for the main and executor Sessions. */
const tool = (definition) => definition;
/** Human-facing acknowledgement text, constrained to `IM_WORDS` regardless of which channel it is posted to. */
const AcknowledgementSchema = z.string().trim().min(1).refine((text) => wordCount(text) <= 100, `An acknowledgement has at most 100 words (Chinese uses word segmentation); write one short sentence.`);
/**
* Builds the `orchestrator_read` tool, scoping allowed resource patterns to the main Session or to an
* Executor Session (which may read only its own ticket and messages that reached it).
*/
function readTool(description, executor, read) {
	return tool({
		name: "orchestrator_read",
		description,
		schema: z.object({
			resource: z.string().min(1).describe(`The resource, one of: ${resourceGrammar(executor)}.`),
			offset: z.number().int().min(0).default(0).describe("Copy next_offset from the previous page; it counts characters of a text and items of a list."),
			limit: z.number().int().min(1).max(8e3).optional().describe("Characters of a text, 4000 by default and 8000 at most, or items of a list, 20 by default and 50 at most.")
		}).strict(),
		execute: async (args, signal) => read(args.resource, args.offset, args.limit, signal)
	});
}
//#endregion
//#region src/app/assessment.ts
/** Schema for a short lowercase kebab-case English ticket worktree name (1–4 words, at most 32 characters). */
const WorktreeNameSchema = z.string().max(32).regex(/^[a-z]+(?:-[a-z0-9]+){0,3}$/, "Use 1–4 short English words in lowercase kebab-case, at most 32 characters").describe("Meaningful short English ticket name, e.g. fix-plan-color. Translate Chinese titles into English; no Chinese, pinyin or generic ticket names. 1–4 lowercase words in kebab-case, at most 32 characters.");
/** Schema for the main Session's proactive candidate assessment decision (`orchestrator_eval_decide`). */
const AssessmentSchema = z.object({
	decision: z.enum([
		"accept",
		"ignore",
		"unavailable"
	]),
	rule_assessments: z.array(RuleAssessmentSchema).refine((assessments) => new Set(assessments.map((assessment) => assessment.rule_id)).size === assessments.length, "Duplicate rule assessment IDs").describe("One per enabled rule."),
	direction: AdmissionDirectionSchema.describe("Required for every decision."),
	title: z.string().min(1).max(160),
	worktree_name: WorktreeNameSchema.optional(),
	scope: z.string().max(1500),
	intent_evidence: z.string().trim().min(1).max(700).nullish().describe("For acceptance: the quotes that establish the three facts."),
	acknowledgement: AcknowledgementSchema.nullish().describe("For acceptance: one sentence in the source language, posted as a reply to the trigger; omit only when a matched rule asks for silence."),
	reason: z.string().min(1).max(500)
}).strict().refine((value) => value.decision !== "accept" || !directionAllowed(value.direction) || !value.rule_assessments.some((rule) => rule.matched) || !!value.worktree_name, {
	message: "Accepted work requires a short English worktree_name",
	path: ["worktree_name"]
});
/** Character limits in the initial thread window: for the trigger itself, its two nearest neighbours, other window messages, and stub previews. */
const TRIGGER_CHARS$1 = 4e3;
const NEAR_CHARS = 1200;
const WINDOW_CHARS = 400;
const STUB_CHARS = 50;
const FINISHED = "This assessment has finished: it was decided, timed out or restarted";
const EXPLICIT = "This is an explicit request, which is routed instead of assessed: use orchestrator_route with its trigger_id and kind accept, attach, stop or ignore";
/** Message returned when assessing a Trigger whose Source provides no thread context. */
const NO_CONTEXT = "This Source gives no Thread context; assess the Trigger's own text and the batch.";
/** Schema for bounded context or repository read requests during an active evaluation (`orchestrator_eval_read`). */
const EvalReadSchema = z.object({
	trigger_id: z.string().min(1).describe("Original candidate ID returned by orchestrator_eval; every reference is scoped to this trigger."),
	resource: z.enum([
		"message",
		"root",
		"parent",
		"thread",
		"file",
		"directory",
		"image"
	]),
	path: z.string().optional().describe("Repository-relative path, only for file/directory."),
	message_id: z.string().optional().describe("Only for message: omit for the trigger, or the id of a window message or stub."),
	cursor: z.string().optional().describe("Only for thread: omit on the first page, then the next_cursor of the window or the cursor of next_read. Never a thread or message ID."),
	image_id: z.string().optional().describe("Only for image: an image id the window or a read lists."),
	offset: z.number().int().min(0).default(0).describe("Text pagination: copy next_offset; keep the other arguments unchanged. Images use 0.")
}).strict().superRefine((read, ctx) => {
	if ((read.resource === "file" || read.resource === "directory") !== (read.path !== void 0)) ctx.addIssue({
		code: "custom",
		message: "path is required only for file/directory. To read the source/root/parent, use resource=message/root/parent without a path."
	});
	if (read.message_id !== void 0 && read.resource !== "message") ctx.addIssue({
		code: "custom",
		message: "message_id is only for message; use returned image_id for images."
	});
	if (read.cursor !== void 0 && read.resource !== "thread") ctx.addIssue({
		code: "custom",
		message: "cursor is only for thread. First page: {resource:\"thread\"}."
	});
	if (read.resource === "image" !== (read.image_id !== void 0)) ctx.addIssue({
		code: "custom",
		message: "Images require image_id from a returned read reference. Read the thread or root first to discover their images."
	});
});
/**
* Implements the `Engine` `Assessor` port for proactive candidate evaluation in the main Session.
* Relays each evaluation's candidate card to the main Session through the durable `assessment` effect, serves bounded `TriggerContext` and repository reads while the evaluation runs, and converts the main Session's assessment into an `AssessmentOutcome` for `Engine.decide`.
* Depends on `SourceRegistry` (via `AssessorHost`) for source-specific thread context and on `Sessions` for deduplicated candidate delivery; the main Session's `orchestrator_eval*` tools call `context`, `read`, and `decide`.
*/
var MasterAssessor = class {
	host;
	/** Per-evaluation read caches and thread contexts, keyed by `evalId`. */
	evals = /* @__PURE__ */ new Map();
	controller = new AbortController();
	/** Registers the handler that relays each Eval's candidate card, which a link lookup may delay for seconds. */
	constructor(host) {
		this.host = host;
		host.effects.handle("assessment", async ({ triggerId }, evalId) => {
			const candidate = this.host.engine.candidate(triggerId);
			if (candidate?.evalId !== evalId) return;
			await this.host.deliver(`candidate:${evalId}`, JSON.stringify({
				kind: "candidate",
				...await this.host.candidateCard(candidate)
			}));
			this.host.engine.candidateDelivered(evalId);
		}, { limit: () => host.paused() ? 0 : 4 });
	}
	/** Enqueues an `assessment` effect to deliver `candidate`'s card to the main Session. */
	request(candidate) {
		this.host.effects.enqueue("assessment", candidate.evalId, { triggerId: candidate.triggers[0].id });
	}
	/** Whether `evalId` is still the active evaluation for `trigger`. */
	live(evalId, trigger) {
		return this.host.engine.candidate(trigger.id)?.evalId === evalId;
	}
	/** Drop an Eval's context and reads once it finishes; any running load for it discards its result. */
	release(evalId) {
		this.evals.delete(evalId);
	}
	/** Resolve the active evaluation for a trigger; historical triggers have none, and explicit requests are routed instead. */
	evalFor(triggerId) {
		const candidate = this.host.engine.candidate(triggerId);
		if (!candidate) throw new Error("No assessment is in progress for this trigger; it was already decided, timed out, or never reached assessment");
		if (candidate.strength === "explicit") throw new Error(EXPLICIT);
		return {
			candidate,
			trigger: candidate.triggers.find((item) => item.id === triggerId)
		};
	}
	/** Returns or initializes the read cache for `evalId`, seeded with the trigger's own message and image references; throws if `evalId` has finished. */
	reads(evalId, trigger) {
		let reads = this.evals.get(evalId);
		if (!reads) {
			if (!this.live(evalId, trigger)) throw new Error(FINISHED);
			const context = this.host.threadContext(trigger);
			const messages = /* @__PURE__ */ new Map([[context?.messageId ?? "", trigger.text]]);
			reads = { cache: {
				snapshots: /* @__PURE__ */ new Map(),
				images: /* @__PURE__ */ new Map(),
				messages,
				cursors: /* @__PURE__ */ new Set()
			} };
			this.evals.set(evalId, reads);
			this.imageReferences(context, trigger, trigger.text, context?.messageId ?? "", reads.cache);
		}
		return reads;
	}
	imageReferences(context, trigger, text, messageId, cache) {
		return (context?.images(text) ?? []).map((imageKey) => {
			const imageId = `${messageId}/${imageKey}`;
			cache.images.set(imageId, {
				id: messageId,
				text
			});
			return {
				message_id: messageId,
				image_key: imageKey,
				read: {
					trigger_id: trigger.id,
					resource: "image",
					image_id: imageId
				}
			};
		});
	}
	/** Loads and caches the initial bounded thread window once per evaluation (including after a host restart). */
	async seed(evalId, trigger, caller) {
		caller?.throwIfAborted();
		const reads = this.reads(evalId, trigger);
		if (reads.context || reads.error !== void 0) return;
		const thread = this.host.threadContext(trigger);
		if (!thread) {
			reads.error = NO_CONTEXT;
			return;
		}
		let loading = reads.loading;
		if (!loading) {
			const current = () => this.evals.get(evalId)?.loading === loading;
			loading = Promise.resolve().then(async () => {
				try {
					const timeout = AbortSignal.timeout(this.host.deployment.admissionContextTimeoutMs.get());
					const signal = AbortSignal.any([
						this.controller.signal,
						...caller ? [caller] : [],
						timeout
					]);
					const commands = this.host.commands.withSignal(signal);
					const context = await admissionContext(thread, commands, this.host.deployment.admissionContextMaxPages.get());
					if (!current()) return;
					reads.context = context;
					if (context.next) reads.cache.cursors.add(context.next);
					for (const message of context.messages) if (!message.deleted) {
						reads.cache.messages.set(message.id, message.text);
						this.imageReferences(thread, trigger, message.text, message.id, reads.cache);
					}
				} catch (error) {
					caller?.throwIfAborted();
					if (current()) reads.error = `Thread context unavailable: ${String(error).slice(0, 300)}. Use orchestrator_eval_read before deciding based on missing context.`;
				}
			}).finally(() => {
				if (current()) delete reads.loading;
			});
			reads.loading = loading;
		}
		await loading;
		caller?.throwIfAborted();
		if (!this.live(evalId, trigger)) throw new Error(FINISHED);
	}
	/**
	* Returns the `orchestrator_eval` payload: the trigger's text once (up to `TRIGGER_CHARS`), batch peers, related tickets
	* on the thread, the Policy version its Eval was built from, and the initial thread window (first five messages and five
	* on either side of the trigger, truncated to `WINDOW_CHARS` or `NEAR_CHARS` for its two nearest neighbours with total
	* length and image IDs, plus other loaded messages as `STUB_CHARS` previews; `orchestrator_eval_read` reads any message
	* in full by ID).
	* Assessment instructions live in the main Session's prompt (`prompts/admission.md`), not in this payload.
	*/
	async context(triggerId, signal) {
		const { candidate, trigger } = this.evalFor(triggerId);
		await this.seed(candidate.evalId, trigger, signal);
		const { context, error } = this.evals.get(candidate.evalId) ?? {};
		const source = this.host.threadContext(trigger);
		const images = (text) => source?.images(text) ?? [];
		const imageIds = (id, text) => {
			const keys = images(text);
			return keys.length ? { images: keys.map((key) => `${id}/${key}`) } : {};
		};
		const cut = (text, limit) => text.length <= limit ? { text } : {
			text: `${text.slice(0, limit)}…`,
			chars: text.length
		};
		const thread = context ? (() => {
			const shown = new Map(context.window.entries.map((entry) => [entry.message.id, entry]));
			const at = context.messages.findIndex((message) => message.id === source?.messageId);
			const messages = context.messages.map((message, index) => {
				const author = {
					id: message.id,
					from: message.from,
					...message.bot ? { bot: true } : {}
				};
				if (message.deleted) return {
					...author,
					deleted: true
				};
				if (!shown.has(message.id)) return {
					...author,
					preview: message.text.replace(/\s+/g, " ").slice(0, STUB_CHARS)
				};
				if (index === at) return {
					...author,
					at: message.at,
					trigger: true
				};
				const near = at >= 0 && Math.abs(index - at) <= 2;
				return {
					...author,
					at: message.at,
					...cut(message.text, near ? NEAR_CHARS : WINDOW_CHARS),
					...imageIds(message.id, message.text)
				};
			});
			return {
				complete: context.complete,
				loaded_messages: context.messages.length,
				source_found: context.window.source_found,
				...context.next ? { next_cursor: context.next } : {},
				messages
			};
		})() : {
			error: error ?? "Call orchestrator_eval to load initial context",
			complete: false
		};
		const settings = this.host.settings();
		const others = candidate.triggers.filter((item) => item.id !== trigger.id);
		return {
			trigger_id: trigger.id,
			strength: candidate.strength,
			mode: settings.eval.mode,
			source: {
				kind: trigger.source,
				actor: trigger.actor.id,
				thread: threadKey(trigger.threads[0]),
				...trigger.url ? { url: trigger.url } : {}
			},
			...cut(trigger.text, TRIGGER_CHARS$1),
			...imageIds(source?.messageId ?? "", trigger.text),
			...others.length ? { batch: others.map((item) => {
				const text = cut(item.text, WINDOW_CHARS);
				return {
					trigger_id: item.id,
					actor: item.actor.id,
					at: item.at,
					...text,
					..."chars" in text ? { read: `trigger/${item.id}` } : {}
				};
			}) } : {},
			...relatedTickets(candidate.tickets),
			policy_version: candidate.policyVersion,
			thread
		};
	}
	/**
	* Serves bounded paginated text or image attachments from the evaluation's thread context or repository for
	* `orchestrator_eval_read`; `agent` is the main Session, which receives images as attachments.
	*/
	async read(agent, read, signal) {
		const { candidate, trigger } = this.evalFor(read.trigger_id);
		await this.seed(candidate.evalId, trigger, signal);
		const { cache } = this.reads(candidate.evalId, trigger);
		const { snapshots, images, messages, cursors } = cache;
		const commands = this.host.commands.withSignal(AbortSignal.any([this.controller.signal, signal]));
		if (read.resource === "image") {
			if (read.offset !== 0) throw new Error("Images are not paginated; use offset 0");
			const image = images.get(read.image_id);
			if (!image) throw new Error("Unknown image reference. Read the source/root/thread for this trigger first and copy its image read arguments.");
			const source = this.host.threadContext(trigger);
			if (!source) throw new Error(NO_CONTEXT);
			const key = read.image_id.slice(read.image_id.indexOf("/") + 1);
			return source.image(agent, commands, image, key, this.host.deployment.stateDir, signal);
		}
		const cacheKey = JSON.stringify([
			read.resource,
			read.path,
			read.cursor,
			read.message_id
		]);
		if (read.offset > 0) {
			const cached = snapshots.get(cacheKey);
			if (cached === void 0) throw new Error("Read this resource at offset 0 first");
			return textPage(read.resource, cached, read.offset, 4e3);
		}
		let body;
		const source = this.host.threadContext(trigger);
		if (read.resource === "message") {
			const message = messages.get(read.message_id ?? source?.messageId ?? "");
			if (message === void 0) throw new Error("Unknown message reference. Use resource=root/parent or read the thread first; copy a returned message read call.");
			body = message;
		} else if (read.resource === "thread" || read.resource === "root" || read.resource === "parent") {
			if (!source) throw new Error(NO_CONTEXT);
			if (read.cursor !== void 0 && !cursors.has(read.cursor)) throw new Error("Unknown thread cursor. First call {resource:\"thread\"}; then copy the returned next_read exactly.");
			const result = await source.read(commands, read.resource, read.cursor);
			const references = result.messages.filter((message) => !message.deleted).flatMap((message) => {
				messages.set(message.id, message.text);
				return this.imageReferences(source, trigger, message.text, message.id, cache);
			});
			if (result.next) cursors.add(result.next);
			const next = result.next ? {
				trigger_id: trigger.id,
				resource: "thread",
				cursor: result.next
			} : null;
			body = JSON.stringify({
				images: references,
				next_read: next,
				...result.body
			});
		} else body = await readRepositoryPath(commands, read.path, read.resource === "directory" ? "directory" : "file");
		snapshots.set(cacheKey, body);
		return textPage(read.resource, body, read.offset, 4e3);
	}
	/** Converts the assessment into an outcome under current settings and passes it to `Engine.decide` for policy verification. */
	async decide(triggerId, result, signal) {
		const { candidate } = this.evalFor(triggerId);
		signal?.throwIfAborted();
		let outcome = assessmentOutcome(result, this.host.settings(), candidate.strength);
		if (outcome.kind === "accept" && outcome.acknowledgement) outcome = {
			...outcome,
			acknowledgement: checkedImText(outcome.acknowledgement)
		};
		const decision = this.host.engine.decide(triggerId, {
			...outcome,
			evalId: candidate.evalId
		});
		return {
			state: decision.kind,
			...decision.ticketId ? { ticket_id: decision.ticketId } : {},
			reason: reasonText(decision.reason)
		};
	}
	/** Aborts any in-flight thread context or repository read commands when the runtime stops. */
	stop() {
		this.controller.abort();
	}
};
//#endregion
//#region src/executor/background.ts
/** How long a stop waits for a killed job to end, collecting its end so the worker is not woken to hear of it. */
const KILL_WAIT_MS = 1e4;
/** How long a release of subagents may take; it can hold up a shutdown, so DSH's own callers bound it too. */
const DRAIN_LIMIT_MS = 1e4;
/** How long one wait that collects a job's end runs; one that ends with the job running is followed by the next. */
const COLLECT_WAIT_MS = 6e5;
const registry = (ctx) => ctx.get("jobs");
const subagentsOf = (ctx) => ctx.get("subagents");
const running = (status) => status === "running" || status === "stopping";
/** The jobs the Session owns that run, but those in `except`, such as the ones left to a person. */
const owned = (jobs, sessionId, except) => jobs.list(sessionId).filter((job) => job.owner === sessionId && running(job.status) && !except?.has(job.id));
/** `work`, or false once `signal` aborts or `ms` pass first. */
function until(work, signal, ms) {
	if (signal?.aborted) return Promise.resolve(false);
	let stop;
	const stopped = new Promise((resolve) => {
		stop = () => {
			resolve(false);
		};
	});
	signal?.addEventListener("abort", stop, { once: true });
	const timer = ms === void 0 ? void 0 : setTimeout(stop, ms);
	timer?.unref?.();
	return Promise.race([work, stopped]).finally(() => {
		signal?.removeEventListener("abort", stop);
		clearTimeout(timer);
	});
}
/** The workers whose turn a stop of their subagents cancelled, whose next idle ends that turn rather than one of their own. */
const cancelled = /* @__PURE__ */ new WeakSet();
/** The pending join of each worker's subagents, which DSH cannot cancel, so a later look joins the same one. */
const joins = /* @__PURE__ */ new WeakMap();
function childrenEnd(subagents, agent) {
	let join = joins.get(agent);
	if (!join) {
		join = subagents.waitForChildren(agent).finally(() => {
			joins.delete(agent);
		});
		joins.set(agent, join);
	}
	return join;
}
/** A job by its id and the first line of its label. */
const named = (job) => {
	const line = job.label?.split("\n")[0]?.trim();
	return line ? `${job.id} (${line})` : job.id;
};
/** The shell jobs the Session owns that still run, but those in `except`, with their names. */
const runningJobs = (ctx, sessionId, except) => {
	const jobs = registry(ctx);
	return jobs ? owned(jobs, sessionId, except).map((job) => ({
		id: job.id,
		name: named(job)
	})) : [];
};
/**
* Wait until no shell job the Session owns runs; false at once when none ran, or when `signal` aborts first. The wait is
* no waiter on any job, so each job's end still reaches the worker.
*/
function jobsEnd(ctx, sessionId, signal, except) {
	const jobs = registry(ctx);
	if (!jobs || !owned(jobs, sessionId, except).length) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const done = (value) => {
			if (settled) return;
			settled = true;
			unsubscribe();
			signal.removeEventListener("abort", aborted);
			resolve(value);
		};
		const aborted = () => {
			done(false);
		};
		const unsubscribe = jobs.events.subscribe({ owner: sessionId }, (event) => {
			if ((event.type === "settled" || event.type === "removed") && !owned(jobs, sessionId, except).length) done(true);
		});
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
	});
}
/**
* Wait until nothing runs for a worker that went idle: its shell jobs, but those in `except`, and its subagents. A job's or a
* subagent's end wakes the worker with its result, which ends this look: the turn it starts ends with an idle of its own,
* which looks afresh.
* @returns true once all of it ended with the worker idle; false when the worker runs again, or when `signal` aborts first,
* as when the host stops or the look's time is up.
*/
async function untilQuiet(ctx, agent, signal, except) {
	for (;;) {
		const subagents = subagentsOf(ctx);
		const children = subagents ? await until(childrenEnd(subagents, agent), signal) : false;
		const jobs = await jobsEnd(ctx, agent.id, signal, except);
		if (signal.aborted || agent.status !== "idle") return false;
		if (!children && !jobs) return true;
	}
}
/**
* Kill the shell jobs the Session owns, but those in `except`, collecting each end so the worker is not woken to hear of it.
* One failure stops none other.
*/
async function killJobs(ctx, sessionId, reason, except) {
	const jobs = registry(ctx);
	const live = jobs ? owned(jobs, sessionId, except) : [];
	const failures = [];
	const collected = live.map((job) => jobs.wait(job.id, KILL_WAIT_MS, sessionId).catch(() => void 0));
	for (const job of live) try {
		jobs.kill(job.id, sessionId, reason);
	} catch (error) {
		failures.push(error);
	}
	await Promise.all(collected);
	if (failures.length) throw new AggregateError(failures, `Killing the shell jobs of ${sessionId} failed`);
}
/**
* Collect the end of a shell job the Session owns, so it wakes no one, until `signal` aborts.
* @returns the job's name and status once it ended; undefined when `signal` aborted first.
*/
async function collectJob(ctx, sessionId, job, signal) {
	const jobs = registry(ctx);
	while (jobs && !signal.aborted) {
		const view = await jobs.wait(job.id, COLLECT_WAIT_MS, sessionId, signal).catch(() => void 0);
		if (!view) return void 0;
		if (!running(view.status)) return {
			name: job.name,
			status: view.status
		};
	}
}
/**
* Release the worker's live subagents, for a bounded time. DSH delivers each one's end to the worker before the release
* returns, which wakes it, so the worker's turn is cancelled after, keeping its inbox when `keepInbox`, and the stop ends
* with that turn. Its Session still admits subagents.
*/
async function stopSubagents(ctx, agent, keepInbox = false) {
	const subagents = subagentsOf(ctx);
	if (!subagents) return;
	const live = (await subagents.listChildren(agent.id)).map((child) => child.id).filter((id) => ctx.agents.get(id));
	if (!live.length) return;
	try {
		await until(subagents.drainChildren(agent, live), void 0, DRAIN_LIMIT_MS);
	} finally {
		if (agent.status !== "idle") cancelled.add(agent);
		agent.cancel({ kind: "user" }, { keepInbox });
		await until(agent.whenIdle(), void 0, DRAIN_LIMIT_MS);
	}
}
/**
* Stop what a worker runs in the background once its Assignment ends: kill its shell jobs and release its subagents (see
* `stopSubagents`). A Session not loaded has no subagent at work. One failure stops nothing else.
*/
async function stopBackground(ctx, sessionId, reason, keepInbox = false) {
	const failures = [];
	await killJobs(ctx, sessionId, reason).catch((error) => {
		failures.push(error);
	});
	const agent = ctx.agents.get(sessionId);
	if (agent) await stopSubagents(ctx, agent, keepInbox).catch((error) => {
		failures.push(error);
	});
	if (failures.length) throw new AggregateError(failures, `Stopping the background work of ${sessionId} failed`);
}
//#endregion
//#region src/executor/dsh.ts
const now$1 = () => (/* @__PURE__ */ new Date()).toISOString();
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
const workerSessionId = (ticketId) => `worker-${ticketId}`;
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
const ticketOfSession = (sessionId) => sessionId.startsWith("worker-") ? sessionId.slice(7) : void 0;
/** Maximum runtime for a workspace prepare command. */
const PREPARE_TIMEOUT_MS = 6e5;
/** Maximum transient retry attempts for a launch or worker turn, and the initial backoff before resuming a turn. */
const TRANSIENT_TRIES = 3;
const TRANSIENT_BACKOFF_MS = 15e3;
/** How long a worker's background work may run on after its turn ended before it is stopped and the worker reported waiting. */
const BACKGROUND_LIMIT_MS = 18e5;
/** How long a host stop waits for the workers' background work to stop. */
const SHUTDOWN_STOP_MS = 1e4;
/** How long a worker that goes on after a passing failure waits for a worker slot, or for processing to resume, between looks. */
const SLOT_WAIT_MS = 5e3;
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input) => input?.kind === "trigger" ? !!input.human && !input.context : input?.kind === "text";
/**
* Internal error thrown when a ticket's workspace prepare command fails during launch.
* DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
*/
var PrepareFailed = class extends Error {};
const PASSING = new RegExp([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"EPIPE",
	"UND_ERR",
	"socket hang up",
	"fetch failed",
	"network error",
	"overloaded",
	"rate limit",
	"\\b(?:408|429|50[0-4])\\b"
].join("|"), "i");
/**
* True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
* connection that was refused, reset, timed out, or could not resolve its host.
*/
function transient(error) {
	const status = error?.status;
	if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
	const text = error instanceof Error ? `${error.name} ${error.message} ${String(error.code ?? "")}` : String(error);
	return PASSING.test(text);
}
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
const ticketWorktreeName = (name, id) => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`;
/** Looks up a ticket's origin trigger in Store. */
const sourceTrigger = (host, ticket) => host.store.triggers.get(ticket.origin.triggerId);
/**
* Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
* rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
*/
function mandateInstructions(mandate) {
	return mandate.strength === "inferred" ? "This ticket has limited proactive authorization. Independently verify that it is a small change internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product decisions or clarification, stop and report dropped; do not expand scope." : "";
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
function ticketExecution(ticket, outcome, settings, stateDir) {
	const name = ticketWorktreeName(outcome.name ?? "", ticket.id);
	ticket.origin.triggerId;
	const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : "";
	const ruleIds = ticket.mandate.basis.rules;
	const rules = settings.policy.rules.filter((rule) => ruleIds?.includes(rule.id)).map((rule) => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join("");
	const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : "";
	const assignment = ticket.mandate.strength === "inferred" && ruleIds ? `Proactively accepted under ${ruleIds.join(", ")}. Scope: ${outcome.scope}.${precedence}${note}` : note.trim();
	return {
		name,
		directory: join(executionRoot(settings, stateDir), name),
		assignment
	};
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
const ASSIGNMENT_CHARS = 1500;
const TRIGGER_CHARS = 600;
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text, limit, read) => text.length <= limit ? { text } : {
	text: `${text.slice(0, limit)}…`,
	chars: text.length,
	read
};
/**
* Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
* optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
*/
function triggerMessage(trigger, link, note, repliesTo) {
	return {
		trigger_id: trigger.id,
		from: trigger.actor.id,
		thread: threadKey(trigger.threads[0]),
		at: trigger.at,
		...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`),
		...link,
		...note ? { routing_note: note } : {},
		...repliesTo ? { replies_to: {
			trigger_id: repliesTo.id,
			preview: repliesTo.text.replace(/\s+/g, " ").slice(0, 160)
		} } : {}
	};
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
const batchLine = (trigger) => ({
	trigger_id: trigger.id,
	from: trigger.actor.id,
	at: trigger.at,
	preview: trigger.text.replace(/\s+/g, " ").slice(0, 160),
	read: `trigger/${trigger.id}`
});
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
const batchOf = (host, ticket) => ticket.origin.triggerIds.filter((id) => id !== ticket.origin.triggerId).flatMap((id) => host.store.triggers.get(id) ?? []);
const RESUMED = "This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.";
const RETRIED$1 = "A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.";
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
function policyMessage(effect) {
	if (!effect) return "Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.";
	return [
		"Policy change:",
		...(effect.rules ?? []).map((rule) => rule.change === "disabled" ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.` : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
		...effect.proactive === false ? ["Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only what is in progress within the assignment, or report dropped, and take on nothing new."] : [],
		...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : "who asked for it"}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []
	].join("\n");
}
/** Resource path under which a worker session reads the full text of a ticket input. */
const inputResource = (ticketId, inputId) => `ticket/${ticketId}/input/${key(inputId)}`;
/**
* Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
* a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
* Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
*/
function inputMessage(input, trigger) {
	if (input.kind === "trigger") return JSON.stringify({
		...trigger ?? {
			trigger_id: input.triggerId,
			read: `trigger/${input.triggerId}`
		},
		...input.context ? { context: true } : {}
	});
	if (input.kind === "policy-changed") return policyMessage(input.effect);
	if (input.kind === "resumed") return RESUMED;
	if (input.kind === "note") return `Note from the orchestrator, for context only: ${input.text}`;
	return input.kind === "text" ? input.text : void 0;
}
/**
* Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
* worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
* DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
* and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
*/
var WorkerSlots = class {
	running;
	max;
	/** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
	starting = /* @__PURE__ */ new Map();
	/**
	* @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
	* @param max - Returns the configured maximum number of concurrent worker slots.
	*/
	constructor(running, max) {
		this.running = running;
		this.max = max;
	}
	/** Number of slots currently in use across running workers and starting reservations. */
	used() {
		return (/* @__PURE__ */ new Set([...this.running(), ...this.starting.keys()])).size;
	}
	/** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
	launches() {
		const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== "launch" ? [ticketId] : []);
		return this.max() - (/* @__PURE__ */ new Set([...this.running(), ...wakes])).size;
	}
	/**
	* Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
	* A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
	* Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
	* @throws Later when no slot is free.
	*/
	reserve(ticketId, by) {
		if (this.starting.has(ticketId)) return;
		if (this.used() >= this.max() + (by === "person" ? 1 : 0)) throw new Later("No worker slot is free");
		this.starting.set(ticketId, by);
	}
	/** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
	free(ticketId) {
		this.starting.delete(ticketId);
	}
};
/**
* Executes ticket assignments in persistent per-ticket DSH worker sessions and isolated workspace directories.
* Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for `agent/status`,
* `agent/inbox/claimed`, `session/event` and `agent/error` events on the Cordis context, and reports status transitions back to Engine.
* Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
*/
var DshExecutor = class {
	host;
	/** Workers act as the configured GitHub account through the `gh` shim, so Setup resolves one even without a repository. */
	needsAccount = true;
	workerEnvironment = "process";
	disposers = [];
	slots;
	/** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
	transient = /* @__PURE__ */ new Map();
	/** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
	resuming = /* @__PURE__ */ new Set();
	/**
	* The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
	* runs again or its Assignment ends.
	*/
	settling = /* @__PURE__ */ new Map();
	/** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
	stopping = /* @__PURE__ */ new Map();
	/** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
	left = /* @__PURE__ */ new Map();
	/** When a person's message typed into a worker's Session last started a turn, by ticket. */
	personal = /* @__PURE__ */ new Map();
	/** The timers of workers that go on after a passing failure, which dispose clears. */
	timers = /* @__PURE__ */ new Set();
	/** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
	constructor(host) {
		this.host = host;
		this.slots = new WorkerSlots(() => host.store.tickets.open().filter((ticket) => this.running(ticket)).map((ticket) => ticket.id), () => host.store.settings().executor.maxWorkers);
		host.effects.handle("launch", (payload) => this.launchQueued(payload), {
			limit: () => host.paused() ? 0 : this.slots.launches(),
			retry: [5e3, 3e5]
		});
		host.effects.handle("delivery", (payload) => this.deliverQueued(payload.ticketId), {
			limit: () => host.paused() ? 0 : 4,
			quiet: true
		});
	}
	/** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
	prepare(ticket, outcome) {
		return {
			...ticket,
			execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir)
		};
	}
	/**
	* Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
	* execution environment variables, then verifies the directory as the worker sees it.
	* A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
	* @throws PrepareFailed with the command's output when the prepare command fails.
	*/
	async prepareDirectory(ticket) {
		const directory = ticket.execution?.directory ?? "";
		await mkdir(dirname(directory), { recursive: true });
		const command = this.host.store.settings().executor.prepare.trim();
		const env = Object.fromEntries(this.host.environment(ticket).map((variable) => [variable.key, variable.value]));
		const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]);
		if (command) await runAsWorker(this.host.context.subprocess, [
			"sh",
			"-c",
			command
		], dirname(directory), signal, env).catch(async (error) => {
			await rmdir(directory).catch(() => {});
			throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		await mkdir(directory, { recursive: true });
		await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime);
	}
	/** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
	start(ticket, assignment) {
		this.host.effects.enqueue("launch", assignment.id, {
			ticketId: ticket.id,
			assignmentId: assignment.id
		});
	}
	/** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
	deliver(ticket, _assignment) {
		this.host.effects.enqueue("delivery", ticket.id, { ticketId: ticket.id });
	}
	/** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
	async launchQueued({ ticketId, assignmentId }) {
		const ticket = this.host.store.tickets.get(ticketId);
		const assignment = ticket && latestAssignment(ticket);
		if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== "pending") return;
		this.slots.reserve(ticketId, "launch");
		try {
			await this.launch(ticket, assignment);
			this.transient.delete(`launch:${assignmentId}`);
		} catch (error) {
			if (this.host.closing() || error instanceof Later) throw error;
			if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error;
			this.launchFailed(ticketId, assignmentId, error);
		} finally {
			this.slots.free(ticketId);
		}
	}
	/**
	* Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
	* stops immediately if the ticket ended or another assignment took over.
	*/
	async deliverQueued(ticketId) {
		await this.stopped(ticketId);
		const first = this.host.store.tickets.get(ticketId);
		const target = first && liveTicket(first) ? runningAssignment(first) : void 0;
		if (!first || !target || !first.undelivered.length) return;
		let woken = false;
		try {
			for (;;) {
				const ticket = this.host.store.tickets.get(ticketId);
				const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : void 0;
				const inputId = ticket?.undelivered[0];
				if (!ticket || !assignment || inputId === void 0) return;
				const sessionId = workerSessionId(ticketId);
				if (!woken && !this.running(ticket)) {
					const person = ticket.undelivered.some((id) => fromPerson(ticket.inputs.find((item) => item.id === id)));
					this.slots.reserve(ticketId, person ? "person" : "wake");
					woken = true;
				}
				const input = ticket.inputs.find((item) => item.id === inputId);
				try {
					if (!this.host.context.agents.get(sessionId)) await this.host.sessions.ensure(sessionId, ticket.execution?.directory ?? "", ticket.title, "worker");
					if (input) await this.deliverInput(ticket, assignment, input);
				} catch (error) {
					if (this.host.closing() || error instanceof Later) throw error;
					const current = this.host.store.tickets.get(ticketId);
					if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return;
					this.host.engine.deliveryFailed(ticketId, assignment.id, String(error));
					throw error;
				}
				this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId]);
			}
		} finally {
			if (woken) this.slots.free(ticketId);
		}
	}
	async deliverInput(ticket, assignment, input) {
		const live = () => {
			const current = this.host.store.tickets.get(ticket.id);
			if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error("The ticket ended or another Assignment took it over");
			if (this.stopping.has(ticket.id)) throw new Later("The worker's background work is stopping");
		};
		live();
		const message = inputMessage(input, input.kind === "trigger" ? await this.triggerCard(ticket, input.triggerId, input.note) : void 0);
		if (message === void 0) return;
		const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message;
		await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, "steer", live);
	}
	/** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
	async triggerCard(ticket, triggerId, note) {
		const trigger = this.host.store.triggers.get(triggerId);
		if (!trigger) return void 0;
		const parent = this.host.repliedTo(trigger);
		const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some((item) => item.kind === "trigger" && item.triggerId === parent.id));
		return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? void 0 : parent);
	}
	/**
	* After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
	* starts after it): ends the look at its background work, cancels its turn unless its last word was a `ready` or `dropped`
	* report with no Input delivered since, and stops its shell jobs and subagents, including jobs it left to a person.
	*/
	stop(ticket, assignment, reason) {
		this.transient.delete(assignment.id);
		this.transient.delete(`launch:${assignment.id}`);
		const report = assignment.report;
		const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at;
		const ownTurn = (report?.state === "ready" || report?.state === "dropped") && !busy;
		const sessionId = workerSessionId(ticket.id);
		this.host.store.afterCommit(() => {
			this.settling.get(ticket.id)?.abort();
			if (!ownTurn) this.host.context.agents.get(sessionId)?.cancel({ kind: "user" }, { keepInbox: false });
			this.stopWork(ticket.id, reason);
			this.left.get(ticket.id)?.collect.abort();
			this.left.delete(ticket.id);
			this.personal.delete(ticket.id);
		});
	}
	/** Stop what a ticket's worker runs in the background (see `stopBackground`). */
	stopWork(ticketId, reason, keepInbox = false) {
		this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox));
	}
	/** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
	track(ticketId, stop) {
		const entry = Promise.all([this.stopping.get(ticketId), stop.catch(() => {})]).then(() => {}).finally(() => {
			if (this.stopping.get(ticketId) === entry) this.stopping.delete(ticketId);
		});
		this.stopping.set(ticketId, entry);
		this.background(stop);
	}
	/** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
	async stopped(ticketId) {
		const stopping = this.stopping.get(ticketId);
		if (stopping) await until(stopping, this.host.lifetime);
	}
	/**
	* On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
	* of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
	*/
	async shutdown() {
		const agents = this.host.store.tickets.list().map((ticket) => this.host.context.agents.get(workerSessionId(ticket.id))).filter((agent) => agent !== void 0);
		const stop = async () => {
			await Promise.allSettled(agents.map((agent) => stopBackground(this.host.context, agent.id, "dsh-superagent stopped", true)));
			for (const { collect } of this.left.values()) collect.abort();
			const running = agents.filter((agent) => agent.status !== "idle");
			for (const agent of running) agent.cancel({ kind: "user" }, { keepInbox: true });
			await Promise.allSettled(running.map((agent) => agent.whenIdle()));
		};
		await until(stop(), void 0, SHUTDOWN_STOP_MS);
	}
	/** Number of open tickets whose worker holds a worker slot: its turn runs, or its shell jobs or subagents still run after its turn ended. */
	activeCount() {
		return this.host.store.tickets.open().filter((ticket) => this.running(ticket)).length;
	}
	/** Whether a ticket's worker holds a worker slot: its turn runs, or its shell jobs or subagents do after its turn ended. */
	running(ticket) {
		if (!runningAssignment(ticket)) return false;
		return this.host.context.agents.get(workerSessionId(ticket.id))?.status === "running" || this.settling.has(ticket.id);
	}
	/** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
	launchFailed(ticketId, assignmentId, error) {
		const ticket = this.host.store.tickets.get(ticketId);
		if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return;
		this.failed(ticketId, String(error));
	}
	/** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
	failed(ticketId, summary) {
		this.host.store.atomic(() => {
			const updated = this.host.engine.report(ticketId, {
				state: "failed",
				summary
			});
			this.relay(resultRelay(updated, "failed", summary));
		});
	}
	relay({ id, text }) {
		this.host.sessions.relay(id, text);
	}
	async launch(ticket, assignment) {
		const current = () => {
			if (this.host.closing()) throw new Error("dsh-superagent is stopping");
			if (this.host.paused()) throw new Later("Processing is paused");
			const stored = this.host.store.tickets.get(ticket.id);
			return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id;
		};
		const source = sourceTrigger(this.host, ticket);
		const workspace = ticket.execution?.directory ?? "";
		if (!current()) return;
		if (!await stat(workspace).then(() => true, () => false)) {
			await this.prepareDirectory(ticket);
			if (!current()) return;
		}
		if (!current()) return;
		const sessionId = workerSessionId(ticket.id);
		const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, "worker");
		if (!current()) return;
		await this.stopped(ticket.id);
		if (!current()) return;
		for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id));
		const first = `assignment:${ticket.id}`;
		const later = ticket.assignments.length > 1;
		const told = later && await this.host.sessions.holds(sessionId, first);
		if (!current()) return;
		const retried = ticket.assignments.at(-2)?.endedReason === "retried" ? { note: RETRIED$1 } : {};
		const assignmentText = ticket.execution?.assignment ?? "";
		const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`);
		const card = told || !source ? void 0 : await this.triggerCard(ticket, source.id);
		if (!current()) return;
		const batch = told ? [] : batchOf(this.host, ticket).map(batchLine);
		const text = told ? JSON.stringify({
			ticket_id: ticket.id,
			assignment: ticket.assignments.length,
			...retried
		}) : JSON.stringify({
			ticket_id: ticket.id,
			title: ticket.title,
			...brief ? { assignment: brief } : {},
			...read ? {
				assignment_chars: chars,
				assignment_read: read
			} : {},
			...card ? { trigger: card } : {},
			...batch.length ? { batch } : {},
			...retried
		});
		const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first;
		await this.host.sessions.prompt(sessionId, requestId, text, "queue", () => {
			if (!current()) throw new Error("Launch authorization changed before worker delivery");
		}, () => {
			this.host.engine.assignmentStarted(ticket.id, assignment.id);
		});
		this.host.engine.assignmentStarted(ticket.id, assignment.id);
	}
	/** Returns the stored ticket for `agent` when it is a worker session, or undefined otherwise. */
	ticketOf(agent) {
		const ticketId = ticketOfSession(agent.id);
		return ticketId === void 0 ? void 0 : this.host.store.tickets.get(ticketId);
	}
	/** Subscribes to host `agent/status`, `agent/inbox/claimed`, `session/event` and `agent/error` events for worker sessions. Call once at startup. */
	install() {
		const ctx = this.host.context;
		this.disposers.push(ctx.on("agent/status", ({ agent, status }) => {
			if (status === "running") {
				this.settling.get(ticketOfSession(agent.id) ?? "")?.abort();
				return;
			}
			if (status !== "idle" || cancelled.delete(agent) || this.host.closing()) return;
			const ticket = this.ticketOf(agent);
			const assignment = ticket && runningAssignment(ticket);
			if (ticket && assignment && liveTicket(ticket)) this.background(this.workerIdle(ticket, assignment, agent));
		}));
		this.disposers.push(ctx.on("agent/inbox/claimed", ({ agent, message }) => {
			const ticketId = ticketOfSession(agent.id);
			if (ticketId !== void 0 && message.source.kind === "user") this.personal.set(ticketId, now$1());
		}));
		this.disposers.push(ctx.on("session/event", (session, event) => {
			const ticketId = ticketOfSession(session.id);
			if (event.type !== "user/message" || ticketId === void 0 || event.data.source.kind !== "dsh-superagent" || this.host.closing()) return;
			const message = event.data;
			this.background(Promise.resolve().then(() => {
				const read = this.host.store.tickets.get(ticketId)?.inputs.filter((input) => input.kind === "trigger" && !input.readAt && this.host.sessions.promptedId(input.id) === message.id).map((input) => input.id) ?? [];
				if (read.length) this.host.engine.inputsRead(ticketId, read);
			}));
		}));
		this.disposers.push(ctx.on("agent/error", ({ agent, error }) => {
			const ticket = this.ticketOf(agent);
			const assignment = ticket && runningAssignment(ticket);
			if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return;
			if (this.retries(assignment.id, error)) {
				this.resumeAfter(ticket.id, assignment.id, error);
				return;
			}
			this.background(Promise.resolve().then(() => {
				this.failed(ticket.id, String(error));
			}));
		}));
	}
	/** Unsubscribes from host agent events and clears any pending transient-retry timers. */
	dispose() {
		for (const dispose of this.disposers.splice(0)) dispose();
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
	}
	/**
	* Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
	* running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
	* while failed launches (`waitsForPerson`) wait for a person's message or a retry.
	*/
	resume() {
		for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			const running = runningAssignment(ticket), latest = latestAssignment(ticket);
			if (running) {
				this.host.context.agents.get(workerSessionId(ticket.id))?.cancel({ kind: "user" }, { keepInbox: true });
				this.stopWork(ticket.id, "dsh-superagent restarted", true);
				this.host.engine.assignmentInterrupted(ticket.id, running.id);
			} else if (latest?.state === "pending" && !waitsForPerson(ticket)) this.start(ticket, latest);
		}
	}
	/** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
	background(work) {
		const { health } = this.host;
		return work.then(() => {
			if (health.get()?.state === "error") health.set({
				state: "ready",
				detail: "Worker events are handled",
				at: now$1()
			});
		}, (error) => {
			health.set({
				state: "error",
				detail: String(error),
				at: now$1()
			});
		});
	}
	/**
	* Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
	* increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
	*/
	retries(key, error) {
		const tries = this.transient.get(key) ?? 0;
		if (!transient(error) || tries >= TRANSIENT_TRIES) {
			this.transient.delete(key);
			return false;
		}
		this.transient.set(key, tries + 1);
		return true;
	}
	/** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
	resumeAfter(ticketId, assignmentId, error) {
		const tries = this.transient.get(assignmentId);
		const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`;
		this.resuming.add(assignmentId);
		const go = () => {
			if (this.host.closing()) return;
			const ticket = this.host.store.tickets.get(ticketId);
			if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) {
				this.resuming.delete(assignmentId);
				return;
			}
			if (this.host.paused()) {
				this.after(SLOT_WAIT_MS, go);
				return;
			}
			const sessionId = workerSessionId(ticketId);
			const waking = !this.running(ticket);
			try {
				if (waking) this.slots.reserve(ticketId, "wake");
			} catch (failure) {
				if (!(failure instanceof Later)) throw failure;
				this.after(SLOT_WAIT_MS, go);
				return;
			}
			const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, "queue");
			this.background(sent.finally(() => {
				if (waking) this.slots.free(ticketId);
				this.resuming.delete(assignmentId);
			}).catch((failure) => {
				this.failed(ticketId, String(failure));
			}));
		};
		this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go);
	}
	/** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
	after(ms, then) {
		const timer = setTimeout(() => {
			this.timers.delete(timer);
			then();
		}, ms);
		timer.unref?.();
		this.timers.add(timer);
	}
	/**
	* A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
	* person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
	* collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
	*/
	handOff(ticketId, agent) {
		this.track(ticketId, stopSubagents(this.host.context, agent, true));
		const left = this.left.get(ticketId) ?? {
			jobs: /* @__PURE__ */ new Set(),
			collect: new AbortController()
		};
		this.left.set(ticketId, left);
		for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
			left.jobs.add(job.id);
			this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async (ended) => {
				if (!ended) return;
				const note = `Your background job ${ended.name} ended: ${ended.status}.`;
				await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: "Background job ended" });
			}));
		}
	}
	async workerIdle(ticket, idle, agent) {
		await agent.whenIdle();
		if (this.resuming.has(idle.id) || agent.status !== "idle") return;
		this.transient.delete(idle.id);
		const live = () => {
			const stored = this.host.store.tickets.get(ticket.id);
			return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : void 0;
		};
		const handedOff = (stored) => {
			const assignment = runningAssignment(stored), report = assignment?.report;
			const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at;
			return (report?.state === "ready" || !!stored.attention) && !since || waitsForPerson(stored);
		};
		const before = live();
		if (!before || this.host.closing()) return;
		const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id);
		if (handedOff(before) && !(report && person && person > report.at)) {
			this.host.engine.turnEnded(ticket.id, idle.id);
			this.handOff(ticket.id, agent);
			return;
		}
		this.settling.get(ticket.id)?.abort();
		const look = new AbortController(), limit = new AbortController();
		this.settling.set(ticket.id, look);
		const timer = setTimeout(() => {
			limit.abort();
		}, BACKGROUND_LIMIT_MS);
		timer.unref?.();
		let quiet;
		const left = this.left.get(ticket.id)?.jobs;
		try {
			quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([
				this.host.lifetime,
				look.signal,
				limit.signal
			]), left);
		} finally {
			clearTimeout(timer);
			if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id);
		}
		const current = live();
		if (this.host.closing() || look.signal.aborted || !quiet && !limit.signal.aborted || !current || this.resuming.has(idle.id)) return;
		if (quiet) this.host.engine.turnEnded(ticket.id, idle.id);
		let stopped = "";
		if (!quiet) {
			const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 6e4;
			const jobs = runningJobs(this.host.context, sessionId, left).map((job) => job.name);
			if (jobs.length) {
				this.background(killJobs(this.host.context, sessionId, "The job ran past its limit", left));
				const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(", ")}.`;
				this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(",")}`, note, { inject: "Background jobs killed" }));
			}
			stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(", ")}.` : `Subagents still ran ${minutes} minutes after the worker's turn ended.`;
		}
		if (handedOff(current)) return;
		const last = agent.session.snapshotEvents().filter((event) => event.type === "assistant/message").at(-1);
		const said = [last?.type === "assistant/message" ? last.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim() : "", stopped].filter(Boolean).join("\n\n");
		this.host.store.atomic(() => {
			const before = latestReport(current)?.summary ?? "";
			const updated = this.host.engine.report(ticket.id, {
				state: "waiting",
				summary: said || before
			});
			if (said) this.relay(resultRelay(updated, "waiting", said));
			else if (!before.trim()) this.relay(resultRelay(updated, "waiting", "Worker ended without a status report. Use orchestrator_ticket_request_status to request one."));
		});
	}
};
//#endregion
//#region src/executor/dshd-cli.ts
/** dshd cannot reach systemd or its own parts (exit 7: systemd-unavailable, tool-missing, template-missing); a later try may succeed. */
var DshdUnavailable = class extends Error {};
/**
* A call that its timeout, a signal or the caller's abort ended before dshd answered. dshd may have acted all the same, as a
* `run --bg` that created and started its unit; asking again tells.
*/
var DshdUnanswered = class extends Error {};
/** The invocation a status names: the current run's, or the last run's once the unit ended (dshd then reports `invocationId: null`). */
const invocationOf = (status) => status.lastRun?.invocationId ?? status.invocationId ?? void 0;
const Child = z.object({
	exitCode: z.number().int().optional(),
	signal: z.number().int().optional()
});
const LastRun = z.object({
	invocationId: z.string(),
	ending: z.string().nullable(),
	endedAt: z.number().nullable().default(null),
	child: Child.nullable().default(null)
});
const Status = z.object({
	name: z.string(),
	id: z.string().nullable(),
	state: z.string(),
	invocationId: z.string().nullable(),
	labels: z.record(z.string(), z.string()).default({}),
	lastRun: LastRun.nullable().default(null)
});
const RunOutcome = Status.extend({ outcome: z.enum([
	"created",
	"started",
	"already-running"
]) });
const WaitOutcome = z.discriminatedUnion("outcome", [z.object({
	outcome: z.literal("ended"),
	exitCode: z.number().int().optional(),
	signal: z.number().int().nullable().optional(),
	reason: z.string().optional()
}), z.object({ outcome: z.literal("still-running") })]);
const Read = z.object({
	invocationId: z.string(),
	complete: z.boolean(),
	lines: z.array(z.string())
});
const Refusal = z.object({ error: z.object({
	kind: z.string(),
	message: z.string().default("")
}) });
/** Calls that may end before dshd answers, such as one cut by the host's stop; `wait` gets its own timeout on top. Fixed: a bound on a local call, not a tunable. */
const CALL_TIMEOUT_MS = 6e4;
/** `read --json` may carry a long stretch of a run's journal, so it may be large. Fixed: a memory bound on one reply, not a tunable. */
const READ_MAX_BYTES = 1 << 24;
const lastLine = (text) => text.trim().split("\n").at(-1) ?? "";
function json(text) {
	try {
		return JSON.parse(text);
	} catch {
		return;
	}
}
/**
* The dshd CLI driven through DSH's subprocess service, as `runAsWorker` drives worker commands: `run` starts from an empty
* environment (`env -i`) holding only the recipe's entries, which dshd captures for every later start of the unit.
*/
var DshdCli = class {
	subprocess;
	command;
	rmByInvocation;
	constructor(subprocess, command) {
		this.subprocess = subprocess;
		this.command = command;
	}
	async run(recipe, signal) {
		const env = Object.entries(recipe.env).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`);
		const labels = Object.entries(recipe.labels).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, value]) => ["--label", `${name}=${value}`]);
		const argv = [
			"env",
			"-i",
			...env,
			this.command,
			"run",
			"--bg",
			"--json",
			"--name",
			recipe.name,
			"--cwd",
			recipe.cwd,
			...labels,
			"--",
			recipe.profile,
			...recipe.args,
			"--json",
			recipe.task
		];
		const exit = await this.call(argv, recipe.cwd, signal);
		if (exit.exitCode !== 0) return this.refusal("run", recipe.name, exit);
		return this.parse("run", recipe.name, RunOutcome, exit);
	}
	async get(name, signal) {
		const exit = await this.call([
			this.command,
			"get",
			"--json",
			name
		], "/", signal);
		if (exit.exitCode !== 0) return this.missing("get", name, exit);
		return this.parse("get", name, Status, exit);
	}
	async wait(name, timeoutSeconds, signal) {
		const argv = [
			this.command,
			"wait",
			"--json",
			"--timeout",
			String(timeoutSeconds),
			name
		];
		const exit = await this.call(argv, "/", signal, timeoutSeconds * 1e3 + CALL_TIMEOUT_MS);
		if (exit.exitCode !== 0 && exit.exitCode !== 124) return this.missing("wait", name, exit);
		return this.parse("wait", name, WaitOutcome, exit);
	}
	async read(name, signal, lines) {
		const argv = [
			this.command,
			"read",
			"--json",
			...lines === void 0 ? [] : ["-n", String(lines)],
			name
		];
		const exit = await this.call(argv, "/", signal, CALL_TIMEOUT_MS, READ_MAX_BYTES);
		if (exit.exitCode !== 0) return this.missing("read", name, exit);
		return this.parse("read", name, Read, exit);
	}
	async stop(name, signal) {
		const exit = await this.call([
			this.command,
			"stop",
			"--json",
			name
		], "/", signal);
		if (exit.exitCode !== 0) return this.missing("stop", name, exit);
		return this.parse("stop", name, Status, exit);
	}
	async rm(name, signal, invocationId) {
		const argv = [
			this.command,
			"rm",
			"--json",
			...invocationId === void 0 ? [] : ["--invocation", invocationId],
			name
		];
		const exit = await this.call(argv, "/", signal);
		if (invocationId !== void 0 && (exit.exitCode === 5 || exit.exitCode === 4)) return this.refusal("rm", name, exit);
		if (exit.exitCode !== 0) return this.missing("rm", name, exit);
		return this.parse("rm", name, Status, exit);
	}
	/** Read once from `dshd rm --help`, whose usage line names `[--invocation ID]` where dshd takes it; a call cut off is read again. */
	async removesByInvocation(signal) {
		if (this.rmByInvocation !== void 0) return this.rmByInvocation;
		const exit = await this.call([
			this.command,
			"rm",
			"--help"
		], "/", signal);
		const takes = exit.exitCode === 0 && /\brm \[--invocation ID\]/.test(exit.stdout);
		if (exit.exitCode !== null) this.rmByInvocation = takes;
		return takes;
	}
	async call(argv, cwd, signal, timeoutMs = CALL_TIMEOUT_MS, maxBytes = 1 << 20) {
		const handle = this.subprocess.spawn({
			argv,
			cwd,
			graceMs: 2e3,
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes },
				stderr: { maxBytes: 65536 }
			}
		});
		const { exitCode } = await handle.done;
		const read = (reader) => reader?.readFrom(0).text ?? "";
		return {
			exitCode,
			stdout: read(handle.collected.stdout),
			stderr: read(handle.collected.stderr)
		};
	}
	/** dshd's refusal of `run`, DshdUnavailable for exit 7 or DshdUnanswered for no answer; anything that is not dshd's error object throws. */
	refusal(verb, name, exit) {
		const error = Refusal.safeParse(json(lastLine(exit.stderr)));
		if (exit.exitCode === 7) throw new DshdUnavailable(`dshd ${verb} ${name}: ${error.success ? `${error.data.error.kind}: ${error.data.error.message}` : exit.stderr.trim()}`);
		if (exit.exitCode === null) throw new DshdUnanswered(`dshd ${verb} ${name} was stopped before it finished: ${exit.stderr.trim().slice(0, 500)}`);
		if (!error.success) throw new Error(`dshd ${verb} ${name} exited with ${exit.exitCode}: ${exit.stderr.trim().slice(0, 500)}`);
		return {
			refused: error.data.error.kind,
			exit: exit.exitCode,
			message: error.data.error.message
		};
	}
	/** `not-found` (exit 3) for a verb that names an instance; any other refusal throws. */
	missing(verb, name, exit) {
		const refusal = this.refusal(verb, name, exit);
		if (refusal.refused === "not-found") return "not-found";
		throw new Error(`dshd ${verb} ${name} refused: ${refusal.refused}: ${refusal.message}`);
	}
	parse(verb, name, schema, exit) {
		const parsed = schema.safeParse(json(lastLine(exit.stdout)));
		if (!parsed.success) throw new Error(`dshd ${verb} ${name} printed what dsh-superagent does not read: ${exit.stdout.trim().slice(0, 500)}`);
		return parsed.data;
	}
};
//#endregion
//#region src/executor/dshd-summary.ts
/** The Report summary the dshd executor gives a unit that exited 0 without a final answer; it imports nothing, so a Source may read it. */
const NO_ANSWER = /^Unit [a-z0-9][a-z0-9_-]* exited 0\.$/;
/** The whole summary of an Assignment whose unit `name` exited 0 and printed no final answer: the Ticket completed with no result. */
const noAnswerSummary = (name) => `Unit ${name} exited 0.`;
/** Whether a `ready` Report's summary is the one `noAnswerSummary` writes, so its worker gave no answer. */
const isNoAnswer = (summary) => NO_ANSWER.test(summary);
//#endregion
//#region src/executor/dshd.ts
const now = () => (/* @__PURE__ */ new Date()).toISOString();
/** A time of day as the panel shows one, `HH:MM` in this process's time zone. */
const clock = (at) => new Date(at).toTimeString().slice(0, 5);
/** The binding of each Assignment the dshd executor launched, by Assignment ID. */
const BINDING = KV.dshd.binding;
/** Label keys dsh-superagent sets on every unit. */
const LABEL = {
	orchestrator: "superagent.orchestrator",
	ticket: "superagent.ticket",
	assignment: "superagent.assignment",
	pair: "superagent.pair"
};
const EXTRA_LABEL = /^superagent\.[a-z0-9._-]+$/;
/** dshd's instance name rule (`invalid-name`). */
const UNIT_NAME = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/;
const RUNNING = /* @__PURE__ */ new Set([
	"running",
	"starting",
	"stopping"
]);
const UNCERTAIN = /* @__PURE__ */ new Set([
	"masked",
	"orphaned",
	"inconsistent",
	"unknown"
]);
/** Tries of a launch while dshd is unavailable (exit 7) or does not answer before the Assignment is recorded failed; fixed, as the effect's own retry spaces them. */
const UNAVAILABLE_TRIES = 3;
/**
* Longest worker answer the summary of a unit that did not complete carries; a completed unit's answer is its whole result. Fixed:
* such a summary only points at the failure, and the unit's Session log keeps the whole answer.
*/
const FINAL_CHARS = 3800;
/**
* Lines of the longer `dshd read` for a run whose newest 200 lines name no Session: a whole run at 256 bytes a line fills
* `DshdCli`'s 16 MiB read cap. journalctl takes no more than a signed int. Fixed, as it follows from that cap.
*/
const READ_RUN_LINES = 65536;
/** Most `dshd-rm` effects one start queues for Tickets that ended before `dshd.removeEnded` reached them; later starts take the rest. */
const SWEEP_UNITS = 64;
/** Whether a PATH entry lies in the Nix store, where each path holds one build that a garbage collection may delete. */
const inStore = (entry) => entry === "/nix/store" || entry.startsWith("/nix/store/");
/**
* The values of `names` in this process's environment, for a unit that starts from an empty one; names that are not set are
* left out. `PATH` keeps only its entries outside the Nix store, and none at all when every entry is in it: a dshd unit replays
* its recipe on every later start, long after a garbage collection may have deleted a store path, while a profile link follows
* each switch. `dropped` hears of the entries left out.
*/
function inherited(names, env = process.env, dropped = () => {}) {
	return Object.fromEntries(names.flatMap((name) => {
		const value = env[name];
		if (value === void 0) return [];
		if (name !== "PATH") return [[name, value]];
		const entries = value.split(delimiter), kept = entries.filter((entry) => !inStore(entry));
		if (kept.length < entries.length) dropped(entries.filter(inStore));
		return kept.length ? [[name, kept.join(delimiter)]] : [];
	}));
}
const RETRIED = "A person retried this ticket. Continue the assignment from the current directory and what it holds now.";
const DSHD_WORKER_NOTE = "You are one headless task that dsh-superagent started. Work in the current directory. Nothing reaches you after this message and there is no report tool: when the work is done, end with a short final answer. Your session log is the record. A request in the inputs to report means: say it in your final answer. Earlier attempts of this ticket were given earlier_inputs. If the task asks for a JSON-only reply, your final answer is that JSON value and nothing else.";
/** The unit name of the `k`th Assignment (1-based) of a Ticket: `<prefix>-<execution name>-a<k>`, or `<prefix>-t<ticket id>-a<k>` when that name is unusable. */
function unitName(prefix, executionName, ticketId, k) {
	const named = `${prefix}-${executionName ?? ""}-a${k}`;
	return executionName && UNIT_NAME.test(named) ? named : `${prefix}-t${ticketId.slice(0, 12)}-a${k}`;
}
/** How a unit ended, from `dshd get`: `lastRun.ending` decides once the unit no longer runs. */
function verdictOf(status) {
	if (RUNNING.has(status.state)) return "running";
	if (UNCERTAIN.has(status.state)) return "unknown";
	if (status.state === "interrupted") return "cut";
	const run = status.lastRun;
	if (!run) return "never-ran";
	const child = run.child ?? {};
	if (run.ending === "exited") return child.exitCode === 0 ? "completed" : "task-failed";
	if (run.ending === "failed") return child.signal !== void 0 ? "killed" : child.exitCode !== void 0 ? "task-failed" : "never-ran";
	if (run.ending === "stopped") return "stopped";
	if (run.ending === "stopped-without-intent" || run.ending === "interrupted" || status.state === "previous-boot") return "cut";
	return "unknown";
}
/** A Trigger as a dshd worker reads it: who wrote what, and when, in full. */
const triggerCard = (trigger) => ({
	trigger_id: trigger.id,
	from: trigger.actor.id,
	at: trigger.at,
	text: trigger.text
});
/**
* The whole first and only message of a unit: the Ticket, its assignment and source Trigger in full, the Inputs earlier units'
* briefs carried, the waiting Inputs, and how the worker ends. Every Assignment gets it whole, since each unit is a fresh
* process with a fresh Session.
*/
function composeBrief(ticket, k, origin, batch, inputs, earlier = []) {
	const assignment = ticket.execution?.assignment;
	const previous = ticket.assignments.at(k - 2);
	return JSON.stringify({
		note: DSHD_WORKER_NOTE,
		ticket_id: ticket.id,
		title: ticket.title,
		attempt: k,
		...assignment ? { assignment } : {},
		...earlier.length ? { earlier_inputs: earlier } : {},
		...inputs.length ? { inputs } : {},
		...batch.length ? { batch: batch.map(triggerCard) } : {},
		...k > 1 && previous?.endedReason === "retried" ? { retried: RETRIED } : {},
		...origin ? { trigger: triggerCard(origin) } : {}
	});
}
/**
* The Report summary of a settled unit. A completed unit's is its final answer verbatim, the Ticket's result, which a workflow
* node parses as JSON; any other end says how the unit ended, then its answer and where its record is.
*/
function summaryOf(name, verdict, end, final, sessionId) {
	if (verdict === "completed") return final ?? noAnswerSummary(name);
	const answer = final === void 0 ? void 0 : `${final.slice(0, FINAL_CHARS)}${final.length > FINAL_CHARS ? "…" : ""}`;
	const pointer = `Unit ${name}; session ${sessionId ?? "unknown"}.`;
	return `${`Unit ${name} ended ${verdict}${end.exitCode !== void 0 ? ` (exit ${end.exitCode})` : ""}${end.signal ? ` (signal ${end.signal})` : ""}.`}${answer ? `\n\n${answer}` : ""}\n\n${pointer}`;
}
const withUsage = (events, usage) => usage ? {
	...events,
	usage
} : events;
const SessionEvent = (line) => {
	try {
		const value = JSON.parse(line);
		return value && typeof value === "object" ? value : void 0;
	} catch {
		return;
	}
};
/**
* The Session ID and the text of the last `final` event a headless `--json` run printed. The Session is the first `session`
* event's or, when the lines no longer reach back to it, the one dsh 0.2.2 repeats on `final`.
*/
function eventsOf(read) {
	let sessionId, finalSessionId, final;
	for (const event of read.lines.map(SessionEvent)) {
		if (event?.type === "session" && sessionId === void 0 && typeof event.sessionId === "string") sessionId = event.sessionId;
		if (event?.type === "final" && typeof event.text === "string") final = event.text;
		if (event?.type === "final" && typeof event.sessionId === "string") finalSessionId = event.sessionId;
	}
	sessionId ??= finalSessionId;
	return {
		...sessionId !== void 0 ? { sessionId } : {},
		...final !== void 0 ? { final } : {}
	};
}
const BUCKETS = [
	"totalTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens"
];
const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const usageValue = (value) => {
	if (!value || typeof value !== "object") return void 0;
	const usage = value;
	if (!count(usage.inputTokens) || !count(usage.outputTokens)) return void 0;
	const buckets = BUCKETS.flatMap((bucket) => count(usage[bucket]) ? [[bucket, usage[bucket]]] : []);
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		...Object.fromEntries(buckets)
	};
};
/**
* Adds two usages as DSH adds a step's attempts: an optional bucket stays only when both report it, so a sum never passes for
* a total it is not.
*/
function addUsage(a, b) {
	const buckets = BUCKETS.flatMap((bucket) => a[bucket] !== void 0 && b[bucket] !== void 0 ? [[bucket, a[bucket] + b[bucket]]] : []);
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		...Object.fromEntries(buckets)
	};
}
/**
* The tokens a headless `--json` run used: the sum of the usage on each step's `step_end` status, which dsh prints from what
* the step's `assistant/message` recorded in its Session. It is known only for lines that reach back to the run's start in
* which every step printed its usage, as dsh leaves usage out of a step whose total it cannot know.
*/
function usageOf(read) {
	if (!read.complete) return void 0;
	let total;
	for (const event of read.lines.map(SessionEvent)) {
		if (event?.type !== "status" || event.phase !== "step_end") continue;
		const usage = usageValue(event.usage);
		if (!usage) return void 0;
		total = total ? addUsage(total, usage) : usage;
	}
	return total;
}
/**
* Whether `assignmentId` is the latest Assignment of the live Ticket and the only one running, so its unit's end may settle it.
* After jason261014 `isCurrentRunningAssignment`, kept here so src/core stays untouched.
*/
const current = (ticket, assignmentId) => {
	const latest = latestAssignment(ticket);
	return liveTicket(ticket) && latest?.id === assignmentId && latest.state === "running" && ticket.assignments.filter((assignment) => assignment.state === "running").length === 1;
};
/** A launch that cannot succeed as configured, such as an unknown pair or a missing directory; it is recorded failed and not retried. */
var LaunchRefused = class extends Error {};
/**
* Executes each Assignment as one dshd headless unit (`dshd@<name>.service`) in the Ticket's directory, under the profile of its
* provider-harness pair. Launches go through the `launch` effect and `WorkerSlots`; a `dshd-watch` effect follows each unit until
* it ends, and its end settles the Assignment: exit 0 reports ready, any other end failed, and a unit a reboot cut restarts as
* upstream restarts interrupted work. A unit outlives this process, so a restart adopts the units that still run. With
* `dshd.removeEnded`, a `dshd-rm` effect removes the units of a Ticket that ended once their bindings record their Sessions.
*/
var DshdExecutor = class {
	host;
	/** A unit starts from its own environment, so it needs no account unless the deployment names a repository. */
	needsAccount = false;
	workerEnvironment = "own";
	/** A unit reads only its brief, see `deliver`. */
	takesInput = false;
	slots;
	dshd;
	hostname;
	/** Launch attempts made so far while dshd was unavailable or did not answer, by Assignment ID. */
	unavailable = /* @__PURE__ */ new Map();
	/** Launches under way, by Assignment ID, with their pair, which per-pair limits and stops consult. */
	launching = /* @__PURE__ */ new Map();
	/** Units whose Assignment the domain ended and whose stop has not recorded their end, by Assignment ID, with their pair: each holds its slot. */
	stopping = /* @__PURE__ */ new Map();
	/** When this executor last resumed: work from before then waits `dshd.resumeDelaySeconds` from it (see `holdResumed`). */
	startedAt = Date.now();
	/** Launches of work from before the start that wait for `dshd.resumeDelaySeconds`, by Assignment ID. */
	held = /* @__PURE__ */ new Set();
	/** Looks in a row that found a unit in a state dshd cannot tell an end from, by Assignment ID (see `watch`). */
	uncertain = /* @__PURE__ */ new Map();
	/** Whether `passEnv` has lost PATH entries under the Nix store, which is logged once. */
	warnedStore = false;
	constructor(host) {
		this.host = host;
		this.dshd = host.dshd ?? new DshdCli(host.context.subprocess, host.machine.dshd.command);
		this.hostname = host.hostname ?? hostname;
		this.slots = new WorkerSlots(() => [...this.runningTickets().map(({ ticket }) => ticket.id), ...this.stopping.keys()], () => host.store.settings().executor.maxWorkers);
		host.effects.handle("launch", (payload) => this.launchQueued(payload), {
			limit: () => host.paused() ? 0 : this.slots.launches(),
			retry: [5e3, 3e5]
		});
		host.effects.handle("delivery", async () => {}, { quiet: true });
		host.effects.handle("dshd-watch", (payload) => this.watch(payload), {
			limit: () => LIMITS.maxWorkers.max,
			retry: [2e3, 6e4]
		});
		host.effects.handle("dshd-stop", (payload) => this.stopQueued(payload), {
			limit: () => 4,
			retry: [2e3, 6e4]
		});
		host.effects.handle("dshd-rm", (payload) => this.removeQueued(payload), {
			limit: () => 4,
			retry: [2e3, 6e4]
		});
	}
	/** The Ticket's execution attributes, with the directory its unit runs in (see `cwdOf`). */
	prepare(ticket, outcome) {
		const execution = ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir);
		return {
			...ticket,
			execution: {
				...execution,
				directory: this.cwdOf(ticket) ?? execution.directory
			}
		};
	}
	start(ticket, assignment) {
		this.host.effects.enqueue("launch", assignment.id, {
			ticketId: ticket.id,
			assignmentId: assignment.id
		});
	}
	/** A headless unit reads only its brief: Inputs that arrive while it runs wait, and its end hands them back to Eval. */
	deliver(_ticket, _assignment) {}
	/** Queues the stop of the Assignment's unit, which the domain already ended. */
	stop(ticket, assignment, reason) {
		this.unavailable.delete(assignment.id);
		this.stopLater(ticket.id, assignment.id, reason);
	}
	/** Queues the stop of a unit; one that may still run holds its slot until the stop records its end. */
	stopLater(ticketId, assignmentId, reason) {
		const binding = this.host.store.get(BINDING(assignmentId));
		if (binding && binding.state !== "ended") this.host.store.afterCommit(() => {
			this.stopping.set(assignmentId, binding.pair);
		});
		this.host.effects.enqueue("dshd-stop", assignmentId, {
			ticketId,
			assignmentId,
			reason
		});
	}
	/** Nothing to listen to: the workers run outside this process. */
	install() {}
	/**
	* Reconciles open Tickets oldest first after a start. A running Assignment whose unit may still run is adopted and watched
	* again; one that ran in this process before a switch from the dsh executor is interrupted, as upstream does; pending ones
	* launch once `dshd.resumeDelaySeconds` have passed (see `holdResumed`). Under `dshd.removeEnded`, it then sweeps the ended
	* units of Tickets that ended before (see `sweepEnded`).
	*/
	resume() {
		this.startedAt = Date.now();
		for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			const running = runningAssignment(ticket), latest = latestAssignment(ticket);
			if (running) {
				const binding = this.host.store.get(BINDING(running.id));
				if (!binding) this.host.engine.assignmentInterrupted(ticket.id, running.id);
				else if (binding.state !== "ended") this.watchLater(ticket.id, running.id);
			} else if (latest?.state === "pending" && !waitsForPerson(ticket)) this.start(ticket, latest);
		}
		for (const name of this.host.store.keys(BINDING)) {
			const assignmentId = name.slice(BINDING.prefix.length);
			if (!this.host.effects.pending("dshd-stop", assignmentId)) continue;
			const binding = this.host.store.get(name);
			if (binding && binding.state !== "ended") this.stopping.set(assignmentId, binding.pair);
		}
		this.sweepEnded();
	}
	/** Units keep running when this process stops; the dshd calls under way end with the host's lifetime. */
	async shutdown() {}
	dispose() {}
	/** Number of open Tickets whose unit runs. */
	activeCount() {
		return this.runningTickets().length;
	}
	/** Open Tickets whose running Assignment's unit runs, with that binding; a unit that ended frees its slot whatever was reported. */
	runningTickets() {
		return this.host.store.tickets.open().flatMap((ticket) => {
			const running = runningAssignment(ticket);
			const binding = running && this.host.store.get(BINDING(running.id));
			return binding?.state === "running" ? [{
				ticket,
				binding
			}] : [];
		});
	}
	/**
	* The directory a Ticket's unit runs in: its origin Trigger's `meta.cwd` when that is an absolute path, else the configured
	* `cwd`; undefined leaves upstream's directory under the Execution directory.
	*/
	cwdOf(ticket) {
		const cwd = sourceTrigger(this.host, ticket)?.meta.cwd;
		if (typeof cwd === "string" && isAbsolute(cwd)) return cwd;
		return this.host.machine.dshd.cwd || void 0;
	}
	/** The pair a Ticket runs on: its origin Trigger's `meta.pair`, else the default pair; an empty `meta.pair` names none. */
	pairOf(ticket) {
		const { pairs, defaultPair } = this.host.machine.dshd;
		const named = sourceTrigger(this.host, ticket)?.meta.pair;
		const name = typeof named === "string" && named !== "" ? named : defaultPair;
		const pair = Object.hasOwn(pairs, name) ? pairs[name] : void 0;
		if (!pair) throw new LaunchRefused(`unknown pair ${name}`);
		return {
			name,
			pair
		};
	}
	async launchQueued({ ticketId, assignmentId }) {
		this.release(assignmentId);
		const ticket = this.host.store.tickets.get(ticketId);
		const assignment = ticket && latestAssignment(ticket);
		if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== "pending") {
			if (this.host.store.get(BINDING(assignmentId))?.state === "launching") this.stopUnanswered(ticketId, assignmentId);
			return;
		}
		if (this.host.closing()) throw new Error("dsh-superagent is stopping");
		if (this.host.paused()) throw new Later("Processing is paused");
		const stored = this.host.store.get(BINDING(assignmentId));
		try {
			this.holdResumed(ticket, assignment, stored);
		} catch (error) {
			if (error instanceof LaunchRefused) {
				this.launchFailed(ticketId, assignmentId, error);
				return;
			}
			throw error;
		}
		let pair;
		try {
			pair = stored ? {
				name: stored.pair,
				pair: this.host.machine.dshd.pairs[stored.pair]
			} : this.pairOf(ticket);
		} catch (error) {
			this.launchFailed(ticketId, assignmentId, error);
			return;
		}
		const max = pair.pair?.maxWorkers;
		const ofPair = this.runningTickets().filter(({ binding }) => binding.pair === pair.name).length + [...this.launching.values(), ...this.stopping.values()].filter((name) => name === pair.name).length;
		if (max !== void 0 && ofPair >= max) throw new Later(`No slot for pair ${pair.name}`);
		this.slots.reserve(ticketId, "launch");
		this.launching.set(assignmentId, pair.name);
		try {
			await this.launch(ticket, assignment, stored);
			this.unavailable.delete(assignmentId);
		} catch (error) {
			if (this.host.closing() || error instanceof Later) throw error;
			const unanswered = error instanceof DshdUnanswered;
			if (error instanceof DshdUnavailable || unanswered) {
				const tries = (this.unavailable.get(assignmentId) ?? 0) + 1;
				this.unavailable.set(assignmentId, tries);
				if (tries < UNAVAILABLE_TRIES && this.stillPending(ticketId, assignmentId)) throw error;
			}
			this.unavailable.delete(assignmentId);
			this.launchFailed(ticketId, assignmentId, error);
			if (unanswered) this.stopUnanswered(ticketId, assignmentId);
		} finally {
			this.launching.delete(assignmentId);
			this.slots.free(ticketId);
		}
	}
	/**
	* Queues the stop of a unit a launch that dshd did not answer may have started; it looks for the unit under the frozen name
	* and labels, and holds its slot until the stop records its end, as any stop does.
	*/
	stopUnanswered(ticketId, assignmentId) {
		this.stopLater(ticketId, assignmentId, "dshd did not answer its launch");
	}
	/**
	* The Assignment from before this start that a launch of `assignment` resumes: itself when it was created before the start,
	* or the one a restart replaced with it (upstream's `hostRestarted`, as for a unit a reboot cut) when that one was. Work
	* created since the start has none.
	*/
	resumedFrom(ticket, assignment) {
		const before = (item) => !!item && Date.parse(item.createdAt) < this.startedAt;
		if (before(assignment)) return assignment;
		const previous = ticket.assignments[ticket.assignments.findIndex((item) => item.id === assignment.id) - 1];
		return previous?.endedReason === "hostRestarted" && before(previous) ? previous : void 0;
	}
	/**
	* Holds the launch of work from before this start (see `resumedFrom`) until `dshd.resumeDelaySeconds` after the start, so a
	* person can look at it, and stop it, before any unit runs: a start with nobody watching, such as a supervisor's, launches
	* nothing at once. It refuses work older than `dshd.resumeMaxAgeHours`, unless its launch was under way before the start
	* (`stored`), whose frozen recipe dshd may already run. Work created since the start launches at once.
	*/
	holdResumed(ticket, assignment, stored) {
		const resumed = this.resumedFrom(ticket, assignment);
		if (!resumed) return;
		const { resumeDelaySeconds, resumeMaxAgeHours } = this.host.machine.dshd;
		const age = Date.now() - Date.parse(resumed.createdAt);
		if (!stored && resumeMaxAgeHours && age > resumeMaxAgeHours * 36e5) throw new LaunchRefused(`Not launched after the restart: this work waited ${Math.floor(age / 36e5)} h, longer than dshd.resumeMaxAgeHours (${resumeMaxAgeHours} h). Retry the ticket to launch it.`);
		const until = this.startedAt + resumeDelaySeconds * 1e3;
		if (Date.now() >= until) return;
		this.held.add(assignment.id);
		const count = this.held.size;
		this.host.health.set({
			state: "ready",
			at: now(),
			detail: `${count} Assignment${count === 1 ? "" : "s"} from before the start launch${count === 1 ? "es" : ""} at ${clock(until)}`
		});
		throw new Later(`Work from before the start launches at ${new Date(until).toISOString()}`);
	}
	/** Lets go of a held launch, and says so on the worker health entry once none is held. */
	release(assignmentId) {
		if (this.held.delete(assignmentId) && !this.held.size) this.host.health.set({
			state: "ready",
			detail: "No Assignment from before the start waits to launch",
			at: now()
		});
	}
	/** Whether the Assignment is still the live Ticket's pending one, which a launch may start. */
	stillPending(ticketId, assignmentId) {
		const ticket = this.host.store.tickets.get(ticketId);
		const assignment = ticket && latestAssignment(ticket);
		return !!ticket && liveTicket(ticket) && assignment?.id === assignmentId && assignment.state === "pending";
	}
	async launch(ticket, assignment, stored) {
		let binding = stored;
		if (binding?.state === "launching" && assignment.report?.state === "failed" && assignment.report.at >= binding.launchedAt && await this.dshd.get(binding.name, this.host.lifetime) === "not-found") binding = void 0;
		if (!binding) {
			const cwd = ticket.execution?.directory ?? "";
			if (!this.cwdOf(ticket) && cwd) await mkdir(cwd, { recursive: true });
			await this.directory(cwd);
			binding = await this.bindingOf(ticket, assignment);
		} else await this.directory(binding.recipe.cwd);
		const { recipe } = binding;
		const result = await this.dshd.run(recipe, this.host.lifetime);
		let status;
		if (!("refused" in result)) status = result;
		else if (result.refused === "task-already-ran") status = await this.dshd.get(recipe.name, this.host.lifetime);
		else throw new LaunchRefused(`dshd refused ${recipe.name}: ${result.refused}: ${result.message}`);
		if (status === "not-found") throw new LaunchRefused(`dshd refused ${recipe.name}: task-already-ran, then no longer knew it`);
		this.bind(ticket.id, assignment.id, binding, status);
	}
	async directory(cwd) {
		if (!await stat(cwd).then((info) => info.isDirectory(), () => false)) throw new LaunchRefused(`cwd ${cwd} does not exist`);
	}
	/**
	* Builds the recipe of an Assignment's first launch attempt and stores it as its binding before dshd runs anything, so every
	* later attempt reuses it byte for byte. A brief of more than `briefArgvMaxChars` bytes of UTF-8 goes to a file under
	* `stateDir/briefs`, which no unit can have read yet, as none runs without the binding: Linux takes one argument of at most
	* 131072 bytes (`MAX_ARG_STRLEN`), and a character outside ASCII takes two to four. The file stays after the binding ends:
	* the unit's Session names only its path, so it is the record of that task (docs/006 says `briefs/` grows until an operator
	* clears it).
	*/
	async bindingOf(ticket, assignment) {
		const { machine: { dshd, stateDir }, store } = this.host;
		const { name: pair, pair: config } = this.pairOf(ticket);
		const k = ticket.assignments.findIndex((item) => item.id === assignment.id) + 1;
		const name = unitName(dshd.prefix, ticket.execution?.name, ticket.id, k);
		const cwd = ticket.execution?.directory ?? "";
		const inputIds = [...ticket.undelivered];
		const messages = (ids) => ids.flatMap((id) => {
			const input = ticket.inputs.find((item) => item.id === id);
			const message = input && inputMessage(input, this.inputCard(input));
			return message === void 0 ? [] : [message];
		});
		const earlier = ticket.assignments.slice(0, k - 1).flatMap((previous) => previous.deliveredAt ? store.get(BINDING(previous.id))?.inputIds ?? [] : []);
		const restarts = new Set(ticket.assignments.map((item) => key("input", ticket.id, "restart", item.id)));
		const carried = [...new Set(earlier)].filter((id) => !inputIds.includes(id) && !restarts.has(id));
		const brief = composeBrief(ticket, k, sourceTrigger(this.host, ticket), batchOf(this.host, ticket), messages(inputIds), messages(carried));
		let task = brief;
		if (Buffer.byteLength(brief) > dshd.briefArgvMaxChars) {
			const file = join(stateDir, "briefs", `${assignment.id}.json`);
			await mkdir(join(stateDir, "briefs"), {
				recursive: true,
				mode: 448
			});
			await writeFile(file, brief, { mode: 384 });
			task = `Read and follow the task in ${file}.`;
		}
		const extra = sourceTrigger(this.host, ticket)?.meta.labels;
		const labels = {};
		for (const [label, value] of Object.entries(extra && typeof extra === "object" ? extra : {})) if (EXTRA_LABEL.test(label) && typeof value === "string" && value.length <= 256 && !value.includes("\n")) labels[label] = value;
		Object.assign(labels, {
			[LABEL.orchestrator]: this.host.masterId,
			[LABEL.ticket]: ticket.id,
			[LABEL.assignment]: assignment.id,
			[LABEL.pair]: pair
		});
		const env = {
			...inherited(dshd.passEnv, this.host.environment?.(), (entries) => {
				this.storePathsLeft(entries);
			}),
			...dshd.env,
			...config.env
		};
		const binding = {
			executor: "dshd",
			host: this.hostname(),
			name,
			pair,
			state: "launching",
			launchedAt: now(),
			recipe: {
				name,
				cwd,
				labels,
				profile: config.profile,
				args: [...dshd.args],
				task,
				env
			},
			inputIds
		};
		store.atomic(() => {
			store.set(BINDING(assignment.id), binding);
		});
		return binding;
	}
	/** Logs once that `passEnv` left PATH entries under the Nix store out of a unit's recipe (see `inherited`). */
	storePathsLeft(entries) {
		if (this.warnedStore) return;
		this.warnedStore = true;
		this.host.context.logger.warn("dsh-superagent leaves PATH entries under /nix/store out of every unit's environment, as a unit replays its recipe on later starts and a garbage collection may delete them; give this process a PATH of profile links: %s", entries.join(":"));
	}
	/** A Trigger Input as the brief carries it, in full. */
	inputCard(input) {
		const trigger = input.kind === "trigger" ? this.host.store.triggers.get(input.triggerId) : void 0;
		return trigger && triggerCard(trigger);
	}
	/**
	* Records that the unit runs and, while the Assignment is still the Ticket's pending one, starts it with the Inputs its brief
	* carries and queues the watch, in one transaction; a unit whose Assignment ended meanwhile is stopped.
	*/
	bind(ticketId, assignmentId, binding, status) {
		const { store, engine } = this.host;
		const invocationId = invocationOf(status);
		const bound = {
			...binding,
			state: "running",
			...status.id ? { instanceId: status.id } : {},
			...invocationId ? { invocationId } : {}
		};
		store.atomic(() => {
			store.set(BINDING(assignmentId), bound);
			if (!this.stillPending(ticketId, assignmentId)) {
				this.stopLater(ticketId, assignmentId, "The Assignment ended while its unit started");
				return;
			}
			engine.assignmentStarted(ticketId, assignmentId);
			if (binding.inputIds.length) {
				engine.inputsDelivered(ticketId, assignmentId, binding.inputIds);
				engine.inputsRead(ticketId, binding.inputIds);
			}
			this.watchLater(ticketId, assignmentId);
		});
	}
	watchLater(ticketId, assignmentId) {
		this.host.effects.enqueue("dshd-watch", assignmentId, {
			ticketId,
			assignmentId
		});
	}
	/** Follows a bound unit with `dshd wait` until it ends, then settles its Assignment from `dshd get` and its events. */
	async watch({ ticketId, assignmentId }) {
		let binding = this.host.store.get(BINDING(assignmentId));
		if (!binding || binding.state !== "running") {
			this.uncertain.delete(assignmentId);
			return;
		}
		const { name } = binding;
		this.sameHost(binding);
		const signal = this.host.lifetime;
		let status = await this.dshd.get(name, signal);
		if (status === "not-found") return this.settle(ticketId, assignmentId, "lost");
		if (status.labels[LABEL.orchestrator] !== this.host.masterId) return this.settle(ticketId, assignmentId, "superseded");
		if (!binding.invocationId && invocationOf(status)) {
			const invocationId = invocationOf(status);
			const fresh = this.host.store.atomic(() => {
				const latest = this.host.store.get(BINDING(assignmentId));
				if (!latest || latest.state === "ended") return void 0;
				const next = {
					...latest,
					invocationId
				};
				this.host.store.set(BINDING(assignmentId), next);
				return next;
			});
			if (!fresh) return;
			binding = fresh;
		}
		if (invocationOf(status) !== binding.invocationId) return this.settle(ticketId, assignmentId, "superseded");
		if (RUNNING.has(status.state)) {
			this.uncertain.delete(assignmentId);
			const waited = await this.dshd.wait(name, this.host.machine.dshd.watchSeconds, signal);
			if (waited !== "not-found" && waited.outcome === "still-running") throw new Later(`Unit ${name} still runs`);
			status = await this.dshd.get(name, signal);
			if (status === "not-found") return this.settle(ticketId, assignmentId, "lost");
			if (invocationOf(status) !== binding.invocationId) return this.settle(ticketId, assignmentId, "superseded");
		}
		const verdict = verdictOf(status);
		if (verdict === "running") throw new Later(`Unit ${name} still runs`);
		if (verdict === "unknown") return this.uncertainEnd(ticketId, assignmentId, name, status.state);
		this.uncertain.delete(assignmentId);
		const events = await this.printed(name, binding.invocationId, signal);
		const child = status.lastRun?.child ?? {};
		this.settle(ticketId, assignmentId, verdict, {
			...child,
			ending: status.lastRun?.ending ?? null
		}, events);
	}
	/**
	* A look that found the unit in a state dshd cannot tell an end from. The Assignment keeps its slot while dshd may yet tell,
	* for `dshd.uncertainWatchLimit` looks in a row (0: always), then settles as lost, as a stop of such a unit does; an orphaned
	* unit, a unit dshd holds no record of, settles at once. Lost is a failed report: the Ticket waits for a person.
	*/
	uncertainEnd(ticketId, assignmentId, name, state) {
		const looks = (this.uncertain.get(assignmentId) ?? 0) + 1;
		const limit = this.host.machine.dshd.uncertainWatchLimit;
		if (state !== "orphaned" && (limit === 0 || looks < limit)) {
			this.uncertain.set(assignmentId, looks);
			throw new Error(`Unit ${name} is ${state}: dsh-superagent keeps its Assignment until dshd can tell how it ended (look ${looks}${limit ? ` of ${limit}` : ""})`);
		}
		this.uncertain.delete(assignmentId);
		this.host.context.logger.warn("dsh-superagent settles the Assignment of unit %s as lost: dshd reports it %s", name, state);
		this.settle(ticketId, assignmentId, "lost");
	}
	/**
	* What the bound run printed, from `dshd read`: its answer from the newest lines, and its Session from them or, when they do
	* not reach back to the run's start and name none, from a longer read. Its usage comes from whichever of those reads reaches
	* back to the run's start (see `usageOf`); no read is made for the usage alone, so a run whose newest lines name its Session
	* but do not reach back leaves it unknown. A longer read dshd does not answer readably, such as one past the read cap, leaves
	* the Session unknown; the end settles either way.
	*/
	async printed(name, invocationId, signal) {
		const read = await this.dshd.read(name, signal);
		if (read === "not-found" || read.invocationId !== invocationId) return {};
		const events = eventsOf(read);
		if (read.complete) return withUsage(events, usageOf(read));
		if (events.sessionId !== void 0) return events;
		try {
			const longer = await this.dshd.read(name, signal, READ_RUN_LINES);
			if (longer === "not-found" || longer.invocationId !== invocationId) return events;
			const sessionId = eventsOf(longer).sessionId;
			return withUsage(sessionId === void 0 ? events : {
				...events,
				sessionId
			}, usageOf(longer));
		} catch (error) {
			if (signal.aborted) throw error;
			return events;
		}
	}
	/**
	* Records how the unit ended on its binding and, while its Assignment is the one running the live Ticket, tells the Engine in
	* the same transaction: a report, or for a cut unit upstream's restart, and relays the report to the main Session. A binding
	* that ended meanwhile, by a stop or an earlier run of this watch, is settled already and stays as it is.
	*/
	settle(ticketId, assignmentId, verdict, end = {}, events = {}) {
		const { store, engine } = this.host;
		store.atomic(() => {
			const binding = store.get(BINDING(assignmentId));
			if (!binding || binding.state === "ended") return;
			store.set(BINDING(assignmentId), {
				...binding,
				state: "ended",
				ended: {
					at: now(),
					verdict,
					...end
				},
				...events.sessionId ? { sessionId: events.sessionId } : {},
				...events.usage ? { usage: events.usage } : {}
			});
			const ticket = store.tickets.get(ticketId);
			if (!ticket || !current(ticket, assignmentId)) return;
			if (verdict === "cut") {
				engine.assignmentInterrupted(ticketId, assignmentId);
				return;
			}
			const sessionId = events.sessionId ?? binding.sessionId;
			const report = {
				state: verdict === "completed" ? "ready" : "failed",
				summary: summaryOf(binding.name, verdict, end, events.final, sessionId)
			};
			const relay = reportRelay(engine.report(ticketId, report), report);
			if (relay) this.host.sessions.relay(relay.id, JSON.stringify({
				...JSON.parse(relay.text),
				unit: binding.name,
				session: sessionId ?? null
			}));
		});
	}
	/**
	* The `dshd-stop` effect: stops the unit of an Assignment the domain ended (see `stopUnit`), then sweeps the briefs of the
	* Tickets that have ended: a Ticket's end stops every Assignment it has not ended, so each Ticket that wrote a brief passes
	* here once it ends. Once the Ticket has ended, it also queues the removal of its units (see `removeLater`).
	*/
	async stopQueued(payload) {
		await this.stopUnit(payload);
		await this.sweepBriefs();
		this.removeLater(payload.ticketId);
	}
	/**
	* Stops the unit of an Assignment the domain ended, only while its current run is the one this binding started; the domain
	* already ended the Assignment, so nothing is reported.
	*/
	async stopUnit({ assignmentId }) {
		const binding = this.host.store.get(BINDING(assignmentId));
		if (!binding || binding.state === "ended" || binding.state === "launching" && this.launching.has(assignmentId)) {
			this.stopping.delete(assignmentId);
			return;
		}
		this.sameHost(binding);
		const signal = this.host.lifetime;
		const status = await this.dshd.get(binding.name, signal);
		const ours = status !== "not-found" && status.labels[LABEL.orchestrator] === this.host.masterId && (binding.invocationId ? invocationOf(status) === binding.invocationId : status.labels[LABEL.assignment] === assignmentId);
		let verdict;
		if (status === "not-found") verdict = "lost";
		else if (!ours) verdict = "superseded";
		else if (RUNNING.has(status.state)) {
			await this.dshd.stop(binding.name, signal);
			verdict = "stopped";
		} else verdict = verdictOf(status) === "unknown" ? "lost" : verdictOf(status);
		this.host.store.atomic(() => {
			const latest = this.host.store.get(BINDING(assignmentId)) ?? binding;
			if (latest.state !== "ended") this.host.store.set(BINDING(assignmentId), {
				...latest,
				state: "ended",
				ended: {
					at: now(),
					verdict
				}
			});
		});
		this.stopping.delete(assignmentId);
	}
	/**
	* Under `dshd.removeEnded`, queues a `dshd-rm` for each ended unit of a Ticket that has ended. Every Ticket end stops its
	* Assignments that had not ended, through `dshd-stop`, so this runs once a Ticket's last unit is recorded ended.
	*/
	removeLater(ticketId) {
		if (!this.host.machine.dshd.removeEnded) return;
		const ticket = this.host.store.tickets.get(ticketId);
		if (!ticket || liveTicket(ticket)) return;
		for (const { id } of ticket.assignments) {
			const binding = this.host.store.get(BINDING(id));
			if (binding?.state === "ended" && !binding.removedAt) this.host.effects.enqueue("dshd-rm", id, {
				ticketId,
				assignmentId: id
			});
		}
	}
	/**
	* Under `dshd.removeEnded`, queues at a start a `dshd-rm` for each ended unit this host launched whose Ticket ended with no
	* removal recorded: Tickets that ended while the key was off, or while dshd stayed unavailable past a removal's retries. It
	* queues at most `SWEEP_UNITS`, the units that ended first; `removeQueued` checks each one again before it removes it.
	*/
	sweepEnded() {
		const { store, machine, effects } = this.host;
		if (!machine.dshd.removeEnded) return;
		const swept = store.keys(BINDING).flatMap((key) => {
			const binding = store.get(key), assignmentId = key.slice(BINDING.prefix.length), ticketId = binding?.recipe.labels[LABEL.ticket];
			if (binding?.state !== "ended" || binding.removedAt || binding.host !== this.hostname() || !ticketId) return [];
			const ticket = store.tickets.get(ticketId);
			return ticket && !liveTicket(ticket) ? [{
				ticketId,
				assignmentId,
				at: binding.ended?.at ?? binding.launchedAt
			}] : [];
		});
		for (const { ticketId, assignmentId } of swept.sort((a, b) => a.at.localeCompare(b.at)).slice(0, SWEEP_UNITS)) effects.enqueue("dshd-rm", assignmentId, {
			ticketId,
			assignmentId
		});
	}
	/**
	* Removes an ended unit's dshd record with `dshd rm` once its Ticket has ended and its binding records how it ended and its
	* Session, reading the Session from the unit's journal first when the binding has none. Only a unit that holds the bound run,
	* carries this orchestrator's labels and does not run is removed; one that names no Session is kept. Where dshd takes
	* `rm --invocation`, the removal names the bound run, and dshd's refusal keeps the unit and is recorded as `kept`. DSH keeps the Session.
	*/
	async removeQueued({ ticketId, assignmentId }) {
		const { store, machine } = this.host;
		const ticket = store.tickets.get(ticketId);
		const binding = store.get(BINDING(assignmentId));
		if (!machine.dshd.removeEnded || !ticket || liveTicket(ticket) || binding?.state !== "ended" || binding.removedAt) return;
		this.sameHost(binding);
		const signal = this.host.lifetime;
		const status = await this.dshd.get(binding.name, signal);
		if (status !== "not-found") {
			const ours = status.labels[LABEL.orchestrator] === this.host.masterId && status.labels[LABEL.assignment] === assignmentId && (!binding.invocationId || invocationOf(status) === binding.invocationId);
			const verdict = verdictOf(status);
			if (!ours || verdict === "running" || verdict === "unknown") return;
			const sessionId = binding.sessionId ?? (await this.printed(binding.name, binding.invocationId, signal)).sessionId;
			if (sessionId === void 0) return;
			if (!binding.sessionId) store.atomic(() => {
				store.set(BINDING(assignmentId), {
					...store.get(BINDING(assignmentId)) ?? binding,
					sessionId
				});
			});
			const invocation = binding.invocationId && await this.dshd.removesByInvocation(signal) ? binding.invocationId : void 0;
			const removed = await this.dshd.rm(binding.name, signal, invocation);
			if (removed !== "not-found" && "refused" in removed) {
				const kept = {
					at: now(),
					reason: `${removed.refused}: ${removed.message}`
				};
				store.atomic(() => {
					store.set(BINDING(assignmentId), {
						...store.get(BINDING(assignmentId)) ?? binding,
						kept
					});
				});
				return;
			}
		}
		store.atomic(() => {
			store.set(BINDING(assignmentId), {
				...store.get(BINDING(assignmentId)) ?? binding,
				removedAt: now()
			});
		});
	}
	/** A binding is observed only on the host that launched its unit: dshd units are local to one user manager. */
	sameHost(binding) {
		if (binding.host !== this.hostname()) throw new Error(`The unit ${binding.name} runs on ${binding.host}, and this process runs on ${this.hostname()}: only ${binding.host} can observe it`);
	}
	/**
	* Removes the briefs under `stateDir/briefs` that belong to no Assignment of an open Ticket. A Ticket that has ended launches
	* no unit again, and each Assignment has a brief of its own, so nothing reads them; an open Ticket's briefs stay whatever its
	* units did, as do files not named `<Assignment ID>.json`. A brief that cannot be removed is logged and left for the next sweep.
	*/
	async sweepBriefs() {
		const directory = join(this.host.machine.stateDir, "briefs");
		const left = (error) => {
			this.host.context.logger.warn("dsh-superagent could not sweep %s: %s", directory, String(error));
		};
		let files;
		try {
			files = await readdir(directory);
		} catch (error) {
			if (error.code !== "ENOENT") left(error);
			return;
		}
		const open = new Set(this.host.store.tickets.open().flatMap((ticket) => ticket.assignments.map((assignment) => assignment.id)));
		for (const file of files) {
			if (!file.endsWith(".json") || open.has(file.slice(0, -5))) continue;
			await rm(join(directory, file), { force: true }).catch(left);
		}
	}
	/** Records a failed launch on its Ticket and relays it to the main Session; the Ticket waits for a person's message or a retry. */
	launchFailed(ticketId, assignmentId, error) {
		const { store, engine } = this.host;
		const ticket = store.tickets.get(ticketId);
		if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return;
		const summary = error instanceof Error ? error.message : String(error);
		store.atomic(() => {
			const report = {
				state: "failed",
				summary
			};
			const relay = reportRelay(engine.report(ticketId, report), report);
			if (relay) this.host.sessions.relay(relay.id, relay.text);
		});
	}
};
//#endregion
export { markdown as $, followupNotice as A, channelLink as B, builtInBase as C, said as Ct, Versions as D, UserError as Dt, savePrompts as E, USER_ERRORS as Et, threadFollowedNotice as F, page as G, decisionView as H, candidateCard as I, threadTitle as J, snapshot as K, repliedTo as L, reportRelay as M, settingsNotice as N, changedPaths as O, subscriptionNotice as P, attribute as Q, sourceLink as R, TEAM_SECTIONS as S, reasonText as St, defaultPrompts as T, ticketStage as Tt, newestFirst as U, dayAgo as V, ownersOf as W, ticketSummary as X, ticketLine as Y, triggerView as Z, PromptConfigSchema as _, anyoneAllowed as _t, mandateInstructions as a, ticketCard as at, SKILL_NAME as b, settingsPolicy as bt, workerSessionId as c, declaredVariables as ct, MasterAssessor as d, ticketEnvironment as dt, preview as et, WorktreeNameSchema as f, AdmissionTableSchema as ft, readResource as g, SettingsSchema as gt, tool as h, PolicyConfigSchema as ht, DshExecutor as i, bundledSkills as it, promptsNotice as j, eventNotice as k, AssessmentSchema as l, environmentOf as lt, readTool as m, ExecutorConfigSchema as mt, addUsage as n, sourceSkills as nt, sourceTrigger as o, Effects as ot, AcknowledgementSchema as p, EvalConfigSchema as pt, threadSummary as q, isNoAnswer as r, teamDefaults as rt, ticketOfSession as s, Later as st, DshdExecutor as t, autoMergeThreshold as tt, EvalReadSchema as u, executionRoot as ut, PromptConflict as v, policyEffects as vt, builtInParts as w, canRetry as wt, SKILL_PREFIX as x, REASONS as xt, Prompts as y, policyVersion as yt, awaitingEval as z };
