/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
/** The host services the Runtime runs on. DSH's headless app provides no `sessionController`, `workspaceRegistry` or `webServer`. */
const engineServices = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
// The entry itself requires no service, so that with the engine off it activates in any DSH app, a headless one included.
// Required here, the Runtime's services would hold the entry pending in an app that lacks them, before `apply` could see
// `engine: false`, and DSH reports every pending entry on each boot. The Runtime mounts in a context that injects them.
export const inject: string[] = []
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // With the engine off, the entry stays inert: no Runtime, so no state directory lock, database, process environment change,
  // route, tool or `orchestrator` service, and the Source plugins that inject that service wait (a profile leaves their rows
  // disabled). DSH keeps its generated settings page for the entry, where the engine can be turned on, as there is no
  // management panel without it.
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
  // Cordis starts the Runtime once every service it runs on exists and stops it when one goes away. Awaiting the mount keeps a
  // Runtime that cannot start a failure of this entry, which DSH reports, whenever the services are already present.
  await ctx.inject(engineServices, async engine => {
    const runtime = new Runtime(engine, machine, restart)
    engine.effect(() => async () => { await runtime.stop() })
    await runtime.ready
    ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  })
  // DSH reports an entry that waits for a service, but not a context inside an active entry, so report an engine whose services
  // are still missing once the plugin tree has settled, in DSH's own words.
  let mounted = true
  ctx.effect(() => () => { mounted = false })
  void (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await().then(() => {
    if (!mounted) return
    const missing = engineServices.filter(service => ctx.get(service) === undefined)
    if (missing.length > 0) ctx.logger.warn(`dsh-superagent engine is pending (waiting for ${missing.length === 1 ? 'service' : 'services'}: ${missing.join(', ')}); a process that only runs workers sets engine: false`)
  })
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
