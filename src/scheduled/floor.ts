/**
 * The Scheduled floor's composition (DESIGN 7): the spool poll, DshdExecutor with its routing executor, the default route,
 * and resume. `Runtime` builds it only when the plugin configuration enables `scheduled`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DomainEvent, Executor, ReceiveResult, Trigger } from '../core/index.ts'
import type { Engine } from '../core/index.ts'
import type { Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import type { ScheduledConfig } from '../deployment.ts'
import { DshdExecutor, RoutingExecutor } from '../executor/dshd.ts'
import { schedCli } from './cli.ts'
import { onDomainEvent } from './default-route.ts'
import { intakeOnce, type ShownWorkflow } from './intake.ts'
import { floorLog } from './log.ts'
import { ensureSpool } from './spool.ts'

export interface FloorHost {
  config: ScheduledConfig
  stateDir: string
  store: Store
  effects: Effects
  engine: () => Pick<Engine, 'assignmentStarted' | 'inputsDelivered' | 'report' | 'decide' | 'attach'>
  receive: (trigger: Trigger) => ReceiveResult
  paused: () => boolean
  closing: () => boolean
  /** The in-process executor every non-scheduled Ticket keeps. */
  other: Executor
}

/** The Scheduled floor: owns the spool poll, the DshdExecutor and its routing executor, and the default route hook. */
export class Floor {
  readonly dshd: DshdExecutor
  readonly executor: Executor
  private timer: NodeJS.Timeout | undefined
  private polling = false
  private readonly spoolDir: string
  constructor(private readonly host: FloorHost) {
    this.spoolDir = join(host.stateDir, 'spool')
    const cli = schedCli({ path: host.config.cli })
    this.dshd = new DshdExecutor({
      get engine() { return host.engine() }, store: host.store, effects: host.effects, cli,
      paused: host.paused, closing: host.closing, maxWorkers: () => host.config.maxWorkers, dshd: host.config.dshd,
    })
    this.executor = new RoutingExecutor(this.dshd, host.other)
  }
  /** The Engine's domain event hook. */
  event(event: DomainEvent): void {
    const { host } = this
    onDomainEvent({ get engine() { return host.engine() }, store: host.store }, event)
  }
  start(): void {
    ensureSpool(this.spoolDir)
    this.dshd.resume(name => this.host.effects.pending('watch', name))
    const every = Math.max(1, this.host.config.pollSeconds) * 1000
    this.timer = setInterval(() => { void this.poll() }, every)
    this.timer.unref()
    void this.poll()
    floorLog('upkeep', { action: 'start', spool: this.spoolDir, agencies: this.host.config.agencies.map(agency => agency.id).join(',') })
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  /** One spool pass; never overlaps itself. */
  async poll(): Promise<void> {
    if (this.polling || this.host.closing()) return
    this.polling = true
    try {
      const cli = schedCli({ path: this.host.config.cli })
      await intakeOnce({
        spoolDir: this.spoolDir, store: this.host.store, receive: this.host.receive,
        show: async id => await (cli.show(id) as Promise<ShownWorkflow>).catch((error: unknown) => ({ error: String(error) })),
        agencies: this.host.config.agencies, census: async record => { await this.dshd.onCensus(record) },
        machineId: () => { try { return readFileSync('/etc/machine-id', 'utf8').trim() } catch { return undefined } },
      })
    } catch (error) { floorLog('error', { poll: 'spool', error: String(error) }) }
    finally { this.polling = false }
  }
}
