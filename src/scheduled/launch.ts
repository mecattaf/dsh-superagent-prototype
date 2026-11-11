import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/** Verbatim report contract from DESIGN 7.5. */
export const REPORT_CONTRACT = `When you are done, write .agency/runs/<name>/report.json, then stop:
{"state": "done" | "blocked" | "failed",
 "summary": "<what you did, one paragraph>",
 "question": "<only when blocked: the exact action, target and scope
              you need Tom to authorise>"}
"blocked" means you stopped before an action you may not take alone.
Nobody can answer during this run.`

export interface RenderTaskInput {
  spec: {
    id?: string
    workflow?: string
    name?: string
    revision?: string
    rev?: string
    prompt?: string
    body?: string
    jobPrompt?: string
    schedule?: string
    deadline?: string
    missed?: number
    editedSince?: string
    [key: string]: unknown
  } | string
  occurrence: {
    id?: string
    key?: string
    instant?: string
    schedule?: string
    missed?: number
    deadline?: string
    [key: string]: unknown
  } | string
  attempt: number | string
  history?: unknown[] | string | null
  diff?: string | null
  interrupted?: boolean | string | null | { note?: string; [key: string]: unknown }
  check?: string | number | boolean | { exitCode?: number; stdout?: string; output?: string; [key: string]: unknown } | null
  editedSince?: string | null
  /** A person's answers to the question a held attempt asked, for the rerun they start (C7.10). */
  answers?: string[] | null
}

/**
 * The texts of the human Inputs a Ticket took after `since` (the held attempt's end): what the rerun's task.md carries
 * as the answer (DESIGN 7.6, C7.10). Context-only Inputs and the occurrences' own Triggers are not answers.
 */
export function answersSince(inputs: readonly { kind: string; human?: true; context?: true; at: string; triggerId?: string }[],
  textOf: (triggerId: string) => string | undefined, since: string | null | undefined): string[] {
  return inputs.filter(input => input.kind === 'trigger' && input.human && !input.context && input.triggerId && (!since || input.at > since))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(input => textOf(input.triggerId!)?.trim() ?? '').filter(text => text !== '')
}

/**
 * Renders the `task.md` text for an admitted occurrence attempt.
 * Contains the fact brief, the job prompt, and the verbatim report contract.
 */
export function renderTask(input: RenderTaskInput): string {
  const spec = typeof input.spec === 'string' ? { prompt: input.spec } : (input.spec ?? {})
  const occ = typeof input.occurrence === 'string' ? { key: input.occurrence } : (input.occurrence ?? {})

  const workflow = spec.id ?? spec.workflow ?? spec.name ?? ''
  const rev = spec.revision ?? spec.rev ?? ''
  const editedSince = input.editedSince ?? spec.editedSince
  const occurrence = occ.key ?? occ.id ?? occ.instant ?? (typeof input.occurrence === 'string' ? input.occurrence : '')
  const schedule = occ.schedule ?? spec.schedule ?? 'none'
  const missed = occ.missed ?? spec.missed ?? 0
  const attempt = String(input.attempt)
  const deadline = occ.deadline ?? spec.deadline ?? 'none'

  // Format check result
  let checkStr = 'none'
  if (input.check !== undefined && input.check !== null) {
    if (typeof input.check === 'object') {
      const exit = input.check.exitCode !== undefined ? `exit ${input.check.exitCode}` : ''
      const out = input.check.stdout ?? input.check.output ?? ''
      checkStr = [exit, out].filter(Boolean).join(': ') || JSON.stringify(input.check)
    } else {
      checkStr = String(input.check)
    }
  }

  const lines: string[] = []
  lines.push('# Fact Brief')
  if (workflow) lines.push(`- Workflow: ${workflow}`)
  if (rev) lines.push(`- Revision: ${rev}`)
  if (editedSince) lines.push(`- Edited since: ${editedSince}`)
  if (occurrence) lines.push(`- Occurrence: ${occurrence}`)
  lines.push(`- Schedule: ${schedule}`)
  lines.push(`- Missed count: ${missed}`)
  lines.push(`- Attempt: ${attempt}`)
  lines.push(`- Deadline: ${deadline}`)
  lines.push(`- Check result: ${checkStr}`)

  // Previous reports from scheduled history --json
  if (input.history) {
    lines.push('')
    lines.push('## Previous Reports')
    if (typeof input.history === 'string') {
      lines.push(input.history)
    } else if (Array.isArray(input.history)) {
      if (input.history.length === 0) {
        lines.push('None.')
      } else {
        for (const item of input.history) {
          lines.push(typeof item === 'string' ? item : JSON.stringify(item))
        }
      }
    }
  }

  // Diff from scheduled history --edits --diff
  if (input.diff) {
    lines.push('')
    lines.push('## Edits Diff')
    lines.push('```diff')
    lines.push(String(input.diff).trim())
    lines.push('```')
  }

  if (input.answers && input.answers.length > 0) {
    lines.push('')
    lines.push('## Answer to the held question')
    lines.push('The previous attempt stopped blocked; this is the answer it waited for:')
    for (const answer of input.answers) {
      lines.push('')
      lines.push(answer)
    }
  }

  // Interrupted line if any
  if (input.interrupted) {
    lines.push('')
    if (typeof input.interrupted === 'string') {
      lines.push(`Interrupted: ${input.interrupted}`)
    } else if (typeof input.interrupted === 'object' && input.interrupted.note) {
      lines.push(`Interrupted: ${input.interrupted.note}`)
    } else {
      lines.push('Interrupted: previous attempt was interrupted.')
    }
  }

  // Unattended line
  lines.push('')
  lines.push('Unattended run: nobody can answer during this run.')

  // Job prompt
  const jobPrompt = spec.prompt ?? spec.jobPrompt ?? spec.body ?? (typeof input.spec === 'string' ? input.spec : '')
  lines.push('')
  lines.push('# Job Prompt')
  lines.push('')
  lines.push(jobPrompt ? String(jobPrompt).trim() : '')

  // Report contract
  lines.push('')
  lines.push(REPORT_CONTRACT)
  lines.push('')

  return lines.join('\n')
}

/**
 * Writes `task.md` inside `dir` once (mode 0600, directory mode 0700).
 * Returns:
 * - `'written'` if newly created
 * - `'same'` if file already existed with identical content
 * - `'different'` if file already existed with different content
 */
export function writeTaskOnce(dir: string, text: string): 'written' | 'same' | 'different' {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Ignore permissions failure on unsupported filesystems
  }

  const filePath = join(dir, 'task.md')
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8')
    return existing === text ? 'same' : 'different'
  }

  writeFileSync(filePath, text, { encoding: 'utf-8', mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Ignore permissions failure on unsupported filesystems
  }
  return 'written'
}

/** Whitelisted base environment variables for launch step 4. */
export const ALLOWED_BASE_ENV_VARS = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LOCALE_ARCHIVE',
  'TZDIR',
  'PATH',
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  'NIX_PATH',
  'LOCAL_MODEL_ENDPOINT',
] as const

/** Checks whether an environment variable name is forbidden per C5.9. */
export function isForbiddenEnvVar(name: string): boolean {
  return (
    name.startsWith('DSH_') ||
    name.startsWith('CLAUDE_CODE_') ||
    name.includes('TOKEN') ||
    name === 'SSH_AUTH_SOCK'
  )
}

export interface RunEnvOptions {
  base?: Record<string, string | undefined>
  sched?: Record<string, string | undefined>
  seatConfigDir?: string | null
}

/**
 * Derives the clean `env -i` environment map for dshd launch per 7.5 Step 4 & C5.9.
 * Drops all variables not explicitly whitelisted, all forbidden names (`DSH_*`, `CLAUDE_CODE_*`, `*TOKEN*`, `SSH_AUTH_SOCK`),
 * and sets `CLAUDE_CONFIG_DIR` only when a seat directory is specified.
 */
export function runEnv(options: RunEnvOptions): Record<string, string> {
  const result: Record<string, string> = {}
  const base = options.base ?? {}
  const sched = options.sched ?? {}

  // 1. Copy whitelisted base environment variables
  for (const key of ALLOWED_BASE_ENV_VARS) {
    const val = base[key]
    if (val !== undefined && !isForbiddenEnvVar(key)) {
      result[key] = val
    }
  }

  // 3. Copy variables from the sched map
  // Only the SCHED_* names of `scheduled env`; the floor's own SCHED_* (if any) never leak in.
  for (const [key, val] of Object.entries(sched)) {
    if (key.startsWith('SCHED_') && val !== undefined && !isForbiddenEnvVar(key)) {
      result[key] = val
    }
  }

  // 4. CLAUDE_CONFIG_DIR only when Settings name a seat
  if (options.seatConfigDir && !isForbiddenEnvVar('CLAUDE_CONFIG_DIR')) {
    result['CLAUDE_CONFIG_DIR'] = options.seatConfigDir
  }

  return result
}

export interface RunArgvOptions {
  name: string
  root: string
  labels: Record<string, string> | [string, string][]
  mode?: string
  addDirs?: string[]
}

/**
 * Builds the deterministic command argv for `dshd run` per 7.5 Step 5 & C5.8.
 */
export function runArgv(options: RunArgvOptions): string[] {
  const { name, root, labels, mode = 'workspace-write', addDirs } = options

  const argv: string[] = [
    '/run/current-system/sw/bin/dshd',
    'run',
    '--bg',
    '--json',
    '--name',
    name,
    '--cwd',
    root,
  ]

  const labelOrder = [
    'scheduled.agency',
    'scheduled.workflow',
    'scheduled.occurrence',
    'scheduled.attempt',
    'scheduled.rev',
  ]

  let labelEntries: [string, string][] = []
  if (Array.isArray(labels)) {
    labelEntries = [...labels]
  } else if (labels && typeof labels === 'object') {
    for (const key of labelOrder) {
      if (key in labels) {
        labelEntries.push([key, labels[key]!])
      }
    }
    const otherKeys = Object.keys(labels).filter(k => !labelOrder.includes(k)).sort()
    for (const key of otherKeys) {
      labelEntries.push([key, labels[key]!])
    }
  }

  for (const [key, value] of labelEntries) {
    argv.push('--label', `${key}=${value}`)
  }

  argv.push(
    '--',
    'floor-worker',
    '--permission-mode',
    mode,
    '--approval-policy',
    'never',
  )

  if (addDirs && addDirs.length > 0) {
    for (const dir of addDirs) {
      argv.push('--add-dir', dir)
    }
  }

  argv.push(
    '--json',
    `Scheduled run ${name}. Read and follow ${root}/.agency/runs/${name}/task.md.`,
  )

  return argv
}

export type LaunchOutcome = 'watch' | 'harvest' | 'held' | 'failed' | 'retry'

export interface LaunchRunResult {
  outcome: LaunchOutcome
  detail: string
  code: number
  stdout: string
}

export type ExecFunction = (
  file: string,
  args: string[],
  options: { env: Record<string, string | undefined> },
) => Promise<{ code: number; stdout: string; stderr?: string }> | { code: number; stdout: string; stderr?: string }

const defaultExec: ExecFunction = (file, args, { env }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      // Killed by a signal (a timeout): never read as success.
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr })
    })
  })
}

export interface LaunchRunOptions {
  argv: string[]
  env: Record<string, string>
  exec?: ExecFunction
  throwOnRetry?: boolean
}

/**
 * Executes `dshd run` via an injectable `exec` and maps the outcome per C5.10.
 *
 * Mappings:
 * - `task-already-ran` (exit 4) -> harvest
 * - `exists-different-recipe`, `unit-masked` (exit 4), `invalid-name` (exit 2) -> held
 * - `start-failed` (exit 1) -> failed
 * - exit 7 (`systemd-unavailable`, `tool-missing`) -> retry (throws if `throwOnRetry` is set)
 * - `created`, `started`, `already-running` -> watch
 */
export async function launchRun(options: LaunchRunOptions): Promise<LaunchRunResult> {
  const { argv, env, exec = defaultExec, throwOnRetry = false } = options
  const file = argv[0] ?? '/run/current-system/sw/bin/dshd'
  const args = argv.slice(1)

  let res: { code?: number; stdout?: string; stderr?: string }
  try {
    res = await exec(file, args, { env })
  } catch (err: any) {
    if (err && typeof err.code === 'number') {
      res = {
        code: err.code,
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: typeof err.stderr === 'string' ? err.stderr : '',
      }
    } else {
      throw err
    }
  }

  const code = res.code ?? 0
  const stdout = res.stdout ?? ''

  let parsed: any = null
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    // Not JSON
  }
  // dshd prints a refusal on stderr, stdout empty (FACT: dshd 0.1.0, 12 Nov: exit 2 invalid-name).
  if (parsed === null && res.stderr) {
    try {
      const fromErr = JSON.parse(res.stderr.trim())
      if (fromErr && typeof fromErr === 'object' && fromErr.error) parsed = fromErr
    } catch {
      // Not JSON
    }
  }

  let answer = ''
  if (typeof parsed === 'string') {
    answer = parsed
  } else if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.kind === 'string') {
    // dshd prints a refusal as {"error": {"kind", "message", "hint"}} (FACT: dshd 0.1.0, 11 Nov).
    answer = parsed.error.kind
  } else if (parsed && typeof parsed === 'object') {
    answer =
      parsed.status ??
      parsed.outcome ??
      parsed.state ??
      parsed.result ??
      parsed.error ??
      parsed.action ??
      parsed.answer ??
      parsed.message ??
      ''
    if (!answer) {
      const known = [
        'created',
        'started',
        'already-running',
        'task-already-ran',
        'exists-different-recipe',
        'unit-masked',
        'invalid-name',
        'start-failed',
        'systemd-unavailable',
        'tool-missing',
      ]
      for (const val of Object.values(parsed)) {
        if (typeof val === 'string' && known.includes(val)) {
          answer = val
          break
        }
      }
    }
  } else {
    const trimmed = stdout.trim()
    const known = [
      'created',
      'started',
      'already-running',
      'task-already-ran',
      'exists-different-recipe',
      'unit-masked',
      'invalid-name',
      'start-failed',
      'systemd-unavailable',
      'tool-missing',
    ]
    for (const k of known) {
      if (trimmed.includes(k)) {
        answer = k
        break
      }
    }
  }

  let outcome: LaunchOutcome
  let detail = answer || `exit ${code}`

  if (code === 7 || answer === 'systemd-unavailable' || answer === 'tool-missing') {
    outcome = 'retry'
    detail = answer || 'systemd-unavailable'
    if (throwOnRetry) {
      const err = new Error(`dshd exited with code ${code} (${detail})`)
      Object.assign(err, { outcome: 'retry', detail, code, stdout })
      throw err
    }
  } else if (answer === 'task-already-ran' || (code === 4 && answer === 'task-already-ran')) {
    outcome = 'harvest'
    detail = 'task-already-ran'
  } else if (
    answer === 'exists-different-recipe' ||
    answer === 'unit-masked' ||
    answer === 'invalid-name' ||
    code === 2 ||
    (code === 4 && (answer === 'exists-different-recipe' || answer === 'unit-masked'))
  ) {
    outcome = 'held'
    detail = answer || (code === 2 ? 'invalid-name' : 'exists-different-recipe')
  } else if (answer === 'start-failed' || code === 1) {
    outcome = 'failed'
    detail = answer || 'start-failed'
  } else if (answer === 'created' || answer === 'started' || answer === 'already-running' || code === 0) {
    outcome = 'watch'
    detail = answer || 'created'
  } else {
    outcome = 'failed'
    detail = answer || `exit ${code}`
  }

  return { outcome, detail, code, stdout }
}
