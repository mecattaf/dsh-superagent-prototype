/**
 * An in-memory dshd for the dshd executor's tests: instances by name under dshd's same-name and same-recipe rules, which run a
 * headless task once, and the CLI they answer through DSH's subprocess service as `DshdCli` calls it (`spawn`).
 */
import { DshdUnavailable, type DshdLastRun, type DshdPort, type DshdRead, type DshdRecipe, type DshdRefusal, type DshdRunResult,
  type DshdStatus, type DshdWaitResult } from '../../src/executor/dshd-cli.ts'

interface Instance { recipe: DshdRecipe; id: string; state: string; invocationId: string | null; lastRun: DshdLastRun; lines: string[] }
type Verb = 'run' | 'get' | 'wait' | 'read' | 'stop' | 'rm'
/** The lines a headless `--json` run prints: its Session, then its answer, around dshd-run's own lines. */
export const runLines = (sessionId: string, final?: string): string[] => ['dshd-run: run started', JSON.stringify({ type: 'session', sessionId, cwd: '/' }),
  JSON.stringify({ type: 'text', text: 'Working.' }), ...final === undefined ? [] : [JSON.stringify({ type: 'final', text: final })], 'dshd-run: run ended']

/** In-memory `DshdPort` with helpers that end, cut, rerun or remove an instance, and fail the next call of a verb. */
export class FakeDshd implements DshdPort {
  readonly instances = new Map<string, Instance>()
  /** Every recipe `run` was asked for, in order. */
  readonly runs: DshdRecipe[] = []
  /** Every name `stop` stopped. */
  readonly stops: string[] = []
  /** Every name `rm` removed. */
  readonly removals: string[] = []
  /** Every `rm` the CLI was asked for, with its `--invocation` if any, removed or not. */
  readonly removed: { name: string; invocation: string | undefined }[] = []
  /** Whether `rm` takes `--invocation ID`, as dshd.nix's compare-and-remove does; false answers as a dshd before it. */
  rmInvocation = true
  /** While set, the CLI's answer to `run` waits for it (or for the caller's abort), after the instance was created. */
  hold?: Promise<void>
  private invocations = 0
  private readonly failures: { verb: Verb; exit: number; kind: string }[] = []
  private readonly hooks: { verb: Verb; act: () => void }[] = []
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
  /**
   * As `dshd rm`: refuses a running instance (`instance-running`, exit 4), else answers its status and deletes it. With
   * `invocationId`, as `dshd rm --invocation`, it first refuses an instance whose current or last run is another (`not-running`, exit 5).
   */
  async rm(name: string, _signal?: AbortSignal, invocationId?: string): Promise<DshdStatus | 'not-found' | DshdRefusal> {
    this.removed.push({ name, invocation: invocationId })
    this.fail('rm')
    const instance = this.instances.get(name)
    if (!instance) return 'not-found'
    const last = instance.invocationId ?? instance.lastRun.invocationId
    if (invocationId !== undefined && last !== invocationId) {
      return { refused: 'not-running', exit: 5, message: `${name}'s last run was ${last || 'none'}, not ${invocationId}` }
    }
    if (instance.state === 'running') {
      if (invocationId !== undefined) return { refused: 'instance-running', exit: 4, message: `${name} still runs ${invocationId}` }
      throw Object.assign(new Error(`${name} is running`), { kind: 'instance-running', exit: 4 })
    }
    const status = this.status(instance)
    this.instances.delete(name); this.removals.push(name)
    return status
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
    // As dshd does once a headless run ended, the top-level invocation is gone and only the last run names it.
    instance.invocationId = null
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
  /** `act` runs as the next call of `verb` begins, such as a rerun between the executor's `get` and its `rm`. */
  beforeNext(verb: Verb, act: () => void): void { this.hooks.push({ verb, act }) }
  /** As `dshd rm --help`: whether this dshd's `rm` takes `--invocation`. */
  async removesByInvocation(): Promise<boolean> { return this.rmInvocation }
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
        if (verb === 'rm' && argv.includes('--help')) {
          stdout = `Usage: dshd rm ${this.rmInvocation ? '[--invocation ID] ' : ''}[--json | --text] NAME\n`
          return 0
        }
        if (verb === 'rm' && argv.includes('--invocation') && !this.rmInvocation) {
          stderr = JSON.stringify({ error: { kind: 'usage', message: 'unknown flag --invocation', hint: 'dshd help rm' } })
          return 2
        }
        if (verb === 'rm') {
          const at = argv.indexOf('--invocation')
          const result = await this.rm(name, undefined, at < 0 ? undefined : argv[at + 1])
          if (result === 'not-found') { stderr = JSON.stringify({ error: { kind: 'not-found', message: `no instance ${name}`, hint: null } }); return 3 }
          if ('refused' in result) { stderr = JSON.stringify({ error: { kind: result.refused, message: result.message, hint: `dshd get ${name}` } }); return result.exit }
          stdout = JSON.stringify({ outcome: 'removed', ...result })
          return 0
        }
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
        const result = verb === 'get' ? await this.get(name) : verb === 'wait' ? await this.wait(name) : verb === 'read' ? await this.read(name)
          : await this.stop(name)
        if (result === 'not-found') { stderr = JSON.stringify({ error: { kind: 'not-found', message: `no instance ${name}`, hint: null } }); return 3 }
        stdout = JSON.stringify(verb === 'read' ? { name, streams: ['stdout', 'stderr'], ...result } : result)
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
    const hook = this.hooks.findIndex(entry => entry.verb === verb)
    if (hook >= 0) this.hooks.splice(hook, 1)[0]!.act()
    const at = this.failures.findIndex(failure => failure.verb === verb)
    if (at < 0) return
    const { exit, kind } = this.failures.splice(at, 1)[0]!
    if (exit === 7) throw new DshdUnavailable(`dshd ${verb}: ${kind}`)
    throw Object.assign(new Error(`dshd ${verb}: ${kind}`), { kind, exit })
  }
}
