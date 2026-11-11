/**
 * Resume: plan actions for open sched_attempts on floor start (DESIGN 7.6, b.9, C5.14).
 *
 * Resume table:
 * | Found                                                   | Action                                   |
 * |---------------------------------------------------------|------------------------------------------|
 * | Assignment running, watch row present                   | Nothing: effect resumes                  |
 * | Assignment running, no watch row                        | Enqueue watch                            |
 * | Instance not-found (exit 3) for running Assignment      | Relaunch once as -r<k>; second → failed  |
 * | Assignment pending                                       | start (admission)                        |
 *
 * This module only handles the watch/relaunch/settle decision for running assignments
 * whose instances were checked. Pending assignments go through admission (not here).
 */

/** A row from sched_attempts that has no ended_at (still open). */
export interface OpenAttemptRow {
  occurrence: string
  attempt: number
  rerun: number
  instance: string
  revision: string
  invocation: string | null
  started_at: string
  /** The occurrence state at time of planning. */
  occurrenceState: string
}

/** Parsed result of `dshd get --json` or the sentinel `'not-found'`. */
export type GetResult = Record<string, unknown> | 'not-found'

export type ResumeAction =
  | { kind: 'watch' }
  | { kind: 'relaunch'; rerun: number }
  | { kind: 'settle'; state: 'failed'; reason: string }

export interface ResumeDecision {
  row: OpenAttemptRow
  action: ResumeAction
}

/**
 * Plans one resume action per open sched_attempts row.
 *
 * @param rows       Open sched_attempts rows (no ended_at), running occurrences.
 * @param getInstance  Looks up `dshd get --json <name>` for each row; returns parsed object or `'not-found'`.
 */
export async function planResume(
  rows: OpenAttemptRow[],
  getInstance: (name: string) => Promise<GetResult>,
): Promise<ResumeDecision[]> {
  const results: ResumeDecision[] = []

  for (const row of rows) {
    const got = await getInstance(row.instance)

    if (got !== 'not-found') {
      // Instance is known — the watch effect will resume or be enqueued
      results.push({ row, action: { kind: 'watch' } })
    } else {
      // Instance not found (exit 3)
      if (row.rerun === 0) {
        // First not-found: relaunch as -r1
        results.push({ row, action: { kind: 'relaunch', rerun: 1 } })
      } else {
        // Second not-found (already a rerun): settle failed
        results.push({ row, action: { kind: 'settle', state: 'failed', reason: 'instance-lost' } })
      }
    }
  }

  return results
}
