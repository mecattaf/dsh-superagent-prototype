import { c as key, d as latestAssignment, n as sourceContext, t as health, v as threadKey } from "./host-DQwGgeSU.js";
import { n as family, t as KV } from "./kv-BJJnYYrV.js";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import s from "@deepseek-ai/schemastery";
import { cpus } from "node:os";
import { Ajv } from "ajv";
import { Schema } from "effect";
import vm from "node:vm";
const KEYED_OPTS = [
	"schema",
	"model",
	"effort",
	"isolation",
	"agentType",
	"disallowedTools",
	"bashCommandClamp"
];
function canon(v) {
	if (typeof v === "function") return void 0;
	if (Array.isArray(v)) {
		const out = [];
		const n = Number.isSafeInteger(v.length) ? v.length : 0;
		for (let i = 0; i < n; i++) out[i] = canon(v[i]);
		return out;
	}
	if (v && typeof v === "object") {
		const out = {};
		for (const k of Object.keys(v).sort()) {
			if (k === "__proto__") continue;
			out[k] = canon(v[k]);
		}
		return out;
	}
	return v;
}
/** The option subset that enters the key, serialized canonically. */
function canonicalOpts(opts) {
	if (!opts) return "{}";
	const picked = {};
	for (const k of KEYED_OPTS) {
		const v = opts[k];
		if (v === void 0 || typeof v === "function") continue;
		picked[k] = v;
	}
	return JSON.stringify(canon(picked));
}
function chainKey(prevKey, prompt, opts) {
	return `v2:${createHash("sha256").update(prevKey).update("\0").update(prompt).update("\0").update(canonicalOpts(opts)).digest("hex")}`;
}
const KEY_PATTERN = /^v\d+:[0-9a-f]{64}$/;
/**
* A call's CONTENT identity (D04/D18 of the 2026-09-23 naive evals): a hash of
* the prompt and the keyed opts, plus the occurrence index among identical
* (prompt, opts) calls in this run's invocation order. Unlike the chained key it
* does not depend on which calls came before or on the order they finished, so
* a resume keyed on it keeps every finished call. The chained key stays the
* journal's `key` (harness compatibility); this rides beside it as `cid`.
*/
function contentHash(prompt, opts) {
	const h = createHash("sha256").update(prompt).update("\0").update(canonicalOpts(opts));
	const route = routeOpts(opts);
	if (route !== "{}") h.update("\0route\0").update(route);
	return h.digest("hex");
}
const ROUTE_OPTS = [
	"runtime",
	"seat",
	"runsOn",
	"session"
];
/** The routing subset of opts (not part of the harness chain key), serialized canonically. */
function routeOpts(opts) {
	if (!opts) return "{}";
	const picked = {};
	for (const k of ROUTE_OPTS) if (opts[k] !== void 0 && typeof opts[k] !== "function") picked[k] = opts[k];
	return JSON.stringify(canon(picked));
}
const contentId = (hash, occurrence) => `c1:${hash}#${occurrence}`;
const CID_PATTERN = /^c1:[0-9a-f]{64}#[1-9][0-9]*$/;
//#endregion
//#region src/workflow/jsonschema.ts
/**
* JSON Schema handling for structured agent() output.
*
* Two layers:
*  1. `preflightSchema`: the checks the harness makes before it spawns anything
*     (root must be `type: "object"`; every `required` name must be in
*     `properties`, or the schema is unsatisfiable). A failure here is a
*     programming error in the script, so agent() THROWS, it does not return null.
*  2. `compileValidator`: ajv (draft 2020-12 dialect, non-strict so real
*     scripts' annotation keywords pass) used to validate every structured
*     result a backend returns. A mismatch is retried by the interpreter.
*/
var SchemaPreflightError = class extends Error {
	name = "SchemaPreflightError";
};
function preflightSchema(schema) {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new SchemaPreflightError("agent(): opts.schema must be a JSON Schema object");
	const s = schema;
	if (s.type !== "object") throw new SchemaPreflightError("agent(): schema root must be { type: 'object' }");
	const props = s.properties ?? {};
	const missing = (Array.isArray(s.required) ? s.required : []).filter((r) => typeof r !== "string" || !(r in props));
	if (missing.length) throw new SchemaPreflightError(`agent(): unsatisfiable schema, required not in properties: ${missing.join(", ")}`);
	try {
		compileValidator(s);
	} catch (e) {
		throw new SchemaPreflightError(`agent(): invalid schema: ${e.message}`);
	}
}
/**
* Validators cached by the schema's JSON text, one Ajv instance per distinct
* schema. One shared instance registers every `$id` it compiles, so the SECOND
* agent() call with a schema carrying `$id` threw "schema with key or id ...
* already exists" (MEASURED, test/edges.test.ts). Every call's opts arrive as a
* fresh object (JSON across the realm boundary), so an object-identity cache
* never hit either.
*/
const cache = /* @__PURE__ */ new Map();
function compileValidator(schema) {
	const text = JSON.stringify(schema);
	const hit = cache.get(text);
	if (hit) return hit;
	const fn = new Ajv({
		strict: false,
		allErrors: true,
		validateFormats: false
	}).compile(JSON.parse(text));
	const v = (value) => {
		if (fn(value)) return { ok: true };
		return {
			ok: false,
			errors: (fn.errors ?? []).map((e) => `${e.instancePath || "$"} ${e.message ?? "invalid"}`)
		};
	};
	cache.set(text, v);
	return v;
}
//#endregion
//#region src/workflow/meta.ts
/**
* The `export const meta = {...}` header of a workflow script.
*
* The Claude Code Workflow tool requires meta to be a PURE LITERAL: it is read
* without running the script. This module is a small tokenizer and recursive
* descent parser for exactly that literal language (objects, arrays, strings,
* template strings without `${}`, numbers, true/false/null, comments, trailing
* commas). Anything else, an identifier used as a value, a call, a spread, a
* computed key, an interpolation, is rejected with the offending offset. No
* part of the header is evaluated.
*
* The meta declaration is then cut out of the source and replaced by the same
* number of newlines, so line numbers in the body's stack traces stay true.
*/
var MetaError = class extends Error {
	name = "MetaError";
};
/** The validated meta shape. Only `name` and `description` are required. */
const WorkflowMeta = Schema.Struct({
	name: Schema.String.check(Schema.isNonEmpty()),
	description: Schema.String.check(Schema.isNonEmpty()),
	phases: Schema.optionalKey(Schema.Array(Schema.Struct({
		title: Schema.String,
		detail: Schema.optionalKey(Schema.String),
		model: Schema.optionalKey(Schema.String)
	})))
});
const decodeMeta = Schema.decodeUnknownSync(WorkflowMeta);
var LiteralParser = class {
	src;
	i;
	constructor(src, start) {
		this.src = src;
		this.i = start;
	}
	fail(msg) {
		const line = this.src.slice(0, this.i).split("\n").length;
		throw new MetaError(`meta is not a pure literal: ${msg} (line ${line}, offset ${this.i})`);
	}
	ws() {
		for (;;) {
			const c = this.src[this.i];
			if (c === " " || c === "	" || c === "\n" || c === "\r") this.i++;
			else if (this.src.startsWith("//", this.i)) {
				const e = this.src.indexOf("\n", this.i);
				this.i = e < 0 ? this.src.length : e + 1;
			} else if (this.src.startsWith("/*", this.i)) {
				const e = this.src.indexOf("*/", this.i + 2);
				if (e < 0) this.fail("unterminated comment");
				this.i = e + 2;
			} else return;
		}
	}
	value() {
		this.ws();
		const c = this.src[this.i];
		if (c === "{") return this.object();
		if (c === "[") return this.array();
		if (c === "\"" || c === "'") return this.string(c);
		if (c === "`") return this.template();
		if (c === "-" || c === "+" || c === "." || c !== void 0 && c >= "0" && c <= "9") return this.number();
		const id = this.ident();
		if (id === "true") return true;
		if (id === "false") return false;
		if (id === "null") return null;
		if (id === "") this.fail(`unexpected ${JSON.stringify(c ?? "end of input")}`);
		return this.fail(`free identifier '${id}' used as a value`);
	}
	ident() {
		const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.src.slice(this.i, this.i + 256));
		if (!m) return "";
		this.i += m[0].length;
		return m[0];
	}
	object() {
		this.i++;
		const out = Object.create(null);
		for (;;) {
			this.ws();
			if (this.src[this.i] === "}") {
				this.i++;
				return { ...out };
			}
			if (this.src.startsWith("...", this.i)) this.fail("spread");
			const c = this.src[this.i];
			let key;
			if (c === "\"" || c === "'") key = this.string(c);
			else if (c === "[") this.fail("computed key");
			else if (c !== void 0 && c >= "0" && c <= "9") key = String(this.number());
			else {
				key = this.ident();
				if (!key) this.fail(`unexpected ${JSON.stringify(c ?? "end of input")} where a key was expected`);
			}
			this.ws();
			if (this.src[this.i] !== ":") this.fail(`shorthand or method property '${key}'`);
			this.i++;
			if (key === "__proto__") this.fail("__proto__ key");
			out[key] = this.value();
			this.ws();
			if (this.src[this.i] === ",") this.i++;
			else if (this.src[this.i] !== "}") this.fail("expected ',' or '}'");
		}
	}
	array() {
		this.i++;
		const out = [];
		for (;;) {
			this.ws();
			if (this.src[this.i] === "]") {
				this.i++;
				return out;
			}
			if (this.src.startsWith("...", this.i)) this.fail("spread");
			out.push(this.value());
			this.ws();
			if (this.src[this.i] === ",") this.i++;
			else if (this.src[this.i] !== "]") this.fail("expected ',' or ']'");
		}
	}
	escape() {
		const c = this.src[this.i++];
		switch (c) {
			case "n": return "\n";
			case "t": return "	";
			case "r": return "\r";
			case "b": return "\b";
			case "f": return "\f";
			case "v": return "\v";
			case "0": return "\0";
			case "\n": return "";
			case "u": {
				if (this.src[this.i] === "{") {
					const e = this.src.indexOf("}", this.i);
					const cp = parseInt(this.src.slice(this.i + 1, e), 16);
					this.i = e + 1;
					return String.fromCodePoint(cp);
				}
				const h = this.src.slice(this.i, this.i + 4);
				if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail("bad \\u escape");
				this.i += 4;
				return String.fromCharCode(parseInt(h, 16));
			}
			case "x": {
				const h = this.src.slice(this.i, this.i + 2);
				if (!/^[0-9a-fA-F]{2}$/.test(h)) this.fail("bad \\x escape");
				this.i += 2;
				return String.fromCharCode(parseInt(h, 16));
			}
			case void 0: return this.fail("unterminated string");
			default: return c;
		}
	}
	string(q) {
		this.i++;
		let s = "";
		for (;;) {
			const c = this.src[this.i++];
			if (c === void 0 || c === "\n") this.fail("unterminated string");
			if (c === q) return s;
			s += c === "\\" ? this.escape() : c;
		}
	}
	template() {
		this.i++;
		let s = "";
		for (;;) {
			const c = this.src[this.i++];
			if (c === void 0) this.fail("unterminated template");
			if (c === "`") return s;
			if (c === "$" && this.src[this.i] === "{") {
				this.i--;
				this.fail("template interpolation");
			}
			s += c === "\\" ? this.escape() : c === "\r" ? "" : c;
		}
	}
	number() {
		const m = /^[+-]?(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?)/.exec(this.src.slice(this.i, this.i + 64));
		if (!m) return this.fail("bad number");
		this.i += m[0].length;
		const n = Number(m[0].replace(/_/g, ""));
		if (Number.isNaN(n)) this.fail("bad number");
		return n;
	}
};
/** Mask string, template and comment contents so a scan cannot match inside them. */
function findMetaDecl(src) {
	return /(^|[\n;])[ \t]*export\s+const\s+meta\s*=\s*/g.exec(src);
}
/** Parse and validate meta, and return the script body with meta cut out. */
function extractMeta(src) {
	const m = findMetaDecl(src);
	if (!m) throw new MetaError("script has no top-level `export const meta = {...}`");
	const declStart = m.index + m[1].length;
	const litStart = m.index + m[0].length;
	if (src[litStart] !== "{") new LiteralParser(src, litStart).fail("meta must be an object literal");
	const p = new LiteralParser(src, litStart);
	const raw = p.value();
	const end = p.i;
	p.ws();
	if (src[p.i] === ";") p.i++;
	else if (p.i < src.length) {
		if (/^[.([?+\-*/%&|^,=<>!`]/.test(src.slice(p.i, p.i + 1)) || /^(in|instanceof)\b/.test(src.slice(p.i, p.i + 11))) p.fail("meta literal is followed by an operator or call");
		const between = src.slice(end, p.i);
		if (!/\n/.test(between)) p.fail("meta literal must end the statement");
		p.i = end;
	}
	let decoded;
	try {
		decoded = decodeMeta(raw);
	} catch (e) {
		throw new MetaError(`meta does not have the required shape (name, description, phases?): ${e.message}`);
	}
	if (/(^|[\n;])[ \t]*export\s/.test(src.slice(p.i))) throw new MetaError("only `export const meta` may be exported");
	const blank = src.slice(declStart, p.i).replace(/[^\n]/g, "");
	return {
		meta: decoded,
		body: src.slice(0, declStart) + blank + src.slice(p.i)
	};
}
//#endregion
//#region src/workflow/replay.ts
var ReplayBackend = class {
	journal;
	options;
	name = "replay";
	divergences = [];
	requested = [];
	waiting = /* @__PURE__ */ new Map();
	position = /* @__PURE__ */ new Map();
	head = 0;
	pumping = false;
	agentIds = /* @__PURE__ */ new Map();
	/** Calls in flight at the kill: requested, never answered. */
	parked = [];
	resolveKilled;
	/** Resolves when the replay reaches the kill: only parked calls remain and the script is idle. */
	killed = new Promise((r) => this.resolveKilled = r);
	watching = false;
	constructor(journal, options = {}) {
		this.journal = journal;
		this.options = options;
		journal.terminalOrder.forEach((k, i) => this.position.set(k, i));
		for (const [k, list] of journal.started) {
			const last = list[list.length - 1];
			if (last) this.agentIds.set(k, last.agentId);
		}
	}
	run(call) {
		this.requested.push(call.key);
		if (!this.position.has(call.key) && this.journal.started.has(call.key)) {
			this.parked.push({
				index: call.index,
				key: call.key,
				label: call.opts.label
			});
			this.watchKill();
			return new Promise(() => {});
		}
		if (!this.position.has(call.key)) {
			this.divergences.push({
				index: call.index,
				key: call.key,
				label: call.opts.label
			});
			if (this.options.strict) return Promise.reject(/* @__PURE__ */ new Error(`replay divergence: call #${call.index} (${call.opts.label ?? "unlabelled"}) key ${call.key} is not in the journal`));
			return Promise.resolve({ error: `replay: key not in journal (${call.key})` });
		}
		return new Promise((resolve) => {
			const list = this.waiting.get(call.key) ?? [];
			list.push({
				call,
				resolve
			});
			this.waiting.set(call.key, list);
			this.pump();
		});
	}
	/** Resolve `killed` once parked calls exist and nothing else moves for `idleTurns` x 4 turns. */
	async watchKill() {
		if (this.watching) return;
		this.watching = true;
		try {
			const turns = (this.options.idleTurns ?? 50) * 4;
			for (;;) {
				const seen = this.requested.length;
				for (let t = 0; t < turns; t++) await new Promise((r) => setImmediate(r));
				if (!(this.pumping || [...this.waiting.values()].some((l) => l.length > 0)) && this.requested.length === seen) {
					this.resolveKilled();
					return;
				}
			}
		} finally {
			this.watching = false;
		}
	}
	outcome(key) {
		const agentId = this.agentIds.get(key) ?? "";
		const t = this.journal.tokens.get(key);
		const usage = t !== void 0 ? { usage: {
			inputTokens: 0,
			outputTokens: t
		} } : {};
		if (this.journal.results.has(key)) {
			const r = this.journal.results.get(key);
			return typeof r === "string" ? {
				text: r,
				agentId,
				...usage
			} : {
				object: r,
				agentId,
				...usage
			};
		}
		if (this.journal.budgetFailed?.has(key) === true) return {
			budgetExhausted: true,
			agentId,
			...usage,
			error: this.journal.failReasons?.get(key) ?? "agent(): budget exhausted (journal)"
		};
		return {
			skipped: true,
			agentId,
			...usage,
			error: this.journal.failReasons?.get(key) ?? this.options.failureReasons?.get(agentId) ?? "journal: failed"
		};
	}
	async pump() {
		if (this.pumping) return;
		this.pumping = true;
		try {
			const order = this.journal.terminalOrder;
			while (this.head < order.length) {
				const key = order[this.head];
				let w = this.waiting.get(key);
				if (!w || w.length === 0) {
					const turns = this.options.idleTurns ?? 50;
					for (let t = 0; t < turns && !this.waiting.get(key)?.length; t++) await new Promise((r) => setImmediate(r));
					w = this.waiting.get(key);
					if (!w || w.length === 0) {
						if (![...this.waiting.values()].some((l) => l.length > 0)) return;
						this.head++;
						continue;
					}
				}
				w.shift().resolve(this.outcome(key));
				this.head++;
				await new Promise((r) => setImmediate(r));
			}
			for (const [key, list] of this.waiting) while (list.length) list.shift().resolve(this.outcome(key));
		} finally {
			this.pumping = false;
			if ([...this.waiting.values()].some((l) => l.length > 0) && this.head < this.journal.terminalOrder.length) {
				const key = this.journal.terminalOrder[this.head];
				if (this.waiting.get(key)?.length) this.pump();
			}
		}
	}
};
//#endregion
//#region src/workflow/sandbox.ts
/**
* The script's realm: a fresh node:vm context with nothing from the host in it.
*
* The script sees only the ECMAScript intrinsics of its own realm plus the
* workflow builtins. Every builtin is DEFINED INSIDE the realm (see PRELUDE)
* and talks to the host through one captured `host` object that the script can
* never name. Values cross the boundary as JSON strings, and host errors are
* re-created as realm errors, so no host object (and so no host `Function`
* constructor, the classic node:vm escape) is ever reachable from the script.
*
* `parallel` and `pipeline` are pure combinators and run entirely in the realm.
* `Date.now()`, `Date()`, argless `new Date()` and `Math.random()` throw, as in
* the harness: they would make a resumed run diverge from its journal. So does
* `Intl.DateTimeFormat` format() or formatToParts() with no date (D17), which
* the spec defaults to the current time; Intl and the Date
* `toLocale*String` methods default to the UTC zone, not the host's; the Date
* local-time accessors (`getHours`, `setHours`, `getTimezoneOffset`,
* `toString`) and the multi-field constructor answer in UTC too.
*
* This is isolation of GLOBALS and of the host object graph, not a security
* boundary against a hostile script (vm shares the process, the heap and the
* event loop). Workflow scripts are the operator's own code.
*/
const PRELUDE = String.raw`
(function install(host) {
  "use strict";
  const RealDate = Date;
  const banned = (what) => { throw new Error(what + " is not available in a workflow script (it would break resume)"); };
  function GuardedDate(...a) {
    if (!new.target) banned("Date()");
    if (a.length === 0) banned("new Date()");
    // D17: the multi-field form reads its fields as UTC, not in the host zone.
    if (a.length >= 2) return Reflect.construct(RealDate, [RealDate.UTC(...a)], new.target);
    return Reflect.construct(RealDate, a, new.target);
  }
  Object.defineProperty(GuardedDate, "prototype", { value: RealDate.prototype, writable: false });
  Object.defineProperty(RealDate.prototype, "constructor", { value: GuardedDate, writable: false, configurable: false });
  GuardedDate.now = () => banned("Date.now()");
  GuardedDate.parse = RealDate.parse;
  GuardedDate.UTC = RealDate.UTC;
  Object.freeze(GuardedDate);
  Object.defineProperty(globalThis, "Date", { value: GuardedDate, writable: false, configurable: false });
  Object.defineProperty(Math, "random", { value: () => banned("Math.random()"), writable: false, configurable: false });
  // D17: an Intl date format with no date reads the clock (the spec defaults it to Date.now()).
  const DTFP = Intl.DateTimeFormat.prototype;
  const fmtGet = Object.getOwnPropertyDescriptor(DTFP, "format").get;
  // One wrapper per formatter, as the spec caches one bound format (f.format === f.format).
  const fmtCache = new WeakMap();
  Object.defineProperty(DTFP, "format", { get() {
    const f = fmtGet.call(this);
    let w = fmtCache.get(this);
    if (w === undefined) { w = (d) => (d === undefined ? banned("Intl.DateTimeFormat format() with no date") : f(d)); fmtCache.set(this, w); }
    return w;
  }, configurable: false });
  const fmtParts = DTFP.formatToParts;
  Object.defineProperty(DTFP, "formatToParts", { value: function formatToParts(d) { return d === undefined ? banned("Intl.DateTimeFormat formatToParts() with no date") : fmtParts.call(this, d); }, writable: false, configurable: false });

  // D17: Intl reads the clock (an argless format()) and the host time zone (the default timeZone). Pin the
  // default zone to UTC and refuse a format with no date, so a resumed run on another host cannot diverge.
  const RealDTF = Intl.DateTimeFormat;
  const pinUtc = (o) => { const x = Object.assign({}, o); if (x.timeZone === undefined) x.timeZone = "UTC"; return x; };
  const needDate = (what, d) => { if (d === undefined) banned("Intl.DateTimeFormat " + what + "() with no date"); return d; };
  function GuardedDTF(locales, options) {
    const inner = new RealDTF(locales, pinUtc(options));
    const self = Object.create(GuardedDTF.prototype);
    Object.defineProperties(self, {
      format: { value: (d) => inner.format(needDate("format", d)) },
      formatToParts: { value: (d) => inner.formatToParts(needDate("formatToParts", d)) },
      formatRange: { value: (a, b) => inner.formatRange(a, b) },
      formatRangeToParts: { value: (a, b) => inner.formatRangeToParts(a, b) },
      resolvedOptions: { value: () => inner.resolvedOptions() },
    });
    return Object.freeze(self);
  }
  GuardedDTF.supportedLocalesOf = RealDTF.supportedLocalesOf;
  Object.freeze(GuardedDTF.prototype);
  Object.freeze(GuardedDTF);
  Object.defineProperty(Intl, "DateTimeFormat", { value: GuardedDTF, writable: false, configurable: false });
  // The local-time accessors answer in UTC, so the host zone never reaches the script through Date either.
  const DP = RealDate.prototype;
  for (const f of ["FullYear", "Month", "Date", "Day", "Hours", "Minutes", "Seconds", "Milliseconds"]) {
    Object.defineProperty(DP, "get" + f, { value: DP["getUTC" + f], writable: false, configurable: false });
    if (f !== "Day") Object.defineProperty(DP, "set" + f, { value: DP["setUTC" + f], writable: false, configurable: false });
  }
  Object.defineProperty(DP, "getTimezoneOffset", { value: function () { return 0; }, writable: false, configurable: false });
  const realToUTCString = DP.toUTCString;
  Object.defineProperty(DP, "toString", { value: function () { return realToUTCString.call(this); }, writable: false, configurable: false });
  Object.defineProperty(DP, "toDateString", { value: function () { return realToUTCString.call(this).slice(0, 16); }, writable: false, configurable: false });
  Object.defineProperty(DP, "toTimeString", { value: function () { return realToUTCString.call(this).slice(17); }, writable: false, configurable: false });
  for (const m of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]) {
    const real = RealDate.prototype[m];
    Object.defineProperty(RealDate.prototype, m, { value: function (locales, options) { return real.call(this, locales, pinUtc(options)); }, writable: false, configurable: false });
  }

  const realmError = (e) => new Error(e && typeof e.message === "string" ? e.message : String(e));
  const decode = (s) => JSON.parse(s);
  const optsJson = (o) => {
    if (o === undefined || o === null) return undefined;
    if (typeof o !== "object") throw new TypeError("agent(prompt, opts): opts must be an object");
    return JSON.stringify(o, (k, v) => (typeof v === "function" ? undefined : v));
  };

  // D06 lanes. "lane" is non-empty only while a combinator synchronously runs
  // a thunk or a stage for one item; every continuation after an await sees
  // "" (or the enclosing lane), so only a call made synchronously in a lane is
  // tagged, and an untagged call keeps the conservative lineage rule.
  let lane = "";
  let combinators = 0;
  const inLane = (path, f) => { const saved = lane; lane = path; try { return f(); } finally { lane = saved; } };

  async function agent(prompt, opts) {
    const myLane = lane;
    let p;
    try { p = host.agent(prompt, optsJson(opts), myLane === "" ? undefined : myLane); } catch (e) { throw realmError(e); }
    let s;
    try { s = await p; } catch (e) { throw realmError(e); }
    return decode(s);
  }

  const checkItems = (name, n) => {
    const cap = host.maxItems();
    if (n > cap) throw new Error(name + ": " + n + " items exceeds the per-call cap of " + cap);
  };
  const why = (e) => (e && typeof e.message === "string" ? e.message : String(e));

  async function parallel(thunks) {
    if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks): thunks must be an array");
    checkItems("parallel", thunks.length);
    const base = lane + "/" + (++combinators);
    return Promise.all(thunks.map((t, i) =>
      Promise.resolve()
        .then(() => (typeof t === "function" ? inLane(base + ":" + i, t) : t))
        .catch((e) => { host.itemNull("parallel", i, 0, why(e)); return null; })));
  }

  async function pipeline(items, ...stages) {
    if (!Array.isArray(items)) throw new TypeError("pipeline(items, ...stages): items must be an array");
    checkItems("pipeline", items.length);
    for (const s of stages) if (typeof s !== "function") throw new TypeError("pipeline: every stage must be a function");
    const base = lane + "/" + (++combinators);
    return Promise.all(items.map(async (item, index) => {
      let prev = item;
      for (let s = 0; s < stages.length; s++) {
        try { const v = prev; prev = await inLane(base + ":" + index, () => stages[s](v, item, index)); }
        catch (e) { host.itemNull("pipeline", index, s, why(e)); return null; }
      }
      return prev;
    }));
  }

  const phase = (title) => { host.phase(String(title)); };
  const log = (message) => { host.log(typeof message === "string" ? message : String(message)); };
  const budget = Object.freeze({
    get total() { return host.budgetTotal(); },
    spent: () => host.budgetSpent(),
    remaining: () => { const t = host.budgetTotal(); return t === null ? Infinity : Math.max(0, t - host.budgetSpent()); },
  });
  async function workflow(ref, args) {
    const name = typeof ref === "string" ? ref : ref && typeof ref.scriptPath === "string" ? ref.scriptPath : ref && typeof ref.name === "string" ? ref.name : null;
    if (name === null) throw new TypeError("workflow(nameOrRef, args): name must be a string or { scriptPath } / { name }");
    let p;
    try { p = host.workflow(name, args === undefined ? undefined : JSON.stringify(args)); } catch (e) { throw realmError(e); }
    let s;
    try { s = await p; } catch (e) { throw realmError(e); }
    return decode(s);
  }
  return Object.freeze({ agent, parallel, pipeline, phase, log, budget, workflow });
})
`;
/**
* Compile a script body (meta already cut out) into its own realm.
* `lineOffset` keeps stack-trace line numbers equal to the file's.
*/
function compileInRealm(body, filename, host) {
	const ctx = vm.createContext(Object.create(null), {
		name: filename,
		codeGeneration: {
			strings: true,
			wasm: false
		}
	});
	const builtins = new vm.Script(PRELUDE, { filename: "workflow-prelude.js" }).runInContext(ctx)(host);
	const wrapped = "(async function (agent, parallel, pipeline, phase, log, budget, workflow, __argsJson) {\n\"use strict\"; const args = __argsJson === undefined ? undefined : JSON.parse(__argsJson);\n" + body + "\n})";
	let fn;
	try {
		fn = new vm.Script(wrapped, {
			filename,
			lineOffset: -2
		}).runInContext(ctx);
	} catch (e) {
		throw new SyntaxError(`${filename}: ${e.message}`);
	}
	const toJson = new vm.Script("(v) => { const s = JSON.stringify(v === undefined ? null : v); return s === undefined ? 'null' : s; }").runInContext(ctx);
	return { async run(argsJson) {
		const v = await fn(builtins.agent, builtins.parallel, builtins.pipeline, builtins.phase, builtins.log, builtins.budget, builtins.workflow, argsJson);
		return toJson(v);
	} };
}
/** The harness's default: min(16, cpus - 2), and at least 1. */
function defaultConcurrency(n = cpus().length) {
	return Math.max(1, Math.min(16, n - 2));
}
var BudgetExhaustedError = class extends Error {
	name = "BudgetExhaustedError";
};
var AgentCapError = class extends Error {
	name = "AgentCapError";
};
var Semaphore = class {
	permits;
	active = 0;
	queue = [];
	peak = 0;
	constructor(permits) {
		this.permits = permits;
		if (!(permits >= 1)) throw new RangeError("concurrency must be at least 1");
	}
	acquire() {
		if (this.active < this.permits) {
			this.active++;
			this.peak = Math.max(this.peak, this.active);
			return Promise.resolve();
		}
		return new Promise((r) => this.queue.push(() => {
			this.peak = Math.max(this.peak, this.active);
			r();
		}));
	}
	release() {
		const next = this.queue.shift();
		if (next) next();
		else this.active--;
	}
	get inFlight() {
		return this.active;
	}
};
/**
* Journaled failure reasons that "replay" still retries (C3-5): the call never
* ran, or ran into a limit a new start can lift. Anything else (a harness
* verdict, a schema mismatch after every attempt) is replayed as a null.
* Errs toward retry: an unknown reason that names one of these is retried.
*/
const HARNESS_VERDICT = /^runtime [^\s:]+: [^\s:]+ exited -?\d+/;
const retryableFailure = (reason) => !HARNESS_VERDICT.test(reason) && /budget exhausted|capacity refused|aborted|conwip refused|runner threw|refused|already exists|^skipped$|^journal: failed$/i.test(reason);
/** Usage summed key by key over a call's attempts (every finite count the backend reported). */
const addUsage = (prior, u) => {
	const out = { ...prior ?? {} };
	for (const [k, v] of Object.entries(u)) if (typeof v === "number" && Number.isFinite(v)) out[k] = (out[k] ?? 0) + v;
	return out;
};
const newRunId = () => `wf_${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex").slice(0, 3)}`;
const defaultAgentId = () => `a${randomBytes(8).toString("hex").slice(0, 16)}`;
function defaultResolver(ref, fromPath) {
	const base = fromPath ? dirname(fromPath) : process.cwd();
	const candidates = ref.endsWith(".js") ? [isAbsolute(ref) ? ref : resolve(base, ref)] : [join(base, `${ref}.js`), join(process.cwd(), ".claude", "workflows", `${ref}.js`)];
	for (const p of candidates) try {
		return {
			source: readFileSync(p, "utf8"),
			path: p
		};
	} catch {}
	throw new Error(`workflow(): cannot resolve '${ref}' (looked in ${candidates.join(", ")})`);
}
function preview(v) {
	const s = typeof v === "string" ? v : JSON.stringify(v) ?? "null";
	return s.length > 400 ? `${s.slice(0, 400)}\u2026` : s;
}
/**
* The text the record's `error` starts with: `<name>: <message>`. MEASURED
* (wf_12695394-85a): "TypeError: args.repos.map is not a function. ...". The
* harness appends its engine's stack; ours would be V8's, so it is left out.
*/
function errorText(e) {
	if (e && typeof e.message === "string") return `${typeof e.name === "string" && e.name ? e.name : "Error"}: ${e.message}`;
	return String(e);
}
async function runWorkflow(source, options) {
	const shared = {
		opts: options,
		sem: new Semaphore(options.concurrency ?? defaultConcurrency()),
		maxAgents: options.maxAgents ?? 1e3,
		maxItems: options.maxItems ?? 4096,
		maxAttempts: Math.max(1, options.maxAttempts ?? 3),
		calls: [],
		events: [],
		logs: [],
		phases: [],
		count: 0,
		lastKey: "",
		prefixBroken: false,
		spent: options.resumeFrom?.tokensSpent ?? 0,
		occurrences: /* @__PURE__ */ new Map(),
		tick: 0,
		realms: 0,
		laneEpoch: `e${options.resumeFrom?.events.length ?? 0}`,
		cacheOrder: options.resumeFrom !== void 0 && options.cacheRelease === "recorded" ? new ReplayBackend(options.resumeFrom) : void 0
	};
	const runId = options.runId ?? newRunId();
	const startTime = Date.now();
	if (options.resumeFrom === void 0) options.journal?.append({ type: "launched" });
	const top = await runScript(shared, source, options.scriptPath, options.args, 0, runId);
	const record = buildRecord(shared, top, runId, source, startTime);
	return {
		runId,
		status: top.status,
		result: top.result,
		error: top.error,
		meta: top.meta,
		calls: shared.calls,
		logs: shared.logs,
		phases: shared.phases,
		events: shared.events,
		peakConcurrency: shared.sem.peak,
		totalTokens: shared.spent,
		record
	};
}
async function runScript(shared, source, scriptPath, args, depth, runId) {
	const { meta, body } = extractMeta(source);
	const o = shared.opts;
	const emit = (ev) => {
		shared.events.push(ev);
		o.events?.emit(ev);
	};
	emit({
		type: "run_start",
		runId,
		workflowName: meta.name,
		depth
	});
	let currentPhase;
	const phaseIndex = (t) => {
		if (t === void 0) return void 0;
		const i = meta.phases?.findIndex((p) => p.title === t) ?? -1;
		return i >= 0 ? i + 1 : void 0;
	};
	const writeLog = (message) => {
		shared.logs.push(message);
		emit({
			type: "log",
			message,
			depth
		});
	};
	const realmLane = `${shared.laneEpoch}.r${++shared.realms}`;
	const agent = async (prompt, optsJson, laneIn) => {
		const lane = typeof laneIn === "string" && laneIn !== "" ? `${realmLane}${laneIn}` : void 0;
		if (typeof prompt !== "string") throw new TypeError("agent(prompt, opts): prompt must be a string");
		const opts = optsJson === void 0 ? {} : JSON.parse(optsJson);
		if (opts.schema !== void 0) preflightSchema(opts.schema);
		if (shared.count >= shared.maxAgents) throw new AgentCapError(`agent(): lifetime cap of ${shared.maxAgents} agents reached`);
		const total = o.budgetTotal ?? null;
		const phase = opts.phase !== void 0 ? String(opts.phase) : currentPhase;
		const label = opts.label === void 0 || opts.label === null ? void 0 : String(opts.label);
		const key = chainKey(shared.lastKey, prompt, opts);
		const chash = contentHash(prompt, opts);
		const occurrence = (shared.occurrences.get(chash) ?? 0) + 1;
		const cid = contentId(chash, occurrence);
		const cache = o.resumeFrom;
		const byContent = o.cacheIdentity === "content";
		const cacheKey = cache === void 0 ? void 0 : byContent ? cache.byCid.get(cid) ?? key : key;
		let hit = cache !== void 0 && cacheKey !== void 0 && (byContent || !shared.prefixBroken) && cache.results.has(cacheKey);
		let rejected;
		if (hit && opts.schema !== void 0) {
			const v = compileValidator(opts.schema)(cache.results.get(cacheKey));
			if (!v.ok) {
				hit = false;
				rejected = `schema mismatch: ${v.errors.join("; ")}`;
			}
		}
		let replayFail;
		if (!hit && rejected === void 0 && cache !== void 0 && cacheKey !== void 0 && o.resumeFailures === "replay" && (byContent || !shared.prefixBroken) && cache.lastFailed.has(cacheKey) && !cache.budgetFailed.has(cacheKey)) {
			const reason = cache.failReasons.get(cacheKey) ?? "journal: failed";
			if (!(o.isRetryableFailure ?? retryableFailure)(reason)) replayFail = reason;
		}
		if (!hit && replayFail === void 0 && total !== null && shared.spent >= total) throw new BudgetExhaustedError(`agent(): budget exhausted (${shared.spent} of ${total} tokens spent)`);
		if (!byContent && cache !== void 0 && !hit && replayFail === void 0 && !shared.prefixBroken) {
			if (!(rejected === void 0 && (cache.started.get(key)?.length ?? 0) > 0 && !cache.failed.has(key))) shared.prefixBroken = true;
		}
		const index = ++shared.count;
		shared.lastKey = key;
		shared.occurrences.set(chash, occurrence);
		const declared = opts.model ?? meta.phases?.find((p) => p.title === phase)?.model ?? o.defaultModel;
		let model = declared;
		if (o.modelPolicy) {
			model = o.modelPolicy(declared, {
				index,
				label,
				phase,
				opts
			});
			if (model !== declared) emit({
				type: "model_rewrite",
				index,
				from: String(declared),
				to: String(model)
			});
		}
		const rec = {
			index,
			key,
			label,
			phase,
			model,
			schema: opts.schema !== void 0,
			prompt,
			depth,
			phaseIndex: phaseIndex(phase),
			state: "queued",
			attempts: 0,
			agentId: void 0,
			startTick: void 0,
			endTick: void 0,
			tokens: 0,
			resultPreview: void 0,
			error: void 0,
			harnessSessionId: void 0,
			usage: void 0,
			route: void 0,
			sessionFile: void 0
		};
		shared.calls.push(rec);
		emit({
			type: "agent_queued",
			index,
			key,
			label,
			phase
		});
		if (rejected !== void 0) emit({
			type: "cache_rejected",
			index,
			key,
			reason: rejected
		});
		if (hit) {
			const value = cache.results.get(cacheKey);
			rec.state = "cached";
			rec.agentId = cache.started.get(cacheKey)?.at(-1)?.agentId;
			rec.tokens = cache.tokens.get(cacheKey) ?? 0;
			rec.resultPreview = preview(value);
			emit({
				type: "agent_cached",
				index,
				key,
				label
			});
			if (shared.cacheOrder) await shared.cacheOrder.run({
				index,
				key: cacheKey,
				prompt,
				opts,
				phase,
				attempt: 1
			});
			if (o.copyCachedToJournal === true && o.journal) {
				o.journal.append({
					type: "started",
					key,
					agentId: rec.agentId ?? "",
					...label !== void 0 && { label },
					...phase !== void 0 && { phase },
					cid,
					...lane !== void 0 && { lane }
				});
				o.journal.append({
					type: "result",
					key,
					agentId: rec.agentId ?? "",
					result: value,
					tokens: rec.tokens
				});
			}
			return JSON.stringify(value ?? null);
		}
		if (replayFail !== void 0) {
			rec.state = "null";
			rec.error = replayFail;
			rec.agentId = cache.started.get(cacheKey)?.at(-1)?.agentId;
			rec.tokens = cache.tokens.get(cacheKey) ?? 0;
			if (shared.cacheOrder) await shared.cacheOrder.run({
				index,
				key: cacheKey,
				prompt,
				opts,
				phase,
				attempt: 1
			});
			if (o.copyCachedToJournal === true && o.journal) {
				o.journal.append({
					type: "started",
					key,
					agentId: rec.agentId ?? "",
					...label !== void 0 && { label },
					...phase !== void 0 && { phase },
					cid,
					...lane !== void 0 && { lane }
				});
				o.journal.append({
					type: "failed",
					key,
					agentId: rec.agentId ?? "",
					tokens: rec.tokens,
					error: replayFail
				});
			}
			emit({
				type: "agent_done",
				index,
				key,
				state: "null",
				reason: `replayed from the journal: ${replayFail}`
			});
			return "null";
		}
		await shared.sem.acquire();
		if (total !== null && shared.spent >= total) {
			shared.sem.release();
			rec.state = "null";
			const reason = `agent(): budget exhausted (${shared.spent} of ${total} tokens spent)`;
			const agentId = o.newAgentId?.() ?? defaultAgentId();
			rec.agentId = agentId;
			rec.error = reason;
			o.journal?.append({
				type: "started",
				key,
				agentId,
				...label !== void 0 && { label },
				...phase !== void 0 && { phase },
				cid,
				...lane !== void 0 && { lane }
			});
			o.journal?.append({
				type: "failed",
				key,
				agentId,
				error: reason,
				budgetExhausted: true
			});
			writeLog(`[${label ?? `#${index}`}] failed: ${reason}`);
			emit({
				type: "agent_done",
				index,
				key,
				state: "failed",
				reason
			});
			throw new BudgetExhaustedError(reason);
		}
		rec.state = "running";
		rec.startTick = ++shared.tick;
		let previousErrors;
		let outcome;
		let final = null;
		let failReason;
		let sessionId;
		try {
			for (let attempt = 1; attempt <= shared.maxAttempts; attempt++) {
				rec.attempts = attempt;
				const agentId = o.newAgentId?.() ?? defaultAgentId();
				rec.agentId = agentId;
				if (attempt === 1) o.journal?.append({
					type: "started",
					key,
					agentId,
					...label !== void 0 && { label },
					...phase !== void 0 && { phase },
					cid,
					...lane !== void 0 && { lane }
				});
				emit({
					type: "agent_started",
					index,
					key,
					agentId,
					attempt
				});
				const call = {
					index,
					key,
					prompt,
					opts: {
						...opts,
						...model !== void 0 && { model }
					},
					phase,
					attempt,
					...previousErrors && { previousErrors },
					occurrence,
					cid,
					budgetExhausted: () => total !== null && shared.spent >= total ? `agent(): budget exhausted (${shared.spent} of ${total} tokens spent)` : void 0
				};
				outcome = await o.backend.run(call);
				if (outcome.budgetExhausted === true) throw new BudgetExhaustedError(outcome.error ?? `agent(): budget exhausted (${shared.spent} of ${total ?? "?"} tokens spent)`);
				if (outcome.agentId) sessionId = outcome.agentId;
				rec.harnessSessionId = sessionId;
				if (outcome.usage) rec.usage = addUsage(rec.usage, outcome.usage);
				if (outcome.route) rec.route = outcome.route;
				if (outcome.sessionFile) rec.sessionFile = outcome.sessionFile;
				const used = outcome.usage?.outputTokens ?? 0;
				shared.spent += used;
				rec.tokens += used;
				if (outcome.skipped) {
					failReason = outcome.error ?? "skipped";
					break;
				}
				if (outcome.error !== void 0) {
					failReason = outcome.error;
					break;
				} else if (opts.schema !== void 0) {
					const v = compileValidator(opts.schema)(outcome.object);
					if (outcome.object !== void 0 && v.ok) {
						final = outcome.object;
						failReason = void 0;
						break;
					}
					failReason = outcome.object === void 0 ? "no structured output" : `schema mismatch: ${v.errors.join("; ")}`;
					previousErrors = v.ok ? [failReason] : v.errors;
				} else if (typeof outcome.text === "string") {
					final = outcome.text;
					failReason = void 0;
					break;
				} else {
					failReason = "no text output";
					previousErrors = [failReason];
				}
				if (total !== null && shared.spent >= total) break;
				if (attempt < shared.maxAttempts) emit({
					type: "agent_retry",
					index,
					key,
					attempt: attempt + 1,
					reason: failReason
				});
			}
		} catch (e) {
			rec.endTick = ++shared.tick;
			rec.state = "null";
			shared.sem.release();
			rec.error = e.message;
			o.journal?.append({
				type: "failed",
				key,
				agentId: rec.agentId ?? "",
				tokens: rec.tokens,
				error: e.message,
				...e instanceof BudgetExhaustedError && { budgetExhausted: true }
			});
			emit({
				type: "agent_done",
				index,
				key,
				state: "failed",
				reason: e.message,
				...sessionId !== void 0 && { sessionId }
			});
			throw e;
		}
		rec.endTick = ++shared.tick;
		shared.sem.release();
		if (failReason === void 0) {
			rec.state = "done";
			rec.resultPreview = preview(final);
			o.journal?.append({
				type: "result",
				key,
				agentId: rec.agentId ?? "",
				result: final,
				tokens: rec.tokens
			});
			emit({
				type: "agent_done",
				index,
				key,
				state: "done",
				...sessionId !== void 0 && { sessionId }
			});
			return JSON.stringify(final);
		}
		rec.state = "null";
		rec.error = failReason;
		o.journal?.append({
			type: "failed",
			key,
			agentId: rec.agentId ?? "",
			tokens: rec.tokens,
			error: failReason
		});
		writeLog(`[${label ?? `#${index}`}] failed: ${failReason}`);
		emit({
			type: "agent_done",
			index,
			key,
			state: "null",
			reason: failReason,
			...sessionId !== void 0 && { sessionId }
		});
		return "null";
	};
	const host = {
		agent,
		phase(title) {
			currentPhase = title;
			shared.phases.push(title);
			emit({
				type: "phase",
				title,
				index: phaseIndex(title),
				depth
			});
		},
		log(message) {
			writeLog(message);
		},
		itemNull(where, item, stage, reason) {
			emit({
				type: "item_null",
				where,
				item,
				...where === "pipeline" && { stage },
				reason
			});
		},
		maxItems: () => shared.maxItems,
		budgetTotal: () => o.budgetTotal ?? null,
		budgetSpent: () => shared.spent,
		async workflow(ref, argsJson) {
			if (depth >= 1) throw new Error(`workflow(): nesting is limited to 1 level`);
			const src = (o.resolveWorkflow ?? defaultResolver)(ref, scriptPath);
			const child = await runScript(shared, src.source, src.path, argsJson === void 0 ? void 0 : JSON.parse(argsJson), depth + 1, `${runId}/${ref}`);
			if (child.status === "failed") throw new Error(`workflow(${ref}) failed: ${child.error}`);
			return JSON.stringify(child.result ?? null);
		}
	};
	let status = "completed";
	let result = null;
	let error;
	try {
		const compiled = compileInRealm(body, scriptPath ?? `${meta.name}.js`, host);
		const argsJson = args === void 0 ? void 0 : JSON.stringify(args);
		result = JSON.parse(await compiled.run(argsJson));
	} catch (e) {
		status = "failed";
		error = errorText(e);
	}
	emit({
		type: "run_end",
		runId,
		status,
		...error !== void 0 && { error },
		depth
	});
	return {
		status,
		result,
		error,
		meta
	};
}
function buildRecord(shared, top, runId, script, startTime) {
	const phases = top.meta.phases ?? [];
	return {
		runId,
		timestamp: new Date(startTime).toISOString(),
		scriptPath: shared.opts.scriptPath,
		script,
		args: shared.opts.args,
		result: top.result,
		...top.error !== void 0 && { error: top.error },
		agentCount: shared.calls.length,
		logs: shared.logs,
		durationMs: Date.now() - startTime,
		summary: top.meta.description,
		workflowName: top.meta.name,
		status: top.status,
		startTime,
		phases,
		defaultModel: shared.opts.defaultModel,
		totalTokens: shared.spent,
		...typeof shared.opts.budgetTotal === "number" && { budgetTotal: shared.opts.budgetTotal },
		workflowProgress: [...phases.map((p, i) => ({
			type: "workflow_phase",
			index: i + 1,
			title: p.title
		})), ...shared.calls.map((c) => ({
			type: "workflow_agent",
			index: c.index,
			label: c.label,
			phaseIndex: c.phaseIndex,
			phaseTitle: c.phase,
			agentId: c.agentId,
			model: c.model,
			state: c.state === "cached" ? "done" : c.state === "null" ? "error" : c.state,
			...c.state === "cached" ? { cached: true } : { attempt: c.attempts },
			...c.error !== void 0 && { error: c.error },
			tokens: c.tokens,
			promptPreview: preview(c.prompt.trim()),
			resultPreview: c.resultPreview
		}))]
	};
}
//#endregion
//#region src/workflow/journal.ts
const Key = Schema.String.check(Schema.isPattern(KEY_PATTERN));
const Cid = Schema.String.check(Schema.isPattern(CID_PATTERN));
/** Tokens a call spent (input + output), on its terminal line (D10). Optional: harness journals carry none. */
const Tokens = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const JournalEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("launched") }),
	Schema.Struct({
		type: Schema.Literal("started"),
		key: Key,
		agentId: Schema.String,
		label: Schema.optionalKey(Schema.String),
		phase: Schema.optionalKey(Schema.String),
		/** The call's content identity (key.ts contentId); absent in harness journals. */
		cid: Schema.optionalKey(Cid),
		/**
		* D06: the call's lane, `<epoch>.r<realm>/<combinator>:<item>/...`, when it
		* was invoked synchronously inside a parallel() thunk or a pipeline() stage;
		* absent otherwise. Two calls whose lanes differ first in the item of one
		* combinator ran on independent chains (see record.ts siblingLanes).
		*/
		lane: Schema.optionalKey(Schema.String)
	}),
	Schema.Struct({
		type: Schema.Literal("result"),
		key: Key,
		agentId: Schema.String,
		result: Schema.Unknown,
		tokens: Schema.optionalKey(Tokens)
	}),
	Schema.Struct({
		type: Schema.Literal("failed"),
		key: Key,
		agentId: Schema.String,
		tokens: Schema.optionalKey(Tokens),
		error: Schema.optionalKey(Schema.String),
		budgetExhausted: Schema.optionalKey(Schema.Boolean)
	})
]);
const decodeEvent = Schema.decodeUnknownOption(JournalEvent);
function parseJournal(text) {
	const events = [];
	let skippedLines = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let raw;
		try {
			raw = JSON.parse(line);
		} catch {
			skippedLines++;
			continue;
		}
		const ev = decodeEvent(raw);
		if (ev._tag === "Some") events.push(ev.value);
		else skippedLines++;
	}
	const results = /* @__PURE__ */ new Map();
	const started = /* @__PURE__ */ new Map();
	const failed = /* @__PURE__ */ new Set();
	const startOrder = [];
	const terminal = [];
	const byCid = /* @__PURE__ */ new Map();
	const tokens = /* @__PURE__ */ new Map();
	const failReasons = /* @__PURE__ */ new Map();
	const budgetFailed = /* @__PURE__ */ new Set();
	const lastFailed = /* @__PURE__ */ new Set();
	let tokensSpent = 0;
	for (const e of events) {
		if ((e.type === "result" || e.type === "failed") && e.tokens !== void 0) {
			tokensSpent += e.tokens;
			tokens.set(e.key, e.tokens);
		}
		if (e.type === "failed") lastFailed.add(e.key);
		else if (e.type === "result" || e.type === "started") lastFailed.delete(e.key);
		if (e.type === "result") {
			results.set(e.key, e.result);
			const i = terminal.indexOf(e.key);
			if (i >= 0) terminal.splice(i, 1);
			terminal.push(e.key);
		} else if (e.type === "started") {
			const entry = {
				key: e.key,
				agentId: e.agentId,
				label: e.label,
				phase: e.phase,
				...e.cid !== void 0 && { cid: e.cid }
			};
			if (e.cid !== void 0) byCid.set(e.cid, e.key);
			const list = started.get(e.key);
			if (list) list.push(entry);
			else {
				started.set(e.key, [entry]);
				startOrder.push(entry);
			}
		} else if (e.type === "failed") {
			failed.add(e.key);
			if (e.error !== void 0) failReasons.set(e.key, e.error);
			if (e.budgetExhausted === true) budgetFailed.add(e.key);
			else budgetFailed.delete(e.key);
			if (!results.has(e.key)) {
				const i = terminal.indexOf(e.key);
				if (i >= 0) terminal.splice(i, 1);
				terminal.push(e.key);
			}
		}
	}
	return {
		events,
		results,
		started,
		failed,
		startOrder,
		terminalOrder: terminal,
		skippedLines,
		byCid,
		tokensSpent,
		tokens,
		failReasons,
		budgetFailed,
		lastFailed
	};
}
//#endregion
//#region src/sources/workflow-trigger.ts
const SOURCE = "workflow";
/** What a node with a schema is asked to reply with, worded as Substrate's runners word it. */
const SCHEMA_INSTRUCTION = "Reply with one JSON value only, no prose and no code fence, valid against this JSON Schema:";
/**
* A call's node name within its run: the start of its content identity and its occurrence among identical calls, which the
* interpreter fixes when the script makes the call, so a resumed run names each call as the run before it did.
*/
function nodeOf(call) {
	const hash = call.cid === void 0 ? void 0 : /^c1:([0-9a-f]{16})/.exec(call.cid)?.[1];
	if (!hash) throw new Error(`workflow: a call without a content identity (${String(call.cid)})`);
	return `${hash}-o${call.occurrence ?? 1}`;
}
/**
* The Thread of a node, its own, so no other node's Ticket receives its Triggers. A later attempt follows only a Ticket that
* ended completed, which a Trigger that no person wrote does not resume, so it goes to Eval as the first did.
*/
const nodeThread = (run, node) => `${run}:${node}`;
/** The Trigger id of one attempt of a node. */
const nodeTriggerId = (run, node, attempt) => `wf:${nodeThread(run, node)}-a${attempt}`;
/**
* The Trigger of one attempt of a call: senderless and unaddressed, so the gate admits it only through the workflow row of the
* Source's admission table. Its text is the prompt, followed by the schema instruction when the call has a schema; `meta` tells
* the Executor the directory, compute pair and labels of the node.
*/
function nodeTrigger(run, call, at = (/* @__PURE__ */ new Date()).toISOString()) {
	const node = nodeOf(call);
	const { label, schema, model, effort } = call.opts;
	const text = schema === void 0 ? call.prompt : `${call.prompt}\n\n${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`;
	return {
		id: nodeTriggerId(run.id, node, call.attempt),
		source: SOURCE,
		threads: [{
			source: SOURCE,
			id: nodeThread(run.id, node)
		}],
		actor: {
			source: SOURCE,
			id: ""
		},
		human: false,
		at,
		text,
		meta: {
			kind: "workflow-node",
			run: run.id,
			workflow: run.name,
			node,
			cid: call.cid,
			occurrence: call.occurrence,
			attempt: call.attempt,
			...label !== void 0 && { label: String(label) },
			...call.phase !== void 0 && { phase: call.phase },
			cwd: run.cwd,
			...run.pair !== void 0 && { pair: run.pair },
			...model !== void 0 && { model: String(model) },
			...effort !== void 0 && { effort: String(effort) },
			labels: {
				"superagent.run": run.id,
				"superagent.node": node
			}
		}
	};
}
//#endregion
//#region src/sources/workflow-backend.ts
/** The interpreter's Backend over the Engine: a call becomes a Trigger, and its answer is the result of the Ticket accepted from it. */
/** Every failure a node's Ticket gives starts with this, so a resumed run answers it from the journal as the same null. */
const NODE_FAILURE = "workflow node ";
/** Whether a resumed run tries a journaled failure again: never a node's own, else as the interpreter decides. */
const retriedOnResume = (reason) => !reason.startsWith("workflow node ") && retryableFailure(reason);
const stripFence = (text) => /^\s*```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/.exec(text)?.[1] ?? text.trim();
/** A structured reply: one JSON value, inside one code fence at most; anything else is text, which the interpreter treats as no object. */
function parseJsonReply(text) {
	try {
		return { object: JSON.parse(stripFence(text)) };
	} catch {
		return { text };
	}
}
/**
* The whole summary of a completed Ticket whose worker gave no final answer, as the dshd Executor words it for a unit that
* exited 0 without one. It is not a result: the node has no answer.
*/
const NO_ANSWER = /^Unit [a-z0-9][a-z0-9_-]* exited 0\.$/;
/**
* What a node's Ticket answers once it settled, or undefined while it has not: the summary of its `ready` report, verbatim,
* once it ended completed; no answer when that summary only says the unit exited 0, which the interpreter, as for any empty
* answer, tries again while attempts remain and otherwise journals as the node's null; or a failure once the Ticket ended
* otherwise or its worker reported failed or blocked.
*/
function settle(ticket, structured) {
	if (!ticket) return void 0;
	const report = latestAssignment(ticket)?.report;
	const outcome = ticket.ended?.outcome;
	if (outcome === "completed" && report?.state === "ready") {
		if (NO_ANSWER.test(report.summary)) return { agentId: ticket.id };
		return {
			...structured ? parseJsonReply(report.summary) : { text: report.summary },
			agentId: ticket.id
		};
	}
	const state = outcome ?? (report?.state === "failed" || report?.state === "blocked" ? report.state : void 0);
	if (state === void 0) return void 0;
	return {
		error: `${NODE_FAILURE}${state}: ${(report?.summary ?? ticket.ended?.reason ?? "").slice(0, 500)}`,
		agentId: ticket.id
	};
}
/** The Ticket accepted from `trigger`, which subscribes to the Trigger's Thread. */
function ticketOf(source, trigger, thread) {
	return (source.threads.get(thread)?.subscriptions ?? []).map((id) => source.tickets.get(id)).find((ticket) => ticket?.origin.triggerIds.includes(trigger));
}
/**
* Waits for the Tickets of nodes: one timer, every `pollMs` as it reads at each poll, reads each waiting node's Thread and its
* Ticket until it settles. Once stopped, what still waits never settles, so a run parked at stop writes nothing more and resumes
* from its journal.
*/
var TicketWaiter = class {
	source;
	pollMs;
	waiting = /* @__PURE__ */ new Map();
	timer;
	stopped = false;
	constructor(source, pollMs) {
		this.source = source;
		this.pollMs = pollMs;
	}
	settled(trigger, thread, structured) {
		const now = settle(ticketOf(this.source, trigger, thread), structured);
		if (now) return Promise.resolve(now);
		return new Promise((settled) => {
			if (this.stopped) return;
			this.waiting.set(trigger, {
				thread,
				structured,
				settled
			});
			this.arm();
		});
	}
	/** How many nodes wait. */
	get size() {
		return this.waiting.size;
	}
	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
		this.timer = void 0;
		this.waiting.clear();
	}
	arm() {
		if (this.timer || this.stopped || !this.waiting.size) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.poll();
		}, this.pollMs());
	}
	poll() {
		for (const [trigger, { thread, structured, settled }] of [...this.waiting]) {
			const outcome = settle(ticketOf(this.source, trigger, thread), structured);
			if (outcome) {
				this.waiting.delete(trigger);
				settled(outcome);
			}
		}
		this.arm();
	}
};
/**
* Runs each attempt of a call as a Trigger of the workflow Source. It never decides: the main Session accepts, holds or ignores
* the Trigger as any inferred candidate, and the Ticket it accepts runs on whatever Executor the deployment has. A resumed call
* raises the same Trigger, which the Engine answers `duplicate`, and waits for the Ticket it already has.
*/
var TicketBackend = class {
	host;
	name = "ticket";
	constructor(host) {
		this.host = host;
	}
	async run(call) {
		const { source, run, waiter, signal } = this.host;
		if (signal.aborted) return new Promise(() => {});
		const trigger = nodeTrigger(run, call);
		const node = nodeOf(call);
		const thread = threadKey({
			source: SOURCE,
			id: nodeThread(run.id, node)
		});
		if (await source.receive(trigger) === "filtered" || !source.threads.get(thread)) return { error: `${NODE_FAILURE}filtered: the workflow Source did not take the node in; it is off or uninstalled` };
		const label = call.opts.label === void 0 ? node : String(call.opts.label);
		source.threads.describe(thread, {
			label: `${run.name} · ${label}`,
			facts: { run: {
				label: {
					zh: "工作流运行",
					en: "Workflow run"
				},
				value: run.id
			} }
		});
		if (signal.aborted) return new Promise(() => {});
		return waiter.settled(trigger.id, thread, call.opts.schema !== void 0);
	}
};
//#endregion
//#region src/sources/workflow-store.ts
/** The workflow Source's records in the Store: its runs, their journals line by line, and the scripts they were started with. */
const lineKey = (seq) => String(seq).padStart(6, "0");
/** The keys of one run's journal, which share the run's prefix. */
const journalOf = (run) => family(KV.workflow.journal(run, ""));
/**
* The journal of one run in the Store: each line is its own `kv` record, written with the run's line count in one transaction,
* so a stopped process keeps every line it wrote and a resumed run reads them back in order. Once `signal` aborts, it writes
* nothing more.
*/
var KvJournal = class KvJournal {
	store;
	run;
	signal;
	constructor(store, run, signal) {
		this.store = store;
		this.run = run;
		this.signal = signal;
	}
	append(event) {
		if (this.signal?.aborted) return;
		this.store.atomic(() => {
			const run = this.store.state.get(KV.workflow.run(this.run));
			if (!run) throw new Error(`workflow: run ${this.run} has no record`);
			this.store.state.set(KV.workflow.journal(this.run, lineKey(run.seq)), event);
			this.store.state.set(KV.workflow.run(this.run), {
				...run,
				seq: run.seq + 1
			});
		});
	}
	/** The run's journal as the interpreter's text format: one JSON line per record, in the order they were written. */
	static text(store, run) {
		return store.state.keys(journalOf(run)).sort().map((name) => `${JSON.stringify(store.state.get(name))}\n`).join("");
	}
	static load(store, run) {
		return parseJournal(KvJournal.text(store, run));
	}
};
//#endregion
//#region src/sources/workflow-floor.ts
/** At most this many runs, the newest, answer a status request that names none. */
const STATUS_RUNS = 20;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const refused = (message) => /* @__PURE__ */ new Error(`orchestrator_workflow_start: ${message}`);
/**
* Resolves `workflow()` as the interpreter does, with the run's directory in place of the process's, and keeps each child it
* reads in the Store, so a resumed run reads the child its first start read whatever the file holds now.
*/
function pinnedResolver(store, run) {
	return (ref, fromPath) => {
		const pin = KV.workflow.nested(run.id, key(fromPath ?? "", ref).slice(0, 16));
		const pinned = store.state.get(pin);
		const text = pinned && store.state.get(KV.workflow.script(pinned.sha256));
		if (pinned && text !== void 0) return {
			source: text,
			path: pinned.path
		};
		const base = dirname(fromPath ?? run.scriptPath);
		const candidates = ref.endsWith(".js") ? [isAbsolute(ref) ? ref : resolve(base, ref)] : [join(base, `${ref}.js`), join(run.cwd, ".claude", "workflows", `${ref}.js`)];
		for (const path of candidates) {
			let source;
			try {
				source = readFileSync(path, "utf8");
			} catch {
				continue;
			}
			const digest = sha256(source);
			store.atomic(() => {
				store.state.set(KV.workflow.script(digest), source);
				store.state.set(pin, {
					path,
					sha256: digest
				});
			});
			return {
				source,
				path
			};
		}
		throw new Error(`workflow(): cannot resolve '${ref}' (looked in ${candidates.join(", ")})`);
	};
}
/** A node's Thread key and the Trigger id of its latest attempt, or undefined before its first. */
function latestAttempt(source, run, node, attempts) {
	for (let attempt = attempts; attempt >= 1; attempt--) {
		const trigger = nodeTriggerId(run, node, attempt);
		if (source.triggers.get(trigger)) return {
			trigger,
			thread: threadKey({
				source: SOURCE,
				id: nodeThread(run, node)
			})
		};
	}
}
function nodeState(thread, trigger, ticket) {
	if (ticket) return "ticket";
	return thread && (thread.pending.includes(trigger) || thread.evaluating?.triggerIds.includes(trigger)) ? "offered" : "held";
}
/**
* The workflow Source at work: it starts runs on request, drives each one with the interpreter, journals it in the Store, and
* after a restart resumes every run that had not ended, answering finished calls from the journal without raising them again.
*/
var WorkflowFloor = class {
	host;
	config;
	source;
	waiter;
	stopped = new AbortController();
	driving = /* @__PURE__ */ new Set();
	constructor(host, config) {
		this.host = host;
		this.config = config;
	}
	/** Waits for setup, then resumes every run that had not ended; it resolves once they are under way, not once they end. */
	async start() {
		const source = this.source = sourceContext(this.host, {
			kind: SOURCE,
			health: [SOURCE]
		});
		this.waiter = new TicketWaiter(source, () => this.config.pollMs.get());
		const stopped = new Promise((resolve) => {
			this.stopped.signal.addEventListener("abort", () => {
				resolve();
			}, { once: true });
		});
		await Promise.race([source.ready, stopped]);
		if (this.stopped.signal.aborted) return;
		if (!source.configured()) {
			source.report(SOURCE, health("paused", "setupPending"));
			return;
		}
		for (const run of this.runs()) if (run.state === "running") this.drive(run);
		this.reportHealth();
	}
	/** Parks every waiting call: nothing more is journaled, and the runs resume on the next start. */
	stop() {
		this.stopped.abort();
		this.waiter?.stop();
	}
	/** Starts a run of a script in a directory, once per `trigger_id`; the script's text is kept, and a resume reads that text. */
	startRun(request) {
		const source = this.ready();
		if (!isAbsolute(request.cwd)) throw refused(`cwd must be an absolute path: ${request.cwd}`);
		let directory = false;
		try {
			directory = statSync(request.cwd).isDirectory();
		} catch {}
		if (!directory) throw refused(`cwd is not a directory: ${request.cwd}`);
		const scriptPath = resolve(request.cwd, request.script);
		let text;
		try {
			text = readFileSync(scriptPath, "utf8");
		} catch (error) {
			throw refused(`cannot read the script ${scriptPath}: ${String(error)}`);
		}
		let name;
		try {
			name = extractMeta(text).meta.name;
		} catch (error) {
			throw refused(`the script's meta is invalid: ${String(error)}`);
		}
		const digest = sha256(text);
		const args = request.args;
		const pair = request.pair ?? (this.config.pair || void 0);
		const id = request.trigger_id ? `wf-${key("workflow-run", request.trigger_id, digest, request.cwd, JSON.stringify(args ?? null)).slice(0, 12)}` : `wf-${randomBytes(6).toString("hex")}`;
		const existing = source.state.get(KV.workflow.run(id));
		if (existing) return {
			run_id: id,
			state: "already-started",
			script_sha256: existing.scriptSha256,
			name: existing.name
		};
		const run = {
			id,
			name,
			scriptPath,
			scriptSha256: digest,
			cwd: request.cwd,
			...args !== void 0 && { args },
			...pair !== void 0 && { pair },
			...request.trigger_id !== void 0 && { requestedBy: request.trigger_id },
			state: "running",
			startedAt: (/* @__PURE__ */ new Date()).toISOString(),
			seq: 0
		};
		source.atomic(() => {
			source.state.set(KV.workflow.script(digest), text);
			source.state.set(KV.workflow.run(id), run);
		});
		this.drive(run);
		this.reportHealth();
		return {
			run_id: id,
			state: "started",
			script_sha256: digest,
			name
		};
	}
	/** The state of one run and of each of its nodes, or of the newest runs when `runId` names none. */
	status(runId) {
		const source = this.ready();
		if (runId !== void 0) {
			const run = source.state.get(KV.workflow.run(runId));
			if (!run) throw new Error(`orchestrator_workflow_status: no workflow run ${runId}`);
			return [this.runStatus(source, run)];
		}
		return this.runs().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, STATUS_RUNS).map((run) => this.runStatus(source, run));
	}
	/** How many runs this process drives now. */
	get active() {
		return this.driving.size;
	}
	ready() {
		if (!this.source || !this.source.configured() || this.stopped.signal.aborted) throw new Error("The workflow Source is not running");
		return this.source;
	}
	runs() {
		const source = this.source;
		return source.state.keys(KV.workflow.run).flatMap((name) => {
			const run = source.state.get(name);
			return run ? [run] : [];
		});
	}
	drive(run) {
		const source = this.source, signal = this.stopped.signal;
		const script = source.state.get(KV.workflow.script(run.scriptSha256));
		if (script === void 0) {
			this.finish(run.id, {
				status: "failed",
				result: null,
				error: `the script ${run.scriptSha256} it was started with is not kept`
			});
			return;
		}
		const backend = new TicketBackend({
			source,
			run,
			waiter: this.waiter,
			signal
		});
		const resumeFrom = run.seq > 0 ? KvJournal.load(source, run.id) : void 0;
		this.driving.add(run.id);
		runWorkflow(script, {
			backend,
			runId: run.id,
			scriptPath: run.scriptPath,
			...run.args !== void 0 && { args: run.args },
			journal: new KvJournal(source, run.id, signal),
			...resumeFrom && { resumeFrom },
			cacheIdentity: "content",
			resumeFailures: "replay",
			isRetryableFailure: retriedOnResume,
			concurrency: this.config.concurrency,
			maxAttempts: this.config.maxAttempts,
			resolveWorkflow: pinnedResolver(source, run)
		}).catch((error) => ({
			status: "failed",
			result: null,
			error: String(error)
		})).then((result) => {
			this.driving.delete(run.id);
			if (signal.aborted) return;
			this.finish(run.id, result);
			this.reportHealth();
		}).catch((error) => {
			source.report(SOURCE, {
				state: "error",
				detail: `run ${run.id} ended unrecorded: ${String(error)}`
			});
		});
	}
	finish(id, result) {
		const source = this.source;
		source.atomic(() => {
			const run = source.state.get(KV.workflow.run(id));
			if (!run) return;
			source.state.set(KV.workflow.run(id), {
				...run,
				state: result.status,
				result: result.result ?? null,
				...result.error !== void 0 && { error: result.error },
				endedAt: (/* @__PURE__ */ new Date()).toISOString()
			});
		});
	}
	runStatus(source, run) {
		const journal = KvJournal.load(source, run.id);
		const nodes = journal.startOrder.flatMap((started) => {
			const match = started.cid === void 0 ? void 0 : /^c1:([0-9a-f]{16})[0-9a-f]*#(\d+)$/.exec(started.cid);
			if (!match) return [];
			const node = `${match[1]}-o${match[2]}`;
			const head = {
				node,
				...started.label !== void 0 && { label: started.label },
				...started.phase !== void 0 && { phase: started.phase }
			};
			const latest = latestAttempt(source, run.id, node, this.config.maxAttempts);
			const ticket = latest && ticketOf(source, latest.trigger, latest.thread);
			const traced = {
				...head,
				...latest && { trigger_id: latest.trigger },
				...ticket && { ticket_id: ticket.id }
			};
			if (journal.results.has(started.key)) return [{
				...traced,
				state: "done"
			}];
			if (journal.lastFailed.has(started.key)) return [{
				...traced,
				state: "null"
			}];
			if (!latest) return [{
				...head,
				state: "waiting"
			}];
			return [{
				...traced,
				state: nodeState(source.threads.get(latest.thread), latest.trigger, ticket)
			}];
		});
		return {
			run_id: run.id,
			name: run.name,
			state: run.state,
			cwd: run.cwd,
			started_at: run.startedAt,
			...run.endedAt !== void 0 && { ended_at: run.endedAt },
			...run.error !== void 0 && { error: run.error },
			nodes
		};
	}
	reportHealth() {
		const running = this.driving.size, waiting = this.waiter?.size ?? 0;
		this.source?.report(SOURCE, {
			state: "ready",
			detail: `${running} runs under way, ${waiting} nodes waiting for their tickets`,
			at: (/* @__PURE__ */ new Date()).toISOString()
		});
	}
};
//#endregion
//#region src/sources/kind.ts
/** Types a kind's tool by its schema, as the host's own tools are typed. */
const sourceTool = (tool) => tool;
//#endregion
//#region src/sources/workflow-tools.ts
/** The main Session's workflow tools: `orchestrator_workflow_start` starts a run of a script, `orchestrator_workflow_status` reads runs. */
function workflowTools(floor) {
	return [sourceTool({
		name: "orchestrator_workflow_start",
		description: "Start a workflow script on an explicit request that names the script and the directory to run it in. Each agent() call of the script arrives as an inferred candidate from the workflow Source, which you assess like any other: accepting it runs that node as a ticket in the directory, and the run waits for each ticket it needs. A repeated trigger_id starts nothing new.",
		schema: z.object({
			script: z.string().min(1).describe("The workflow script: an absolute path, or one relative to cwd."),
			cwd: z.string().regex(/^\//, "An absolute path").describe("The absolute directory every node of the run works in."),
			args: z.unknown().optional().describe("The value the script reads as args."),
			pair: z.string().min(1).optional().describe("The compute pair every node runs on; without it, the Source's pair, else the Executor's default."),
			trigger_id: z.string().min(1).optional().describe("The trigger of the request this run answers; starting with the same trigger, script, cwd and args again returns the run it started.")
		}).strict(),
		execute: async (args) => floor.startRun(args)
	}), sourceTool({
		name: "orchestrator_workflow_status",
		description: "Read a workflow run and where each of its nodes is: waiting, offered, held, ticket, done or null; without run_id, the newest runs. A held node waits until its trigger is requeued.",
		schema: z.object({ run_id: z.string().min(1).optional() }).strict(),
		execute: async (args) => ({ runs: floor.status(args.run_id) })
	})];
}
//#endregion
//#region src/sources/workflow.ts
/**
* The Source's machine settings. `pollMs` applies without a restart, as the waiting nodes read it at each poll; changing another
* remounts the plugin, which resumes every run from its journal.
*/
const Config = s.object({
	pollMs: s.number().min(500).max(6e4).step(1).default(2e3).description("How often a node that waits reads its ticket, in milliseconds.").volatile(),
	concurrency: s.number().min(1).max(64).step(1).default(16).description("agent() calls of one run in flight at once; the Executor's worker limit still caps the tickets that run."),
	maxAttempts: s.number().min(1).max(3).step(1).default(1).description("Attempts at each agent() call, each one a new Trigger; with 1, a node whose ticket fails or whose reply does not match its schema returns null."),
	pair: s.string().default("").description("The compute pair of the nodes of a run that names none; empty leaves the choice to the Executor.")
});
/** The workflow kind: its nodes are senderless, so the Policy's admission row `workflow` decides whether they become candidates. */
const workflowKind = (floor) => ({
	kind: SOURCE,
	title: {
		zh: "工作流",
		en: "Workflows"
	},
	description: {
		zh: "运行工作流脚本；脚本的每个 agent() 调用成为一个候选，接受后成为一张工单。",
		en: "Runs workflow scripts; each agent() call of a script becomes a candidate, and a ticket once accepted."
	},
	schema: z.object({}).strict(),
	fields: [],
	health: [SOURCE],
	scope: () => ({
		listened: true,
		observed: true,
		row: SOURCE
	}),
	tools: workflowTools(floor)
});
const name = "dsh-superagent-workflow";
const inject = ["orchestrator"];
function apply(ctx, config) {
	ctx.effect(() => {
		const floor = new WorkflowFloor(ctx.orchestrator, config);
		const unregister = ctx.orchestrator.sources.register(workflowKind(floor));
		const running = floor.start().catch((error) => {
			ctx.orchestrator.context({
				kind: SOURCE,
				health: [SOURCE]
			}).report(SOURCE, {
				state: "error",
				detail: String(error)
			});
		});
		return async () => {
			unregister();
			floor.stop();
			await running;
		};
	}, "workflow: source kind and runs");
}
//#endregion
export { Config, SOURCE, apply, inject, name, workflowKind };
