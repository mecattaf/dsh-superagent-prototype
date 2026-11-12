import { R as ThreadRef, U as Trigger, lt as Deployment } from "./intake-CgErUeMw.js";
import { n as SourceContext, t as SourceKind } from "./kind-BZ6bj9bY.js";
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
/** Plugin configuration of the dsh-superagent-scheduled entry; changing `inbox` remounts the plugin. */
declare const Config: s<Schemastery.ObjectS<NoInfer<{
  inbox: s<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  inbox: s<string, string, "defined">;
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
/** Builds the Trigger of one record; equal records give equal Trigger ids. */
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
 * schedule records of an item are received first as superseded, and their count goes into the item's latest record.
 * `read` counts the live and manual records received, `superseded` the older ones. A throw from `receive` ends the round
 * and leaves its record, and the ones after it, for the next.
 */
declare function readInbox(ctx: Pick<SourceContext, 'receive' | 'threads'>, inbox: string, signal?: AbortSignal): Promise<InboxTally>;
/** The scheduled Source kind of a plugin configuration; its inbox shows as a read-only fact. */
declare function scheduledKind(config: ScheduledConfig): SourceKind<ScheduledSettings>;
declare const name = "dsh-superagent-scheduled";
declare const inject: string[];
declare function apply(ctx: Context, config: ScheduledConfig): void;
//#endregion
export { Config, InboxTally, OccurrenceRecord, OccurrenceRecordSchema, SOURCE, ScheduledConfig, ScheduledMeta, ScheduledSettings, ScheduledSettingsSchema, apply, inboxOf, inject, name, occurrenceThread, readInbox, scheduledKind, scheduledTrigger };