/** The admission gate of DESIGN 7.5, steps 1-6, in order, with injected I/O (claim C5.5). */
import { floorLog as defaultLog, type FloorEvent, type FloorField } from './log.ts'
import type { SchedOccurrence } from './store.ts'

export type AdmissionDecision = 'cancelled' | 'held' | 'missed' | 'satisfied' | 'wait-group' | 'deferred' | 'later' | 'launch'
export interface AdmissionResult { decision: AdmissionDecision; reason?: string }
export interface AdmissionCli {
  check(id: string, occ: string, attempt: number): Promise<{ holds: boolean; exit: number | null; output?: unknown }>
  gate(id: string, occ: string, attempt: number): Promise<{ deferred: string | null }>
}
export interface AdmissionInput {
  occurrence: SchedOccurrence
  /** The workflow's state in the last census (`sched_workflows.state`): valid | invalid | disabled | removed. */
  census: { state: string } | undefined
  now: Date
  cli: AdmissionCli
  runningGroups: ReadonlySet<string>
  freeSlots: number
  /** Whether the spec names `outcome.check`; without one step 3 is skipped. */
  hasCheck: boolean
  log?: (event: FloorEvent, fields?: Record<string, FloorField>) => void
}

export async function admit(input: AdmissionInput): Promise<AdmissionResult> {
  const { occurrence: occ, census, now, cli } = input
  const log = input.log ?? defaultLog
  const decide = (decision: AdmissionDecision, reason?: string, event: FloorEvent = 'defer'): AdmissionResult => {
    log(event, { occ: occ.occurrence, decision, ...reason ? { reason } : {} })
    return { decision, ...reason ? { reason } : {} }
  }
  const attempt = occ.attempt + 1
  // 1. Valid and enabled in the last census; a manual run only needs valid (run now works on a paused workflow).
  const state = census?.state ?? 'removed'
  if (state === 'removed') return decide('cancelled', 'removed', 'settle')
  if (state === 'invalid') return decide('held', 'invalid', 'held')
  if (state === 'disabled' && occ.kind !== 'manual') return decide('cancelled', 'disabled', 'settle')
  // 2. Deadline.
  if (occ.deadline && Date.parse(occ.deadline) <= now.getTime()) return decide('missed', 'window closed', 'settle')
  // 3. The outcome is already there (manual runs skip the intake-time check, DESIGN 7.2).
  if (input.hasCheck && occ.kind !== 'manual') {
    try {
      const checked = await cli.check(occ.workflow_id, occ.occurrence, attempt)
      if (checked.holds) return decide('satisfied', 'check holds', 'settle')
    } catch (error) {
      return decide('deferred', 'cli-error')
    }
  }
  // 4. Its concurrency group is free.
  if (input.runningGroups.has(occ.grp)) return decide('wait-group', `group ${occ.grp} running`)
  // 5. Gates.
  try {
    const gated = await cli.gate(occ.workflow_id, occ.occurrence, attempt)
    if (gated.deferred) return decide('deferred', gated.deferred)
  } catch {
    return decide('deferred', 'cli-error')
  }
  // 6. A worker slot.
  if (input.freeSlots <= 0) return decide('later', 'no free worker slot')
  return { decision: 'launch' }
}
