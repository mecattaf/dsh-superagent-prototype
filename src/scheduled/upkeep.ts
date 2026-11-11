/**
 * `floor upkeep` (DESIGN 7.6 "Retention", C9.5, C9.6): prunes what the retention rules allow and reports, never fixes,
 * the anomalies. Every removal goes through `dshd rm --json`; the floor never resets a failed unit (C5.17).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../app/store.ts'
import { floorLog as defaultLog, type FloorEvent, type FloorField } from './log.ts'
import { FINAL } from './intake.ts'

export interface UpkeepDays { instancesDays: number; spoolDays: number; rowsDays: number }
export const UPKEEP_DAYS: UpkeepDays = { instancesDays: 14, spoolDays: 30, rowsDays: 400 }
export type Exec = (args: string[]) => Promise<{ code: number; stdout: string }>
export interface UpkeepOptions {
  store: Store
  stateDir: string
  /** dshd, run with the given arguments. */
  dshd: Exec
  dryRun: boolean
  now?: Date
  days?: Partial<UpkeepDays>
  /** Directory of the fork's canonical `deploy/` copies and `~/.dsh/profiles`, for the drift report. */
  deployDir?: string
  profilesDir?: string
  gcrootsDir?: string
  log?: (event: FloorEvent, fields?: Record<string, FloorField>) => void
}
export interface UpkeepReport {
  dryRun: boolean
  removed: { instances: string[]; runDirs: string[]; spoolFiles: number; rows: number }
  anomalies: {
    orphanInstances: string[]
    failedUnits: string[]
    pastDeadline: string[]
    rejectedSpool: string[]
    invalidWorkflows: string[]
    profileDrift: string[]
    gcRoots: number | null
  }
  summary: string
}

interface Instance { name: string; state?: string; labels?: Record<string, string>; lastRun?: { endedAt?: number | null } | null; remedy?: unknown }

const DAY = 86_400_000

export async function upkeep(options: UpkeepOptions): Promise<UpkeepReport> {
  const { store, stateDir, dryRun } = options
  const log = options.log ?? defaultLog
  const now = options.now ?? new Date()
  const days = { ...UPKEEP_DAYS, ...options.days }
  const report: UpkeepReport = { dryRun, removed: { instances: [], runDirs: [], spoolFiles: 0, rows: 0 },
    anomalies: { orphanInstances: [], failedUnits: [], pastDeadline: [], rejectedSpool: [], invalidWorkflows: [], profileDrift: [], gcRoots: null }, summary: '' }
  // Instances: the floor's own names only.
  const listed = await options.dshd(['ls', '--json'])
  let instances: Instance[] = []
  try {
    const parsed = JSON.parse(listed.stdout) as Instance[] | { instances?: Instance[] }
    instances = Array.isArray(parsed) ? parsed : parsed.instances ?? []
  } catch { log('error', { upkeep: 'dshd ls', code: listed.code }) }
  const attempts = store.db.prepare(`SELECT a.instance, a.ended_at, o.state, o.workflow_id, o.occurrence FROM sched_attempts a
    JOIN sched_occurrences o ON o.occurrence = a.occurrence`).all() as unknown as { instance: string; ended_at: string | null; state: string; workflow_id: string }[]
  const byName = new Map(attempts.map(row => [row.instance, row]))
  for (const instance of instances.filter(item => /^(sch|now)-/u.test(item.name))) {
    const row = byName.get(instance.name)
    if (instance.state === 'failed') report.anomalies.failedUnits.push(instance.name)
    if (!row) { report.anomalies.orphanInstances.push(instance.name); continue }
    const ended = row.ended_at ? Date.parse(row.ended_at) : NaN
    const held = row.state === 'held' || row.state === 'awaiting' || instance.remedy != null
    if (!FINAL.has(row.state) || held || !Number.isFinite(ended) || now.getTime() - ended < days.instancesDays * DAY) continue
    report.removed.instances.push(instance.name)
    if (dryRun) continue
    const removed = await options.dshd(['rm', '--json', instance.name])
    log('rm', { name: instance.name, code: removed.code })
    if (removed.code !== 0) { report.removed.instances.pop(); continue }
    const root = store.db.prepare('SELECT file FROM sched_workflows WHERE id=?').get(row.workflow_id) as { file?: string } | undefined
    const runDir = root?.file ? join(root.file.replace(/\/\.agency\/workflows\/(?:proposed\/)?[^/]+\.jsonc$/u, ''), '.agency', 'runs', instance.name) : undefined
    if (runDir && existsSync(runDir)) { rmSync(runDir, { recursive: true, force: true }); report.removed.runDirs.push(runDir) }
  }
  // Spool files.
  const spool = join(stateDir, 'spool')
  for (const sub of ['done', 'rejected']) {
    const directory = join(spool, sub)
    let names: string[] = []
    try { names = readdirSync(directory) } catch { continue }
    for (const name of names) {
      const path = join(directory, name)
      if (sub === 'rejected' && name.endsWith('.json')) report.anomalies.rejectedSpool.push(name)
      try {
        if (now.getTime() - statSync(path).mtimeMs < days.spoolDays * DAY) continue
        report.removed.spoolFiles++
        if (!dryRun) rmSync(path, { force: true })
      } catch { /* gone meanwhile */ }
    }
  }
  // Rows.
  const cutoff = new Date(now.getTime() - days.rowsDays * DAY).toISOString()
  const old = store.db.prepare(`SELECT occurrence FROM sched_occurrences WHERE updated_at < ? AND state IN (${[...FINAL].map(() => '?').join(',')})`)
    .all(cutoff, ...FINAL) as unknown as { occurrence: string }[]
  report.removed.rows = old.length
  if (!dryRun && old.length) store.atomic(() => {
    for (const { occurrence } of old) {
      store.db.prepare('DELETE FROM sched_attempts WHERE occurrence=?').run(occurrence)
      store.db.prepare('DELETE FROM sched_occurrences WHERE occurrence=?').run(occurrence)
    }
  })
  // Report only.
  report.anomalies.pastDeadline = (store.db.prepare(`SELECT occurrence FROM sched_occurrences WHERE deadline IS NOT NULL AND deadline < ?
    AND state IN ('queued','deferred','running','held','awaiting')`).all(now.toISOString()) as unknown as { occurrence: string }[]).map(row => row.occurrence)
  report.anomalies.invalidWorkflows = (store.db.prepare(`SELECT id FROM sched_workflows WHERE state='invalid'`).all() as unknown as { id: string }[]).map(row => row.id)
  if (options.deployDir && options.profilesDir) {
    for (const [file, profile] of [['floor.cordis.patch.yml', 'floor'], ['floor-worker.cordis.patch.yml', 'floor-worker']] as const) {
      const canonical = join(options.deployDir, file), live = join(options.profilesDir, profile, 'cordis.patch.yml')
      try { if (readFileSync(canonical, 'utf8') !== readFileSync(live, 'utf8')) report.anomalies.profileDrift.push(profile) }
      catch { report.anomalies.profileDrift.push(`${profile} (missing)`) }
    }
  }
  if (options.gcrootsDir) {
    try { report.anomalies.gcRoots = readdirSync(options.gcrootsDir).length } catch { report.anomalies.gcRoots = null }
  }
  const a = report.anomalies
  report.summary = `${dryRun ? 'Would remove' : 'Removed'} ${report.removed.instances.length} instance(s), ${report.removed.spoolFiles} spool file(s), `
    + `${report.removed.rows} occurrence row(s). Anomalies: ${a.orphanInstances.length} orphan, ${a.failedUnits.length} failed unit(s), `
    + `${a.pastDeadline.length} past deadline, ${a.rejectedSpool.length} rejected spool, ${a.invalidWorkflows.length} invalid workflow(s), `
    + `${a.profileDrift.length} profile drift.`
  log('upkeep', { dry_run: dryRun, instances: report.removed.instances.length, spool: report.removed.spoolFiles, rows: report.removed.rows })
  return report
}
