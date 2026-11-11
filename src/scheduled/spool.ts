/** The heartbeat-to-floor spool, version 1 (DESIGN 5.3): record schemas, ordering, and the done/rejected moves. */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const Base = z.object({ v: z.number() }).passthrough()

export const OccurrenceRecord = z.object({
  v: z.literal(1),
  kind: z.literal('schedule'),
  occurrence: z.string().min(1),
  workflow: z.string().regex(/^[^:]+:[a-z0-9][a-z0-9-]*$/),
  agency: z.string().min(1),
  file: z.string().min(1),
  instant: z.string().min(1),
  missed: z.number().int().min(0).default(0),
  revision: z.string().nullable().optional(),
  by: z.string().default('scheduled-heartbeat'),
  inputs: z.record(z.string(), z.unknown()).default({}),
  at: z.string().min(1),
}).passthrough()
export type OccurrenceRecord = z.infer<typeof OccurrenceRecord>

export const ManualRecord = OccurrenceRecord.extend({ kind: z.literal('manual') })
export type ManualRecord = z.infer<typeof ManualRecord>

export const CensusWorkflow = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  state: z.enum(['valid', 'invalid']),
  enabled: z.boolean(),
  revision: z.string().nullable(),
  problems: z.array(z.unknown()).default([]),
}).passthrough()
export type CensusWorkflow = z.infer<typeof CensusWorkflow>

export const CensusRecord = z.object({
  v: z.literal(1),
  kind: z.literal('census'),
  at: z.string().min(1),
  machineId: z.string(),
  workflows: z.array(CensusWorkflow),
}).passthrough()
export type CensusRecord = z.infer<typeof CensusRecord>

export type SpoolRecord = OccurrenceRecord | ManualRecord | CensusRecord

/** Parses one spool file; a higher major `v` and anything failing its kind's schema are errors naming why. */
export function parseRecord(text: string): { ok: true; record: SpoolRecord } | { ok: false; error: string } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch (error) { return { ok: false, error: `not JSON: ${String(error)}` } }
  const base = Base.safeParse(raw)
  if (!base.success) return { ok: false, error: 'missing numeric "v"' }
  if (Math.floor(base.data.v) !== 1) return { ok: false, error: `unsupported spool version v=${base.data.v}` }
  const kind = (raw as { kind?: unknown }).kind
  const schema = kind === 'census' ? CensusRecord : kind === 'manual' ? ManualRecord : kind === 'schedule' ? OccurrenceRecord : undefined
  if (!schema) return { ok: false, error: `unknown kind ${JSON.stringify(kind)}` }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') }
  return { ok: true, record: parsed.data as SpoolRecord }
}

/** Ensures the four spool directories exist with mode 0700. */
export function ensureSpool(spoolDir: string): void {
  for (const sub of ['tmp', 'incoming', 'done', 'rejected']) mkdirSync(join(spoolDir, sub), { recursive: true, mode: 0o700 })
}

/** Files waiting in `incoming/`: census files first, then name order; temporary and hidden names are skipped. */
export function listIncoming(spoolDir: string): string[] {
  let names: string[]
  try { names = readdirSync(join(spoolDir, 'incoming')) } catch { return [] }
  const files = names.filter(name => name.endsWith('.json') && !name.startsWith('.'))
  const census = files.filter(name => name.startsWith('census@')).sort()
  const rest = files.filter(name => !name.startsWith('census@')).sort()
  return [...census, ...rest]
}

export function moveDone(spoolDir: string, name: string): void {
  mkdirSync(join(spoolDir, 'done'), { recursive: true, mode: 0o700 })
  renameSync(join(spoolDir, 'incoming', name), join(spoolDir, 'done', name))
}

/** Moves a file to `rejected/` and writes `<name>.error` beside it (mode 0600). */
export function reject(spoolDir: string, name: string, error: string): void {
  mkdirSync(join(spoolDir, 'rejected'), { recursive: true, mode: 0o700 })
  renameSync(join(spoolDir, 'incoming', name), join(spoolDir, 'rejected', name))
  writeFileSync(join(spoolDir, 'rejected', `${name}.error`), `${error}\n`, { mode: 0o600 })
}
