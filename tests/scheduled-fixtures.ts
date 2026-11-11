/** Shared fixtures for the PROVE-named floor specs (scheduled-{spool,intake,census,machine,policy,default-route,admission,watch}). */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ShownWorkflow } from '../src/scheduled/intake.ts'
import type { SchedOccurrence } from '../src/scheduled/store.ts'

export const quiet = (): void => {}
/** A log that records `[event, fields]` pairs. */
export function recorder() {
  const lines: [string, Record<string, unknown>][] = []
  return { lines, log: (event: string, fields: Record<string, unknown> = {}) => { lines.push([event, fields]) } }
}
export const shown = (patch: Partial<ShownWorkflow['spec']> = {}, top: Partial<ShownWorkflow> = {}): ShownWorkflow => ({
  id: 'master:nightly', revision: 'rev1', state: 'valid', kind: 'workflow', path: '',
  spec: { name: 'Nightly', enabled: true, window_ms: 39_600_000, concurrency: { group: 'master:nightly', queue: 'single' },
    outcome: { goal: 'ok', attempts: 2 }, job: { prompt: 'Do the nightly.', timeout_ms: 1_800_000 }, permissions: { mode: 'workspace-write', add_dirs: [] }, ...patch },
  ...top })
export function spoolFile(spool: string, name: string, record: unknown): string {
  const path = join(spool, 'incoming', name)
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record))
  return path
}
export const record = (dir: string, instant: string, patch: Record<string, unknown> = {}) => ({ v: 1, kind: 'schedule',
  occurrence: `master:nightly@${instant}`, workflow: 'master:nightly', agency: dir, file: join(dir, '.agency/workflows/nightly.jsonc'),
  instant, missed: 0, revision: 'rev1', at: instant, ...patch })
export const manual = (dir: string, ulid: string, patch: Record<string, unknown> = {}) => ({ v: 1, kind: 'manual',
  occurrence: `master:nightly@manual:${ulid}`, workflow: 'master:nightly', agency: dir, file: join(dir, '.agency/workflows/nightly.jsonc'),
  instant: '2026-11-12T00:00:00.000Z', missed: 0, revision: 'rev1', by: 'probe', inputs: {}, at: '2026-11-12T00:00:00.000Z', ...patch })
export const censusOf = (dir: string, workflows: { id?: string; state?: 'valid' | 'invalid'; enabled?: boolean; revision?: string }[], patch: Record<string, unknown> = {}) => ({
  v: 1, kind: 'census', at: '2026-11-12T00:00:05.000Z', machineId: 'm1',
  workflows: workflows.map(w => ({ id: w.id ?? 'master:nightly', file: join(dir, '.agency/workflows', `${(w.id ?? 'master:nightly').split(':')[1]}.jsonc`),
    state: w.state ?? 'valid', enabled: w.enabled ?? true, revision: w.revision ?? 'rev1', problems: [] })), ...patch })
export const occ = (patch: Partial<SchedOccurrence> = {}): SchedOccurrence => ({ occurrence: 'master:nightly@2026-11-12T00:00:00.000Z',
  workflow_id: 'master:nightly', kind: 'schedule', instant: '2026-11-12T00:00:00.000Z', missed: 0, deadline: '2026-11-12T11:00:00.000Z',
  grp: 'master:nightly', state: 'queued', reason: null, attempt: 0, reruns: 0, next_try_at: null, by: null, inputs: null, updated_at: '2026-11-12T00:00:10.000Z', ...patch })
