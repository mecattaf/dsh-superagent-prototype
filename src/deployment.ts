/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
// An unannotated `s.dict` makes the `Config` type unnameable for declaration emit (it needs cosmokit's `Dict`), so the two dshd maps
// are annotated with `Record` types. Schemastery declares their shape, for the settings page and `--dump-config`; `machineOf`
// still checks them with zod, which also refuses unknown pair keys and names the profile rule.
type PairInput = { profile?: string | null; env?: Record<string, string> | null; maxWorkers?: number | null }
type PairOutput = { profile: string; env: Record<string, string>; maxWorkers?: number }
const DshdPairs: s<Record<string, PairInput>, Record<string, PairOutput>> = s.dict(s.object({
  profile: s.string().required().description('DSH profile the worker boots: a headless profile under the DSH home.'),
  env: s.dict(s.string()).default({}).description('Environment added for this pair\'s units.'),
  maxWorkers: s.number().min(1).max(LIMITS.maxWorkers.max).step(1).description('At most this many units of this pair at once; unset: only the overall limit.'),
}))
const DshdEnv: s<Record<string, string>> = s.dict(s.string())
const DshdPairSchema = z.object({
  /** DSH profile the worker boots: a headless profile under the DSH home. */
  profile: z.string().regex(/^[A-Za-z0-9._-]+$/, 'a DSH profile name'),
  /** Environment added for this pair's units. */
  env: z.record(z.string(), z.string()).default({}),
  /** At most this many units of this pair at once; unset: only the overall limit. */
  maxWorkers: z.number().int().min(1).max(LIMITS.maxWorkers.max).optional(),
}).strict()
const DshdMapsSchema = z.object({ pairs: z.record(z.string(), DshdPairSchema), env: z.record(z.string(), z.string()) })
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir`, `engine`, `executor` or `dshd` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  engine: s.boolean().default(true)
    .description('Whether this process runs dsh-superagent. Off, the entry loads but takes no lock, opens no database, changes no process environment, registers no route or tool and starts no Session, so a process that loads the bundle only for its agent presets stays inert.'),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  executor: s.union(['dsh', 'dshd']).default('dsh')
    .description('How Assignments run: dsh, one DSH Session per Ticket in this process; dshd, one dshd headless unit per Assignment.'),
  dshd: s.object({
    command: s.string().default('dshd').description('The dshd CLI: a command name on PATH or an absolute path.'),
    prefix: s.string().pattern(/^[a-z][a-z0-9]{0,9}$/).default('sa').description('First part of every unit name.'),
    pairs: DshdPairs.default({}).description('Provider-harness pairs by name, each `{profile, env, maxWorkers}`: the headless profile its workers boot, the environment added for its units and its own limit.'),
    defaultPair: s.string().default('').description('The pair a Ticket runs on when its Trigger names none.'),
    cwd: s.string().default('').description('Directory of a Ticket whose Trigger names none. Absolute path; empty: a directory under the Execution directory.'),
    env: DshdEnv.default({}).description('Environment added for every unit, by name. Values are recorded in the unit recipe: no secrets.'),
    passEnv: s.array(s.string()).default(['HOME', 'USER', 'LOGNAME', 'LANG', 'LOCALE_ARCHIVE', 'TZDIR', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DSH_HOME'])
      .description('Names copied from this process\'s environment into every unit; LOCALE_ARCHIVE and TZDIR are where a NixOS host keeps locales and time zones.'),
    args: s.array(s.string()).default(['--approval-policy', 'never']).description('dsh headless options placed before --json and the task.'),
    watchSeconds: s.number().min(5).max(600).step(1).default(30).description('How long one dshd wait follows a unit before looking again.'),
    briefArgvMaxChars: s.number().min(1000).max(120000).step(1).default(64000)
      .description('Longest brief passed as the task argument, in bytes of UTF-8 (Linux takes at most 131072 in one argument); a longer one is written to a file under stateDir.'),
  }).default({}).description('The dshd executor; read only when executor is dshd.'),
})
export type DeploymentConfig = ReturnType<typeof Config>
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
}
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  engine: boolean
  executor: 'dsh' | 'dshd'
  dshd: DshdConfig
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, engine, executor, dshd } = config
  const wrong = (what: string): never => { throw new Error(`dsh-superagent dshd configuration: ${what}; docs/006-deployment.md lists the keys`) }
  const maps = DshdMapsSchema.safeParse({ pairs: dshd.pairs, env: dshd.env })
  if (!maps.success) wrong(maps.error.issues.map(issue => `${['dshd', ...issue.path].join('.')}: ${issue.message}`).join('; '))
  const machine: Machine = { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, engine, executor, dshd: { ...dshd, ...maps.data! } }
  if (executor === 'dshd') {
    if (!Object.hasOwn(dshd.pairs, dshd.defaultPair)) wrong(`the default pair ${JSON.stringify(dshd.defaultPair)} is not among the pairs (${Object.keys(dshd.pairs).join(', ') || 'none'})`)
    if (dshd.cwd && !isAbsolute(dshd.cwd)) wrong(`cwd ${dshd.cwd} is not an absolute path`)
    // A unit's environment travels as `dshd run` arguments, past the credential stripping of DSH's subprocess runtime, and dshd
    // records it, so a name copied from this process's environment may not be credential-shaped (DSH's SENSITIVE_ENV_PATTERN).
    const secret = dshd.passEnv.filter(name => /KEY|PASSWORD|SECRET|TOKEN/i.test(name))
    if (secret.length) wrong(`passEnv names credential-shaped variables, which dshd would record: ${secret.join(', ')}`)
  }
  return machine
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
