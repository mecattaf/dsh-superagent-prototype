/** The dshd executor's block of the dsh-superagent entry (`dshd`): its schema, its types, and the checks `machineOf` makes of it. */
import s from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { LIMITS } from '../limits.ts'

// An unannotated `s.dict` makes the `Config` type unnameable for declaration emit (it needs cosmokit's `Dict`), so the two dshd maps
// are annotated with `Record` types. Schemastery declares their shape, for the settings page and `--dump-config`; `dshdOf`
// still checks them with zod, which also refuses unknown pair keys and names the profile rule.
type PairInput = { profile?: string | null; env?: Record<string, string> | null; maxWorkers?: number | null }
type PairOutput = { profile: string; env: Record<string, string>; maxWorkers?: number }
const DshdPairs: s<Record<string, PairInput>, Record<string, PairOutput>> = s.dict(s.object({
  profile: s.string().required().description('DSH profile the worker boots: a headless profile under the DSH home.'),
  env: s.dict(s.string()).default({}).description('Environment added for this pair\'s units. Values are recorded in the unit recipe: no secrets.'),
  maxWorkers: s.number().min(1).max(LIMITS.maxWorkers.max).step(1).description('At most this many units of this pair at once; unset: only the overall limit.'),
}))
const DshdEnv: s<Record<string, string>> = s.dict(s.string())
const DshdPairSchema = z.object({
  /** DSH profile the worker boots: a headless profile under the DSH home. */
  profile: z.string().regex(/^[A-Za-z0-9._-]+$/, 'a DSH profile name'),
  /** Environment added for this pair's units. Values are recorded in the unit recipe: no secrets. */
  env: z.record(z.string(), z.string()).default({}),
  /** At most this many units of this pair at once; unset: only the overall limit. */
  maxWorkers: z.number().int().min(1).max(LIMITS.maxWorkers.max).optional(),
}).strict()
const DshdMapsSchema = z.object({ pairs: z.record(z.string(), DshdPairSchema), env: z.record(z.string(), z.string()) })
/** The `dshd` key of the entry's Config. */
export const DshdSchema = s.object({
  command: s.string().default('dshd').description('The dshd CLI: a command name on PATH or an absolute path.'),
  prefix: s.string().pattern(/^[a-z][a-z0-9]{0,9}$/).default('sa').description('First part of every unit name.'),
  pairs: DshdPairs.default({}).description('Provider-harness pairs by name, each `{profile, env, maxWorkers}`: the headless profile its workers boot, the environment added for its units and its own limit. Values of `env` are recorded in the unit recipe: no secrets.'),
  defaultPair: s.string().default('').description('The pair a Ticket runs on when its Trigger names none.'),
  cwd: s.string().default('').description('Directory of a Ticket whose Trigger names none. Absolute path; empty: a directory under the Execution directory.'),
  env: DshdEnv.default({}).description('Environment added for every unit, by name. Values are recorded in the unit recipe: no secrets.'),
  passEnv: s.array(s.string()).default(['HOME', 'USER', 'LOGNAME', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DSH_HOME'])
    .description('Names copied from this process\'s environment into every unit; LOCALE_ARCHIVE and TZDIR are where a NixOS host keeps locales and time zones. PATH entries under /nix/store are left out.'),
  args: s.array(s.string()).default(['--approval-policy', 'never']).description('dsh headless options placed before --json and the task.'),
  watchSeconds: s.number().min(5).max(600).step(1).default(30).description('How long one dshd wait follows a unit before looking again.'),
  briefArgvMaxChars: s.number().min(1000).max(120000).step(1).default(64000)
    .description('Longest brief passed as the task argument, in bytes of UTF-8 (Linux takes at most 131072 in one argument); a longer one is written to a file under stateDir.'),
  removeEnded: s.boolean().default(false)
    .description('Whether a unit is removed with dshd rm once its Ticket has ended and its binding records how it ended and its Session. DSH keeps the Session. Off: ended units stay until someone removes them.'),
  resumeDelaySeconds: s.number().min(0).max(86_400).step(1).default(300)
    .description('How long after a start the work that waited from before it waits to launch, in seconds, so a person can look at it first; work created after the start launches at once. 0: it launches at once.'),
  resumeMaxAgeHours: s.number().min(0).max(8760).step(1).default(24)
    .description('Work that waited from before a start and is older than this many hours is not launched: it is recorded failed, and its Ticket waits for a person to retry it. 0: no age limit.'),
  uncertainWatchLimit: s.number().min(0).max(1000).step(1).default(10)
    .description('How many looks in a row may find a unit masked, inconsistent or in a state dshd cannot tell before its Assignment settles as lost; an orphaned unit settles at once. 0: wait until dshd can tell.'),
}).default({}).description('The dshd executor; read only when executor is dshd.')
/** One provider-harness pair of the dshd executor: the headless profile its units boot, their added environment and their own limit. */
export interface DshdPair { profile: string; env: Record<string, string>; maxWorkers?: number }
/** Configuration of the dshd executor (`executor: dshd`). */
export interface DshdConfig {
  command: string
  prefix: string
  pairs: Record<string, DshdPair>
  defaultPair: string
  cwd: string
  env: Record<string, string>
  passEnv: string[]
  args: string[]
  watchSeconds: number
  briefArgvMaxChars: number
  removeEnded: boolean
  resumeDelaySeconds: number
  resumeMaxAgeHours: number
  uncertainWatchLimit: number
}

/** Reads the block: its maps always, and under `executor: dshd` its default pair, its directory and the names it passes on. */
export function dshdOf(executor: 'dsh' | 'dshd', dshd: ReturnType<typeof DshdSchema>): DshdConfig {
  const wrong = (what: string): never => { throw new Error(`dsh-superagent dshd configuration: ${what}; docs/006-deployment.md lists the keys`) }
  const maps = DshdMapsSchema.safeParse({ pairs: dshd.pairs, env: dshd.env })
  if (!maps.success) wrong(maps.error.issues.map(issue => `${['dshd', ...issue.path].join('.')}: ${issue.message}`).join('; '))
  if (executor === 'dshd') {
    if (!Object.hasOwn(dshd.pairs, dshd.defaultPair)) wrong(`the default pair ${JSON.stringify(dshd.defaultPair)} is not among the pairs (${Object.keys(dshd.pairs).join(', ') || 'none'})`)
    if (dshd.cwd && !isAbsolute(dshd.cwd)) wrong(`cwd ${dshd.cwd} is not an absolute path`)
    // A unit's environment travels as `dshd run` arguments, past the credential stripping of DSH's subprocess runtime, and dshd
    // records it, so a name copied from this process's environment may not be credential-shaped (DSH's SENSITIVE_ENV_PATTERN).
    const secret = dshd.passEnv.filter(name => /KEY|PASSWORD|SECRET|TOKEN/i.test(name))
    if (secret.length) wrong(`passEnv names credential-shaped variables, which dshd would record: ${secret.join(', ')}`)
  }
  return { ...dshd, ...maps.data! }
}
