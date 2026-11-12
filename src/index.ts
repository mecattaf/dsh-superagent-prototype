/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { lockReleased } from './infra/lock.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // With the engine off, the entry stays inert: no Runtime, so no state directory lock, database, process environment change,
  // route, tool or `orchestrator` service, and the Source plugins that inject that service wait. DSH keeps its generated
  // settings page for the entry, where the engine can be turned on, as there is no management panel without it. The bundle
  // leaves the row disabled while `engine` is false, so this runs where a profile enables the row itself.
  if (config.engine === false) { ctx.logger.info('dsh-superagent engine is off in this process; it opens nothing in %s', machine.stateDir); return }
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  // A process killed before its shutdown leaves the state directory lock until it goes stale; wait for that within `lockWaitMs`.
  const waiting = new AbortController()
  ctx.effect(() => () => { waiting.abort() }, 'state directory lock wait')
  await lockReleased(machine.stateDir, machine.lockWaitMs, waiting.signal)
  if (waiting.signal.aborted) return
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
