/** Scheduled source kind and Cordis plugin entry: one Trigger per occurrence record a scheduler drops into an inbox directory. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { lstatSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { access, mkdir, open, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { z } from 'zod'
import { key, threadKey, type ThreadRef, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { LOCK_STALE_MS, lockReleased } from '../infra/lock.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export const SOURCE = 'scheduled'

const Slug = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/)
const Instant = z.iso.datetime({ offset: true })
/** Version 1 of a scheduled occurrence record; a producer drops one file per occurrence into the inbox. */
export const OccurrenceRecordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(['schedule', 'manual']),
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
  missed: z.number().int().min(0).max(100_000),
  revision: z.string().regex(/^[0-9a-f]{12}$/),
  /** The work, frozen when the record was written. */
  text: z.string().min(1).max(32_768),
  /** Names the compute pair the work runs on; absent means the Executor's default pair. */
  pair: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/).optional(),
  by: z.string().min(1).max(64),
  at: Instant,
}).strict().refine(record => (record.kind === 'manual') === (record.run !== undefined),
  { message: 'run is required for kind manual and absent for kind schedule', path: ['run'] })
export type OccurrenceRecord = z.infer<typeof OccurrenceRecordSchema>

/** Plugin configuration of the dsh-superagent-scheduled entry; changing any key remounts the plugin. */
export const Config = s.object({
  // Empty passes the pattern too: Schemastery checks the default against it.
  inbox: s.string().pattern(/^(\/|$)/).default('')
    .description('Directory scheduled occurrence records (*.json) are dropped into. Absolute path; empty for <stateDir>/inbox/scheduled. Read records move to .done/ beside them, invalid ones to .bad/.'),
  doneMaxAgeDays: s.number().min(0).step(1).default(0)
    .description('Days a read record stays in .done/, counted from its modification time; 0 keeps it however old. Only *.json files directly in .done/ are removed.'),
  doneMaxCount: s.number().min(0).step(1).default(0)
    .description('Most read records kept in .done/, the newest by modification time; 0 keeps every one.'),
})
export type ScheduledConfig = ReturnType<typeof Config>
/** The inbox of this plugin: its configured path, else `<stateDir>/inbox/scheduled` of the deployment. */
export const inboxOf = (config: ScheduledConfig, deployment: Pick<Deployment, 'stateDir'>): string =>
  config.inbox || join(deployment.stateDir, 'inbox', 'scheduled')

export const ScheduledSettingsSchema = z.object({ pollSeconds: z.number().int().min(2).max(600).default(10) }).strict()
export type ScheduledSettings = z.infer<typeof ScheduledSettingsSchema>

/** Trigger meta of a scheduled occurrence; read by `scope`, the environment, and an Executor (`cwd`, `pair`). */
export interface ScheduledMeta {
  /** The record's file name without `.json`. */
  occurrence: string
  namespace: string
  item: string
  cwd: string
  kind: 'schedule' | 'manual'
  due: string
  /** `missed` of the record plus, for the live record of a read, one plus `missed` of each record it superseded. */
  missed: number
  revision: string
  pair?: string
  /** Set on an older record of the same item read in the same round; the Source's scope filters it. */
  superseded?: true
}
/**
 * The Thread of one occurrence, named by its record file without `.json`. Every occurrence has its own: on a Thread a live
 * Ticket follows, a later occurrence would also become an Input of that Ticket. The label groups an item's occurrences.
 */
export const occurrenceThread = (occurrence: string): ThreadRef => ({ source: SOURCE, id: occurrence })

/** A record field on one line: a line break in a name, a path or `by` would otherwise move where the frozen text starts. */
const line = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, ' ')
/** `namespace:item — name`, the label of an item's occurrences. */
const title = (record: OccurrenceRecord): string => `${record.namespace}:${record.item} — ${line(record.name ?? record.item)}`
/** The two header lines a worker and the assessment read before the frozen text. */
function header(record: OccurrenceRecord, due: string, missed: number): string {
  const facts = `Working directory: ${line(record.cwd)}. Item file: ${record.file === undefined ? 'not given' : line(record.file)}. Revision ${record.revision}. Pair: ${record.pair ?? 'default'}.`
  if (record.kind === 'manual') return `[Scheduled item, run now] ${title(record)}\nRequested ${due} by ${line(record.by)}. ${facts}`
  const earlier = missed === 0 ? 'no earlier due occurrence was missed' : `${missed} earlier due occurrence(s) did not run`
  return `[Scheduled occurrence] ${title(record)}\nDue ${due}; ${earlier}. ${facts}`
}
/** What tells one occurrence of an item from another: the run id of a manual run, or the due instant of a schedule record. */
const instance = (record: OccurrenceRecord): string => record.kind === 'manual' ? `run:${record.run!}` : new Date(record.due).toISOString()
/** The id a release before the namespace was part of it gave an occurrence; Triggers stored under it keep it. */
const unscopedId = (record: OccurrenceRecord): string => key(SOURCE, record.cwd, record.item, instance(record))
/** Builds the Trigger of one record; equal records give equal Trigger ids, and two namespaces never share one. */
export function scheduledTrigger(record: OccurrenceRecord, occurrence: string, extra: { missed: number; superseded?: true }): Trigger {
  const due = new Date(record.due).toISOString()
  const meta: ScheduledMeta = { occurrence, namespace: record.namespace, item: record.item, cwd: record.cwd, kind: record.kind, due,
    missed: extra.missed, revision: record.revision, ...record.pair ? { pair: record.pair } : {}, ...extra.superseded ? { superseded: true as const } : {} }
  return {
    // The namespace is the producer's agency: two agencies may give one working directory items of one name.
    id: key(SOURCE, record.namespace, record.cwd, record.item, instance(record)),
    source: SOURCE,
    threads: [occurrenceThread(occurrence)],
    // An occurrence has no sender: an empty actor id uses the admission cell of an unlisted sender who does not address the agent.
    actor: { source: SOURCE, id: '' },
    human: false,
    at: record.due,
    text: `${header(record, due, extra.missed)}\n\n${record.text}`,
    meta: { ...meta },
  }
}

/** What one round read, for the Source's health. */
export interface InboxTally { read: number; superseded: number; invalid: number; unreadable: number; lastInvalid?: string }
interface Entry { name: string; file: string; record: OccurrenceRecord }
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
/** One line naming what makes a record invalid. */
const issues = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ')
/** Whether `path` is a directory; undefined when stat fails for a reason other than a missing path, which may pass. */
const directory = async (path: string): Promise<boolean | undefined> => {
  try { return (await stat(path)).isDirectory() } catch (error) {
    // Missing: not a directory the work can run in. EACCES, EIO or ESTALE may be transient, so the record waits.
    return code(error) === 'ENOENT' || code(error) === 'ENOTDIR' ? false : undefined
  }
}
/** Moves `file` into `dir` under its own name; a name already taken there gets a numeric suffix, so nothing is overwritten. */
async function moveInto(file: string, dir: string): Promise<string> {
  const name = basename(file), extension = extname(name), stem = name.slice(0, name.length - extension.length)
  for (let attempt = 0; ; attempt++) {
    const target = join(dir, attempt ? `${stem}.${attempt}${extension}` : name)
    // As existsSync: a name that cannot be reached counts as free.
    if (!await access(target).then(() => true, () => false)) { await rename(file, target); return target }
  }
}
/** Moves an invalid record into `.bad` with a one-line `.error` beside it; false when the producer withdrew the file first. */
async function quarantine(file: string, bad: string, reason: string): Promise<boolean> {
  let target: string
  try { target = await moveInto(file, bad) } catch (error) {
    if (code(error) === 'ENOENT') return false
    throw error
  }
  await writeFile(`${target}.error`, `${reason.replace(/\s*\n\s*/g, ' ')}\n`, { mode: 0o600 })
  return true
}
/** The valid record a file holds, or the reason it is not one; undefined when the file is gone or cannot be read. */
async function readRecord(file: string, tally: InboxTally): Promise<OccurrenceRecord | string | undefined> {
  let text: string, owner: number
  try {
    const handle = await open(file, 'r')
    try { owner = (await handle.stat()).uid; text = await handle.readFile('utf8') } finally { await handle.close() }
  } catch (error) {
    // Withdrawn by its producer between the listing and the read: nothing to do. Any other error leaves it for the next round.
    if (code(error) !== 'ENOENT') tally.unreadable += 1
    return undefined
  }
  // The work runs with this process's permissions, so only this user's records are read.
  const uid = process.getuid?.()
  if (uid !== undefined && owner !== uid) return `owned by uid ${owner}, not by this user`
  let value: unknown
  try { value = JSON.parse(text) } catch (error) { return `not JSON: ${error instanceof Error ? error.message : String(error)}` }
  const parsed = OccurrenceRecordSchema.safeParse(value)
  if (!parsed.success) return issues(parsed.error)
  const found = await directory(parsed.data.cwd)
  if (found === undefined) { tally.unreadable += 1; return undefined }
  return found ? parsed.data : `cwd is not a directory: ${parsed.data.cwd}`
}
/**
 * Reads every waiting record of `inbox` once, oldest name first, and moves each one it received out of the way. Older
 * schedule records of an item are received first as superseded, and the ones that did not run go into the item's latest
 * record's count. `read` counts the live and manual records received, `superseded` the older ones. A throw from `receive`
 * ends the round and leaves its record, and the ones after it, for the next. Every file call is a promise, so a round of many
 * records does not hold up the Sessions and the web app the process also serves.
 */
export async function readInbox(ctx: Pick<SourceContext, 'receive' | 'threads' | 'triggers'>, inbox: string, signal?: AbortSignal): Promise<InboxTally> {
  const done = join(inbox, '.done'), bad = join(inbox, '.bad')
  await mkdir(done, { recursive: true, mode: 0o700 })
  await mkdir(bad, { recursive: true, mode: 0o700 })
  const tally: InboxTally = { read: 0, superseded: 0, invalid: 0, unreadable: 0 }
  const entries: Entry[] = []
  for (const name of (await readdir(inbox)).filter(name => name.endsWith('.json') && !name.startsWith('.')).sort()) {
    const file = join(inbox, name)
    const record = await readRecord(file, tally)
    if (typeof record === 'string') {
      if (await quarantine(file, bad, record)) { tally.invalid += 1; tally.lastInvalid = name }
    } else if (record) entries.push({ name, file, record })
  }
  // Within one item, only the latest due runs; a record with that same due is the same occurrence and answers duplicate.
  const latest = new Map<string, number>()
  const itemOf = (record: OccurrenceRecord) => JSON.stringify([record.namespace, record.cwd, record.item])
  for (const { record } of entries) {
    if (record.kind === 'schedule') latest.set(itemOf(record), Math.max(latest.get(itemOf(record)) ?? -Infinity, Date.parse(record.due)))
  }
  const older = (record: OccurrenceRecord) => record.kind === 'schedule' && Date.parse(record.due) < latest.get(itemOf(record))!
  const superseded = entries.filter(entry => older(entry.record)), live = entries.filter(entry => !older(entry.record))
  // An occurrence a release before the namespace was in the id stored keeps its stored id, so its record answers duplicate.
  // The namespace in the stored meta tells it from another namespace's occurrence that had the same id.
  const kept = (trigger: Trigger, record: OccurrenceRecord): Trigger => {
    const stored = ctx.triggers.get(unscopedId(record))
    return stored?.source === SOURCE && stored.meta.namespace === record.namespace ? { ...trigger, id: stored.id } : trigger
  }
  /** Receives one record's Trigger, labels its Thread, then moves the file; the receive's answer, or undefined once aborted. */
  const take = async (entry: Entry, trigger: Trigger) => {
    if (signal?.aborted) return undefined
    // The file moves only after the Trigger is committed, so a crash between the two re-reads it and answers duplicate.
    const result = await ctx.receive(trigger)
    // The occurrence's own Thread is labelled with its item, which is how people find an item's occurrences together. A
    // duplicate is labelled too, in case a crash came before; a Thread that does not exist, as for a filtered one, is left alone.
    if (result !== 'filtered') {
      const { record } = entry
      const due = record.kind === 'manual' ? { zh: '请求时间', en: 'Requested' } : { zh: '到期', en: 'Due' }
      ctx.threads.describe(threadKey(trigger.threads[0]!), { label: title(record),
        facts: { due: { label: due, value: String(trigger.meta.due) }, revision: { label: { zh: '版本', en: 'Revision' }, value: record.revision } } })
    }
    try { await moveInto(entry.file, done) } catch (error) {
      if (code(error) !== 'ENOENT') throw error
      // Withdrawn by its producer after the read; the Trigger is stored all the same.
    }
    return result
  }
  // An older record counts as missed only when it is kept as superseded: one a crash left after it was stored as live ran.
  const missed = new Map<string, number>()
  for (const entry of superseded) {
    const trigger = kept(scheduledTrigger(entry.record, entry.name.slice(0, -5), { missed: entry.record.missed, superseded: true }), entry.record)
    if (await take(entry, trigger) === undefined) return tally
    tally.superseded += 1
    if (ctx.triggers.get(trigger.id)?.meta.superseded === true) missed.set(itemOf(entry.record), (missed.get(itemOf(entry.record)) ?? 0) + 1 + entry.record.missed)
  }
  for (const entry of live) {
    const trigger = kept(scheduledTrigger(entry.record, entry.name.slice(0, -5),
      { missed: entry.record.missed + (entry.record.kind === 'schedule' ? missed.get(itemOf(entry.record)) ?? 0 : 0) }), entry.record)
    if (await take(entry, trigger) === undefined) return tally
    tally.read += 1
  }
  return tally
}

const DAY_MS = 86_400_000
/**
 * Removes read records from `<inbox>/.done` beyond the configured retention, and returns how many it removed; with both bounds
 * 0 it lists nothing. Only regular `*.json` files directly in `.done` count, which is what a round moves there: `.bad`, the
 * waiting records, dot-files, other names, folders and links are never removed, and a link is never followed. A record's age
 * is its modification time, which its producer set when it wrote it; past `doneMaxCount`, the oldest go first.
 */
export function pruneDone(inbox: string, retention: Pick<ScheduledConfig, 'doneMaxAgeDays' | 'doneMaxCount'>, now = Date.now()): number {
  const { doneMaxAgeDays, doneMaxCount } = retention
  if (!doneMaxAgeDays && !doneMaxCount) return 0
  const done = join(inbox, '.done')
  const records: { file: string; name: string; modified: number }[] = []
  for (const entry of readdirSync(done, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
    const file = join(done, entry.name)
    let modified: number
    try { modified = lstatSync(file).mtimeMs } catch (error) {
      // Removed by someone else since the listing: nothing left to remove.
      if (code(error) === 'ENOENT') continue
      throw error
    }
    records.push({ file, name: entry.name, modified })
  }
  // Newest first; equal times by name, so the same directory always keeps the same records.
  records.sort((a, b) => b.modified - a.modified || (a.name < b.name ? 1 : -1))
  let removed = 0
  for (const [index, { file, modified }] of records.entries()) {
    const expired = doneMaxAgeDays > 0 && now - modified > doneMaxAgeDays * DAY_MS
    if (!expired && !(doneMaxCount > 0 && index >= doneMaxCount)) continue
    try { unlinkSync(file) } catch (error) {
      // Removed by someone else since the listing; it no longer counts.
      if (code(error) !== 'ENOENT') throw error
      continue
    }
    removed += 1
  }
  return removed
}

/** The ready health of the Source: what it read since it started, and what it could not read in its last round. */
function readyDetail(total: Omit<InboxTally, 'unreadable'>, unreadable: number): string {
  return `Read ${total.read}; superseded ${total.superseded}; invalid ${total.invalid}${total.lastInvalid ? `, last: ${total.lastInvalid}` : ''}`
    + (unreadable ? `; unreadable ${unreadable}` : '')
}
/**
 * Creates the inbox (0700) and takes its proper-lockfile lock, so one process reads it; throws while another holds it, and
 * for an inbox another user owns or that group or others can write, since a record in it runs with this process's permissions.
 */
function lockInbox(inbox: string, compromised: (error: Error) => void): () => void {
  mkdirSync(inbox, { recursive: true, mode: 0o700 })
  const info = statSync(inbox), uid = process.getuid?.()
  if ((uid !== undefined && info.uid !== uid) || info.mode & 0o022) {
    throw new Error(`The inbox ${inbox} must be owned by this user and not writable by group or others (mode ${(info.mode & 0o777).toString(8)}, uid ${info.uid})`)
  }
  return lockSync(inbox, { stale: LOCK_STALE_MS, onCompromised: compromised })
}
async function watch(ctx: SourceContext, config: ScheduledConfig, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the deployment; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report(SOURCE, health('paused', 'setupPending')); return }
  const inbox = inboxOf(config, ctx.deployment)
  // A process killed before its shutdown leaves the inbox lock until it goes stale, possibly later than the state directory's: wait for
  // that within the entry's `lockWaitMs`.
  await lockReleased(inbox, ctx.deployment.lockWaitMs, signal)
  if (signal.aborted) return
  // A lock that another process took over means two readers: report it and stop reading, as the Runtime does for its state directory.
  const lost = new AbortController()
  const release = lockInbox(inbox, error => { ctx.report(SOURCE, { state: 'error', detail: `The inbox lock was lost: ${error.message}` }); lost.abort() })
  const stop = AbortSignal.any([signal, lost.signal])
  const total: Omit<InboxTally, 'unreadable'> = { read: 0, superseded: 0, invalid: 0 }
  let failures = 0
  try {
    while (!stop.aborted) {
      const settings = ctx.config<ScheduledSettings>(SOURCE)
      if (!settings) ctx.report(SOURCE, health('paused', 'sourceOff'))
      else {
        const at = new Date().toISOString()
        try {
          const round = await readInbox(ctx, inbox, stop)
          // Retention runs after the round, and only while this process still holds the inbox.
          if (!stop.aborted) pruneDone(inbox, config)
          failures = 0
          total.read += round.read; total.superseded += round.superseded; total.invalid += round.invalid
          if (round.lastInvalid) total.lastInvalid = round.lastInvalid
          if (!stop.aborted) ctx.report(SOURCE, { state: 'ready', at, detail: readyDetail(total, round.unreadable) })
        } catch (error) {
          // A local directory that cannot be read needs a person at once; a record left by a failed receive is read again next round.
          failures += 1
          if (!stop.aborted) ctx.report(SOURCE, health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
      await pause((settings?.pollSeconds ?? 10) * 1000, stop)
    }
  } finally {
    try { release() } catch (error) {
      // A compromised lock is already released; nothing else is held.
      if (!lost.signal.aborted) throw error
    }
  }
}

const EMPTY = { DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: '', DSH_SUPERAGENT_SCHEDULED_ITEM: '', DSH_SUPERAGENT_SCHEDULED_DUE: '', DSH_SUPERAGENT_SCHEDULED_CWD: '' }
/** The scheduled Source kind of a plugin configuration; its inbox shows as a read-only fact. */
export function scheduledKind(config: ScheduledConfig): SourceKind<ScheduledSettings> {
  return {
    kind: SOURCE,
    title: { zh: '定时项', en: 'Scheduled items' },
    description: { zh: '读取收件目录里每个到期发生的记录，一次发生一个触发。', en: 'Reads one record per due occurrence from an inbox directory; one Trigger per occurrence.' },
    schema: ScheduledSettingsSchema,
    fields: [
      { key: 'inbox', type: 'fact', label: { zh: '收件目录', en: 'Inbox' } },
      { key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 600, label: { zh: '读取间隔 / 秒', en: 'Read interval / seconds' } },
    ],
    facts: deployment => ({ inbox: deployment ? inboxOf(config, deployment) : config.inbox }),
    health: [SOURCE],
    // An older record of an item read in the same round is kept as filtered; every other occurrence is observed in one row.
    scope: ({ meta }) => meta.superseded === true ? { listened: false, reason: 'superseded' } : { listened: true, observed: true, row: 'occurrence' },
    // An occurrence's name, as a scheduler that names records `<namespace>~<item>@<instant>` writes it, names its Thread.
    find: query => ({ threads: /^\S+~[a-z0-9-]+@\S+$/.test(query.trim()) ? [`${SOURCE}:${query.trim()}`] : [], terms: query.trim() ? [query.trim()] : [] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string() }).strict()).max(0).default([]) }).strict(),
      fields: [],
      explicit: { zh: '从不：发生没有发送者，也不会 @ 智能体。', en: 'Never: an occurrence has no sender and does not address the agent.' },
      // An occurrence has no sender, so only the cell of a sender off the list who does not address the agent applies.
      rows: () => [{ id: 'occurrence', label: { zh: '到期的定时项', en: 'Due scheduled items' }, note: { zh: '没有发送者', en: 'No sender' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true } }],
    },
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_SCHEDULED_OCCURRENCE', description: { zh: '开始工单的定时发生记录的文件名，不含 .json；工单不是从定时发生开始时为空', en: 'File name, without .json, of the occurrence record that started the ticket; empty when the ticket did not start from a scheduled occurrence' } },
        { key: 'DSH_SUPERAGENT_SCHEDULED_ITEM', description: { zh: '开始工单的定时项，写作 namespace:item；工单不是从定时发生开始时为空', en: 'The scheduled item that started the ticket, as namespace:item; empty when the ticket did not start from a scheduled occurrence' } },
        { key: 'DSH_SUPERAGENT_SCHEDULED_DUE', description: { zh: '这次发生的到期时间（ISO 8601，UTC）；手动运行时是请求的时间；工单不是从定时发生开始时为空', en: 'Due instant of the occurrence, ISO 8601 in UTC, or when a manual run was requested; empty when the ticket did not start from a scheduled occurrence' } },
        { key: 'DSH_SUPERAGENT_SCHEDULED_CWD', description: { zh: '这次发生为工作指定的工作目录；工单不是从定时发生开始时为空', en: 'The working directory the occurrence names for its work; empty when the ticket did not start from a scheduled occurrence' } },
      ],
      values: ({ trigger }) => {
        if (trigger?.source !== SOURCE) return { ...EMPTY }
        const meta = trigger.meta as Partial<ScheduledMeta>
        return { DSH_SUPERAGENT_SCHEDULED_OCCURRENCE: meta.occurrence ?? '', DSH_SUPERAGENT_SCHEDULED_ITEM: meta.namespace && meta.item ? `${meta.namespace}:${meta.item}` : '',
          DSH_SUPERAGENT_SCHEDULED_DUE: meta.due ?? '', DSH_SUPERAGENT_SCHEDULED_CWD: meta.cwd ?? '' }
      },
    },
  }
}

export const name = 'dsh-superagent-scheduled'
export const inject = ['orchestrator']
/** Refuses configuration keys the entry does not use, so a misspelt `inbox` fails the load instead of reading the default inbox. */
function checked(config: ScheduledConfig): ScheduledConfig {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent-scheduled configuration has keys it does not use: ${unknown.join(', ')}; docs/006-deployment.md lists the keys`)
  return config
}
export function apply(ctx: Context, config: ScheduledConfig): void {
  const kind = scheduledKind(checked(config))
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'scheduled: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, kind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the loop is reported as source health instead.
    const running = watch(source, config, controller.signal)
      .catch((error: unknown) => { source.report(SOURCE, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  }, 'scheduled: inbox watch')
}
