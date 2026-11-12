/** The thin dshd client: argv for `dshd run`, `get`, `wait`, `read` and `stop`, and the JSON they print. */
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'

/** What one dshd headless unit runs: its name, directory, labels, profile, headless options, task and environment. */
export interface DshdRecipe { name: string; cwd: string; labels: Record<string, string>; profile: string; args: string[]; task: string; env: Record<string, string> }
/** The last run of a dshd instance; `ending` is null while it runs. */
export interface DshdLastRun { invocationId: string; ending: string | null; endedAt: number | null; child: { exitCode?: number; signal?: number } | null }
/** `dshd get --json`, and the body of every mutating verb's outcome, as far as the executor reads it. */
export interface DshdStatus { name: string; id: string | null; state: string; invocationId: string | null; labels: Record<string, string>; lastRun: DshdLastRun | null }
/** A refusal dshd printed on stderr as `{"error":{"kind","message","hint"}}`, with its exit code. */
export type DshdRefusal = { refused: string; exit: number; message: string }
export type DshdRunResult = ({ outcome: 'created' | 'started' | 'already-running' } & DshdStatus) | DshdRefusal
export type DshdWaitResult = { outcome: 'ended'; exitCode?: number; signal?: number | null; reason?: string } | { outcome: 'still-running' }
export interface DshdRead { invocationId: string; complete: boolean; lines: string[] }
/** The thin dshd client. Production: DshdCli over ctx.subprocess. Tests: FakeDshd. Exit 7 throws DshdUnavailable. */
export interface DshdPort {
  run(recipe: DshdRecipe, signal: AbortSignal): Promise<DshdRunResult>
  get(name: string, signal: AbortSignal): Promise<DshdStatus | 'not-found'>
  wait(name: string, timeoutSeconds: number, signal: AbortSignal): Promise<DshdWaitResult | 'not-found'>
  /** The newest `lines` journal lines of the unit's current or last run (`-n`), by default dshd's 200. */
  read(name: string, signal: AbortSignal, lines?: number): Promise<DshdRead | 'not-found'>
  stop(name: string, signal: AbortSignal): Promise<DshdStatus | 'not-found'>
}
/** dshd cannot reach systemd or its own parts (exit 7: systemd-unavailable, tool-missing, template-missing); a later try may succeed. */
export class DshdUnavailable extends Error {}

/** The invocation a status names: the current run's, or the last run's once the unit ended (dshd then reports `invocationId: null`). */
export const invocationOf = (status: Pick<DshdStatus, 'invocationId' | 'lastRun'>): string | undefined =>
  status.lastRun?.invocationId ?? status.invocationId ?? undefined

const Child = z.object({ exitCode: z.number().int().optional(), signal: z.number().int().optional() })
const LastRun = z.object({ invocationId: z.string(), ending: z.string().nullable(), endedAt: z.number().nullable().default(null), child: Child.nullable().default(null) })
const Status = z.object({ name: z.string(), id: z.string().nullable(), state: z.string(), invocationId: z.string().nullable(),
  labels: z.record(z.string(), z.string()).default({}), lastRun: LastRun.nullable().default(null) })
const RunOutcome = Status.extend({ outcome: z.enum(['created', 'started', 'already-running']) })
const WaitOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ended'), exitCode: z.number().int().optional(), signal: z.number().int().nullable().optional(), reason: z.string().optional() }),
  z.object({ outcome: z.literal('still-running') }),
])
const Read = z.object({ invocationId: z.string(), complete: z.boolean(), lines: z.array(z.string()) })
const Refusal = z.object({ error: z.object({ kind: z.string(), message: z.string().default('') }) })

/** One finished dshd call: its exit code (null when a signal or our abort ended it), stdout and stderr. */
interface Exit { exitCode: number | null; stdout: string; stderr: string }
/** Calls that may end before dshd answers, such as one cut by the host's stop; `wait` gets its own timeout on top. */
const CALL_TIMEOUT_MS = 60_000
/** `read --json` may carry a long stretch of a run's journal, so it may be large. */
const READ_MAX_BYTES = 1 << 24
const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''
function json(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined /* Not dshd's JSON; the caller says what it got instead. */ }
}

/**
 * The dshd CLI driven through DSH's subprocess service, as `runAsWorker` drives worker commands: `run` starts from an empty
 * environment (`env -i`) holding only the recipe's entries, which dshd captures for every later start of the unit.
 */
export class DshdCli implements DshdPort {
  constructor(private readonly subprocess: SubprocessRuntime, private readonly command: string) {}
  async run(recipe: DshdRecipe, signal: AbortSignal): Promise<DshdRunResult> {
    const env = Object.entries(recipe.env).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`)
    const labels = Object.entries(recipe.labels).sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, value]) => ['--label', `${name}=${value}`])
    const argv = ['env', '-i', ...env, this.command, 'run', '--bg', '--json', '--name', recipe.name, '--cwd', recipe.cwd, ...labels,
      '--', recipe.profile, ...recipe.args, '--json', recipe.task]
    const exit = await this.call(argv, recipe.cwd, signal)
    if (exit.exitCode !== 0) return this.refusal('run', recipe.name, exit)
    return this.parse('run', recipe.name, RunOutcome, exit)
  }
  async get(name: string, signal: AbortSignal): Promise<DshdStatus | 'not-found'> {
    const exit = await this.call([this.command, 'get', '--json', name], '/', signal)
    if (exit.exitCode !== 0) return this.missing('get', name, exit)
    return this.parse('get', name, Status, exit)
  }
  async wait(name: string, timeoutSeconds: number, signal: AbortSignal): Promise<DshdWaitResult | 'not-found'> {
    const argv = [this.command, 'wait', '--json', '--timeout', String(timeoutSeconds), name]
    const exit = await this.call(argv, '/', signal, timeoutSeconds * 1000 + CALL_TIMEOUT_MS)
    // In JSON mode dshd prints the outcome and exits 0; a check-in may still exit 124, as in text mode.
    if (exit.exitCode !== 0 && exit.exitCode !== 124) return this.missing('wait', name, exit)
    return this.parse('wait', name, WaitOutcome, exit)
  }
  async read(name: string, signal: AbortSignal, lines?: number): Promise<DshdRead | 'not-found'> {
    const argv = [this.command, 'read', '--json', ...lines === undefined ? [] : ['-n', String(lines)], name]
    const exit = await this.call(argv, '/', signal, CALL_TIMEOUT_MS, READ_MAX_BYTES)
    if (exit.exitCode !== 0) return this.missing('read', name, exit)
    return this.parse('read', name, Read, exit)
  }
  async stop(name: string, signal: AbortSignal): Promise<DshdStatus | 'not-found'> {
    const exit = await this.call([this.command, 'stop', '--json', name], '/', signal)
    if (exit.exitCode !== 0) return this.missing('stop', name, exit)
    return this.parse('stop', name, Status, exit)
  }
  private async call(argv: string[], cwd: string, signal: AbortSignal, timeoutMs = CALL_TIMEOUT_MS, maxBytes = 1 << 20): Promise<Exit> {
    const handle = this.subprocess.spawn({ argv, cwd, graceMs: 2000, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 1 << 16 } } })
    const { exitCode } = await handle.done
    const read = (reader: SubprocessOutputReader | undefined): string => reader?.readFrom(0).text ?? ''
    return { exitCode, stdout: read(handle.collected.stdout), stderr: read(handle.collected.stderr) }
  }
  /** dshd's refusal of `run`, or DshdUnavailable for exit 7; anything that is not dshd's error object throws. */
  private refusal(verb: string, name: string, exit: Exit): DshdRefusal {
    const error = Refusal.safeParse(json(lastLine(exit.stderr)))
    if (exit.exitCode === 7) throw new DshdUnavailable(`dshd ${verb} ${name}: ${error.success ? `${error.data.error.kind}: ${error.data.error.message}` : exit.stderr.trim()}`)
    if (exit.exitCode === null || !error.success) {
      throw new Error(`dshd ${verb} ${name} ${exit.exitCode === null ? 'was stopped before it finished' : `exited with ${exit.exitCode}`}: ${exit.stderr.trim().slice(0, 500)}`)
    }
    return { refused: error.data.error.kind, exit: exit.exitCode, message: error.data.error.message }
  }
  /** `not-found` (exit 3) for a verb that names an instance; any other refusal throws. */
  private missing(verb: string, name: string, exit: Exit): 'not-found' {
    const refusal = this.refusal(verb, name, exit)
    if (refusal.refused === 'not-found') return 'not-found'
    throw new Error(`dshd ${verb} ${name} refused: ${refusal.refused}: ${refusal.message}`)
  }
  private parse<T>(verb: string, name: string, schema: z.ZodType<T>, exit: Exit): T {
    const parsed = schema.safeParse(json(lastLine(exit.stdout)))
    if (!parsed.success) throw new Error(`dshd ${verb} ${name} printed what dsh-superagent does not read: ${exit.stdout.trim().slice(0, 500)}`)
    return parsed.data
  }
}
