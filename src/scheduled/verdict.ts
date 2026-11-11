/** Verdict derivation from a parsed `dshd get --json` object (DESIGN 7.6, b.9). */

export type Verdict =
  | 'running'
  | 'completed'
  | 'task-failed'
  | 'killed'
  | 'never-ran'
  | 'stopped'
  | 'cut-reboot'
  | 'cut-power'
  | 'unknown'

export interface DshdGet {
  state: string
  enabled?: boolean
  lastRun?: {
    ending?: string | null
    child?: { exitCode?: number | null; signal?: string | null } | null
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

/**
 * Maps a parsed `dshd get --json` object to a verdict per DESIGN 7.6 / b.9.
 *
 * | state / lastRun.ending / child               | Verdict       |
 * |----------------------------------------------|---------------|
 * | running or starting                          | running       |
 * | stopped or previous-boot / exited / exit 0   | completed     |
 * | failed / failed / exit 1                     | task-failed   |
 * | failed / failed / signal                     | killed        |
 * | failed / failed / null                       | never-ran     |
 * | stopped / stopped                            | stopped       |
 * | previous-boot / stopped-without-intent       | cut-reboot    |
 * | interrupted / interrupted                    | cut-power     |
 * | (anything else)                              | unknown       |
 */
export function verdictOf(get: DshdGet): Verdict {
  const state = get.state
  const ending = get.lastRun?.ending ?? null
  const child = get.lastRun?.child ?? null

  // Still running
  if (state === 'running' || state === 'starting') return 'running'

  // Cut by power loss
  if (state === 'interrupted' && ending === 'interrupted') return 'cut-power'

  // Cut by clean reboot
  if (state === 'previous-boot' && ending === 'stopped-without-intent') return 'cut-reboot'

  // Stopped by Tom or the floor
  if (state === 'stopped' && ending === 'stopped') return 'stopped'

  // Completed: stopped or previous-boot, exited, exit 0
  if ((state === 'stopped' || state === 'previous-boot') && ending === 'exited') {
    const exitCode = child?.exitCode ?? null
    if (exitCode === 0) return 'completed'
    // Non-zero exit on "exited" ending — treat as task-failed
    return 'task-failed'
  }

  // Failed family: state=failed, ending=failed
  if (state === 'failed' && ending === 'failed') {
    if (child === null || child === undefined) return 'never-ran'
    const exitCode = child.exitCode ?? null
    const signal = child.signal ?? null
    if (signal !== null && signal !== undefined) return 'killed'
    if (exitCode !== null && exitCode !== undefined) return 'task-failed'
    // child present but neither signal nor exitCode: treat as never-ran
    return 'never-ran'
  }

  return 'unknown'
}
