import { R as ThreadRef, U as Trigger, lt as Deployment } from "./intake-YOZzjx_b.js";
import { n as SourceContext, t as SourceKind } from "./kind-8FRB3xyy.js";
import { Context } from "@deepseek-ai/cordis";
import { z } from "zod";
import s from "@deepseek-ai/schemastery";
//#region src/sources/scheduled.d.ts
declare const SOURCE = "scheduled";
/** Version 1 of a scheduled occurrence record; a producer drops one file per occurrence into the inbox. */
declare const OccurrenceRecordSchema: z.ZodObject<{
  v: z.ZodLiteral<1>;
  kind: z.ZodEnum<{
    schedule: "schedule";
    manual: "manual";
  }>;
  namespace: z.ZodString;
  item: z.ZodString;
  name: z.ZodOptional<z.ZodString>;
  cwd: z.ZodString;
  file: z.ZodOptional<z.ZodString>;
  due: z.ZodISODateTime;
  run: z.ZodOptional<z.ZodString>;
  missed: z.ZodNumber;
  revision: z.ZodString;
  text: z.ZodString;
  pair: z.ZodOptional<z.ZodString>;
  by: z.ZodString;
  at: z.ZodISODateTime;
}, z.core.$strict>;
type OccurrenceRecord = z.infer<typeof OccurrenceRecordSchema>;
/** Plugin configuration of the dsh-superagent-scheduled entry; changing any key remounts the plugin. */
declare const Config: s<Schemastery.ObjectS<NoInfer<{
  inbox: s<string, string, "defined">;
  doneMaxAgeDays: s<number, number, "defined">;
  doneMaxCount: s<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  inbox: s<string, string, "defined">;
  doneMaxAgeDays: s<number, number, "defined">;
  doneMaxCount: s<number, number, "defined">;
}>>, "plain">;
type ScheduledConfig = ReturnType<typeof Config>;
/** The inbox of this plugin: its configured path, else `<stateDir>/inbox/scheduled` of the deployment. */
declare const inboxOf: (config: ScheduledConfig, deployment: Pick<Deployment, "stateDir">) => string;
declare const ScheduledSettingsSchema: z.ZodObject<{
  pollSeconds: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>;
type ScheduledSettings = z.infer<typeof ScheduledSettingsSchema>;
/** Trigger meta of a scheduled occurrence; read by `scope`, the environment, and an Executor (`cwd`, `pair`). */
interface ScheduledMeta {
  /** The record's file name without `.json`. */
  occurrence: string;
  namespace: string;
  item: string;
  cwd: string;
  kind: 'schedule' | 'manual';
  due: string;
  /** `missed` of the record plus, for the live record of a read, one plus `missed` of each record it superseded. */
  missed: number;
  revision: string;
  pair?: string;
  /** Set on an older record of the same item read in the same round; the Source's scope filters it. */
  superseded?: true;
}
/**
 * The Thread of one occurrence, named by its record file without `.json`. Every occurrence has its own: on a Thread a live
 * Ticket follows, a later occurrence would also become an Input of that Ticket. The label groups an item's occurrences.
 */
declare const occurrenceThread: (occurrence: string) => ThreadRef;
/** Builds the Trigger of one record; equal records give equal Trigger ids, and two namespaces never share one. */
declare function scheduledTrigger(record: OccurrenceRecord, occurrence: string, extra: {
  missed: number;
  superseded?: true;
}): Trigger;
/** What one round read, for the Source's health. */
interface InboxTally {
  read: number;
  superseded: number;
  invalid: number;
  unreadable: number;
  lastInvalid?: string;
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
declare function readInbox(ctx: Pick<SourceContext, 'receive' | 'threads' | 'triggers'>, inbox: string, signal?: AbortSignal): Promise<InboxTally>;
/**
 * Removes read records from `<inbox>/.done` beyond the configured retention, and returns how many it removed; with both bounds
 * 0 it lists nothing. Only regular `*.json` files directly in `.done` count, which is what a round moves there: `.bad`, the
 * waiting records, dot-files, other names, folders and links are never removed, and a link is never followed. A record's age
 * is its modification time, which its producer set when it wrote it; past `doneMaxCount`, the oldest go first.
 */
declare function pruneDone(inbox: string, retention: Pick<ScheduledConfig, 'doneMaxAgeDays' | 'doneMaxCount'>, now?: number): number;
/** The scheduled Source kind of a plugin configuration; its inbox shows as a read-only fact. */
declare function scheduledKind(config: ScheduledConfig): SourceKind<ScheduledSettings>;
declare const name = "dsh-superagent-scheduled";
declare const inject: string[];
declare function apply(ctx: Context, config: ScheduledConfig): void;
//#endregion
export { Config, InboxTally, OccurrenceRecord, OccurrenceRecordSchema, SOURCE, ScheduledConfig, ScheduledMeta, ScheduledSettings, ScheduledSettingsSchema, apply, inboxOf, inject, name, occurrenceThread, pruneDone, readInbox, scheduledKind, scheduledTrigger };