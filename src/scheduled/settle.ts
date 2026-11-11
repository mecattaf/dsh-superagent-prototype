/**
 * Settle: maps (verdict, report, check, attempts) → occurrence state and assignment report (DESIGN 7.6, b.9).
 *
 * Settle table:
 * | Run result                                                | Report   | Occurrence             |
 * |-----------------------------------------------------------|----------|------------------------|
 * | completed, check passes or no check                       | ready    | done                   |
 * | completed, check fails, attempts left, window open        | failed   | queued, next_try_at    |
 * | completed, check fails, no attempts left                  | failed   | awaiting               |
 * | report.json blocked                                       | dropped? | held                   |
 * | task failed, killed, never ran, timeout                   | failed   | failed / queued        |
 * | cut by reboot or power loss, first time                   | (none)   | queued; reruns+1       |
 * | cut a second time                                         | failed   | interrupted            |
 * | stopped by Tom                                            | dropped  | cancelled              |
 *
 * Notify only for: missed, unmet, failed, held, interrupted (§7.3).
 */
import { floorLog } from './log.ts'

export type Verdict =
  | 'running'
  | 'completed'
  | 'task-failed'
  | 'killed'
  | 'never-ran'
  | 'stopped'
  | 'cut-reboot'
  | 'cut-power'
  | 'timeout'
  | 'unknown'

export type OccurrenceState =
  | 'done'
  | 'queued'
  | 'awaiting'
  | 'held'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type AssignmentReport = 'ready' | 'failed' | 'dropped' | null

export interface SettleInput {
  verdict: Verdict
  report: { state: 'done' | 'blocked' | 'failed'; summary: string; question?: string } | null
  /** `holds: true` = check exit 0 (passed), false = non-zero (failed), null = no check ran. */
  check: { holds: boolean } | null
  attemptsLeft: boolean
  windowOpen: boolean
  reruns: number
  stoppedBy: 'tom' | 'floor' | null
  endedAt: number | string | Date
}

export interface SettleResult {
  occurrence: OccurrenceState
  reason: string
  nextTryAt?: Date
  rerun?: true
  assignment: AssignmentReport
  attention?: string
  notify: boolean
}

/** Notify condition per §7.3: only for missed, unmet, failed, held, interrupted. */
const NOTIFY_STATES = new Set<OccurrenceState>(['failed', 'held', 'interrupted'])

function notifyFor(state: OccurrenceState): boolean {
  return NOTIFY_STATES.has(state)
}

/** Adds 55 minutes to a timestamp. */
function plus55min(endedAt: number | string | Date): Date {
  const ms = endedAt instanceof Date ? endedAt.getTime()
    : typeof endedAt === 'number' ? endedAt * 1000
    : new Date(endedAt).getTime()
  return new Date(ms + 55 * 60 * 1000)
}

/**
 * Settles a completed or ended attempt into an occurrence state and assignment report.
 */
export function settle(input: SettleInput): SettleResult {
  const { verdict, report, check, attemptsLeft, windowOpen, reruns, stoppedBy, endedAt } = input

  // Stopped by Tom → dropped / cancelled
  if (verdict === 'stopped' && stoppedBy === 'tom') {
    return { occurrence: 'cancelled', reason: 'stopped-by-tom', assignment: 'dropped', notify: false }
  }

  // Stopped by the floor (or stopped without clear attribution)
  if (verdict === 'stopped') {
    return { occurrence: 'cancelled', reason: 'stopped-by-floor', assignment: 'dropped', notify: false }
  }

  // Cut by reboot or power loss
  if (verdict === 'cut-reboot' || verdict === 'cut-power') {
    if (reruns === 0) {
      // First cut → queued at once; reruns + 1; no attempt used
      return {
        occurrence: 'queued',
        reason: verdict === 'cut-reboot' ? 'cut-reboot' : 'cut-power',
        rerun: true,
        assignment: null,
        notify: false,
      }
    } else {
      // Second cut → interrupted; assignment failed
      return { occurrence: 'interrupted', reason: 'cut-twice', assignment: 'failed', notify: true }
    }
  }

  // report.json says blocked → held (opens Attention)
  if (report?.state === 'blocked') {
    const question = report.question ?? report.summary
    return {
      occurrence: 'held',
      reason: 'blocked',
      assignment: null,
      attention: question,
      notify: true,
    }
  }

  // task failed, killed, never ran, timeout → failed or queued while attempts remain
  if (
    verdict === 'task-failed' ||
    verdict === 'killed' ||
    verdict === 'never-ran' ||
    verdict === 'timeout'
  ) {
    if (attemptsLeft && windowOpen) {
      return {
        occurrence: 'queued',
        reason: verdict,
        nextTryAt: plus55min(endedAt),
        assignment: 'failed',
        notify: false,
      }
    }
    return { occurrence: 'failed', reason: verdict, assignment: 'failed', notify: true }
  }

  // Completed run
  if (verdict === 'completed') {
    // Check passes or no check → ready / done
    if (check === null || check.holds) {
      return { occurrence: 'done', reason: 'completed', assignment: 'ready', notify: false }
    }
    // Check fails
    if (attemptsLeft && windowOpen) {
      return {
        occurrence: 'queued',
        reason: 'check-failed',
        nextTryAt: plus55min(endedAt),
        assignment: 'failed',
        notify: false,
      }
    }
    // No attempts left → awaiting (re-checked per census)
    return { occurrence: 'awaiting', reason: 'check-failed', assignment: 'failed', notify: false }
  }

  // Fallback for unknown / running (should not normally be settled)
  floorLog('error', { msg: 'settle called with unexpected verdict', verdict })
  return { occurrence: 'failed', reason: `unexpected-verdict:${verdict}`, assignment: 'failed', notify: true }
}
