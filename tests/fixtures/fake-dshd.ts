/**
 * An in-memory dshd for the dshd executor's tests: instances by name under dshd's same-name and same-recipe rules, which run a
 * headless task once, and the CLI they answer through DSH's subprocess service as `DshdCli` calls it (`spawn`).
 */
import { DshdUnavailable, type DshdLastRun, type DshdPort, type DshdRead, type DshdRecipe, type DshdRunResult, type DshdStatus,
  type DshdWaitResult } from '../../src/executor/dshd-cli.ts'

interface Instance { recipe: DshdRecipe; id: string; state: string; invocationId: string | null; lastRun: DshdLastRun; lines: string[] }
type Verb = 'run' | 'get' | 'wait' | 'read' | 'stop'
/** The lines a headless `--json` run prints: its Session, then its answer, around dshd-run's own lines (as `READ_JSON_RUN` in dshd-0.1.0.ts). */
export const runLines = (sessionId: string, final?: string): string[] => ['dshd-run: run started', JSON.stringify({ type: 'session', sessionId, cwd: '/' }),
  JSON.stringify({ type: 'text', text: 'Working.' }),
  ...final === undefined ? [] : [JSON.stringify({ type: 'final', sessionId, reason: { kind: 'completed' }, text: final })], 'dshd-run: run ended']

/** In-memory `DshdPort` with helpers that end, cut, rerun or remove an instance, and fail the next call of a verb. */
export class FakeDshd implements DshdPort {
  readonly instances = new Map<string, Instance>()
  /** Every recipe `run` was asked for, in order. */
  readonly runs: DshdRecipe[] = []
  /** Every name `stop` stopped. */
  readonly stops: string[] = []
  /** While set, the CLI's answer to `run` waits for it (or for the caller's abort), after the instance was created. */
  hold?: Promise<void>
  private invocations = 0
  private readonly failures: { verb: Verb; exit: number; kind: string }[] = []
  async run(recipe: DshdRecipe): Promise<DshdRunResult> {
    this.runs.push(recipe)
    this.fail('run')
    const existing = this.instances.get(recipe.name)
    if (existing) {
      const same = (a: DshdRecipe) => JSON.stringify([a.cwd, a.profile, a.args, a.task])
      if (same(existing.recipe) !== same(recipe)) return { refused: 'exists-different-recipe', exit: 4, message: `${recipe.name} exists with another recipe` }
      existing.recipe = { ...existing.recipe, labels: { ...existing.recipe.labels, ...recipe.labels } }
      if (existing.state === 'running') return { outcome: 'already-running', ...this.status(existing) }
      return { refused: 'task-already-ran', exit: 4, message: `${recipe.name} already ran its task` }
    }
    const instance: Instance = { recipe, id: `instance-${this.instances.size + 1}`, state: 'running', invocationId: null, lines: [],
      lastRun: { invocationId: '', ending: null, endedAt: null, child: null } }
    this.instances.set(recipe.name, instance)
    this.begin(instance)
    return { outcome: 'created', ...this.status(instance) }
  }
  async get(name: string): Promise<DshdStatus | 'not-found'> {
    this.fail('get')
    const instance = this.instances.get(name)
    return instance ? this.status(instance) : 'not-found'
  }
  async wait(name: string): Promise<DshdWaitResult | 'not-found'> {
    this.fail('wait')
    const instance = this.instances.get(name)
    if (!instance) return 'not-found'
    if (instance.state === 'running') return { outcome: 'still-running' }
    const child = instance.lastRun.child ?? {}
    return { outcome: 'ended', ...child.exitCode !== undefined ? { exitCode: child.exitCode } : {}, signal: child.signal ?? null }
  }
  async read(name: string): Promise<DshdRead | 'not-found'> {
    this.fail('read')
    const instance = this.instances.get(name)
    return instance ? { invocationId: instance.lastRun.invocationId, complete: true, lines: instance.lines } : 'not-found'
  }
  async stop(name: string): Promise<DshdStatus | 'not-found'> {
    this.fail('stop')
    const instance = this.instances.get(name)
    if (!instance) return 'not-found'
    if (instance.state === 'running') { this.stops.push(name); this.end(name, { ending: 'stopped', signal: 15 }) }
    return this.status(instance)
  }
  /** The instance's run ends: exit 0 by default, with a Session and an answer in what it printed. */
  end(name: string, how: { exitCode?: number; signal?: number; ending?: string; lines?: string[] } = {}): void {
    const instance = this.instances.get(name)!
    const { exitCode = 0, signal } = how
    const ending = how.ending ?? (signal !== undefined || exitCode !== 0 ? 'failed' : 'exited')
    const child = ending === 'stopped' || ending === 'interrupted' || ending === 'stopped-without-intent' ? null
      : signal !== undefined ? { signal } : { exitCode }
    instance.lines = how.lines ?? runLines(`session-${name}`, 'Done.')
    instance.state = ending === 'exited' || ending === 'stopped' ? 'stopped' : ending === 'interrupted' ? 'interrupted' : 'failed'
    // As dshd does once a headless run ended, the top-level invocation is gone and only the last run names it; a failed unit keeps it
    // (`WAIT_ENDED_FAILED` in dshd-0.1.0.ts).
    if (instance.state !== 'failed') instance.invocationId = null
    instance.lastRun = { ...instance.lastRun, ending, endedAt: 1, child }
  }
  /** A reboot cut the run off. */
  cut(name: string): void { this.end(name, { ending: 'interrupted', lines: [] }) }
  /** Someone ran `dshd start --rerun`: a new invocation of the same instance runs. */
  rerun(name: string): void { this.begin(this.instances.get(name)!) }
  /** dshd no longer knows the instance, as after `dshd rm`. */
  remove(name: string): void { this.instances.delete(name) }
  /** The next call of `verb` fails with dshd's error `kind` and exit code `exit`. */
  failNext(verb: Verb, exit: number, kind: string): void { this.failures.push({ verb, exit, kind }) }
  /** DSH's subprocess service as `DshdCli` uses it: answers the dshd argv, or returns undefined for any other command. */
  spawn(spec: { argv: readonly string[]; signal?: AbortSignal }) {
    const argv = [...spec.argv]
    const env: Record<string, string> = {}
    if (argv[0] === 'env') {
      argv.shift()
      if (argv[0] === ('-i' as string)) argv.shift()
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) { const entry = argv.shift()!; env[entry.slice(0, entry.indexOf('='))] = entry.slice(entry.indexOf('=') + 1) }
    }
    if (argv[0] !== 'dshd') return undefined
    const verb = argv[1] as Verb, name = argv.at(-1)!
    let stdout = '', stderr = ''
    const reader = (text: () => string) => ({ readFrom: () => ({ text: text(), nextOffset: text().length, lossy: false }) })
    const answer = async (): Promise<number | null> => {
      try {
        if (verb === 'run') {
          const flags = argv.slice(2, argv.indexOf('--'))
          const after = argv.slice(argv.indexOf('--') + 1)
          const value = (flag: string) => flags[flags.indexOf(flag) + 1]!
          const labels = Object.fromEntries(flags.flatMap((flag, at) => flag === '--label' ? [flags[at + 1]!.split(/=(.*)/s).slice(0, 2)] : []))
          const result = await this.run({ name: value('--name'), cwd: value('--cwd'), labels, profile: after[0]!, args: after.slice(1, -2), task: after.at(-1)!, env })
          if (this.hold) await Promise.race([this.hold, new Promise(resolve => { spec.signal?.addEventListener('abort', resolve, { once: true }) })])
          if (spec.signal?.aborted) return null
          if ('refused' in result) { stderr = JSON.stringify({ error: { kind: result.refused, message: result.message, hint: null } }); return result.exit }
          stdout = JSON.stringify({ ...result, warnings: [] })
          return 0
        }
        // dshd's stop answers stopped, or already-stopped for a unit that was not running.
        const running = this.instances.get(name)?.state === 'running'
        const result = verb === 'get' ? await this.get(name) : verb === 'wait' ? await this.wait(name) : verb === 'read' ? await this.read(name) : await this.stop(name)
        if (result === 'not-found') { stderr = JSON.stringify({ error: { kind: 'not-found', message: `no instance ${name}`, hint: null } }); return 3 }
        stdout = JSON.stringify(verb === 'read' ? { name, streams: ['stdout', 'stderr'], ...result }
          : verb === 'stop' ? { outcome: running ? 'stopped' : 'already-stopped', ...result } : result)
        return 0
      } catch (error) {
        const kind = error instanceof DshdUnavailable ? 'systemd-unavailable' : (error as { kind?: string }).kind ?? 'io'
        stderr = JSON.stringify({ error: { kind, message: String(error), hint: null } })
        return error instanceof DshdUnavailable ? 7 : (error as { exit?: number }).exit ?? 1
      }
    }
    return { done: answer().then(exitCode => ({ exitCode, signal: null })), collected: { stdout: reader(() => stdout), stderr: reader(() => stderr) } }
  }
  private begin(instance: Instance): void {
    const invocationId = `invocation-${++this.invocations}`
    Object.assign(instance, { state: 'running', invocationId, lines: [], lastRun: { invocationId, ending: null, endedAt: null, child: null } })
  }
  private status(instance: Instance): DshdStatus {
    return structuredClone({ name: instance.recipe.name, id: instance.id, state: instance.state, invocationId: instance.invocationId,
      labels: instance.recipe.labels, lastRun: instance.lastRun })
  }
  private fail(verb: Verb): void {
    const at = this.failures.findIndex(failure => failure.verb === verb)
    if (at < 0) return
    const { exit, kind } = this.failures.splice(at, 1)[0]!
    if (exit === 7) throw new DshdUnavailable(`dshd ${verb}: ${kind}`)
    throw Object.assign(new Error(`dshd ${verb}: ${kind}`), { kind, exit })
  }
}
