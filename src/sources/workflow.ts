/** Workflow Source kind and Cordis plugin entry: runs workflow scripts, each `agent()` call a Trigger that becomes a Ticket once accepted. */
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SourceKind } from './kind.ts'
import { WorkflowFloor } from './workflow-floor.ts'
import { workflowTools } from './workflow-tools.ts'
import { MAX_ATTEMPTS, SOURCE } from './workflow-trigger.ts'

export { SOURCE } from './workflow-trigger.ts'
/**
 * The Source's machine settings. `pollMs` and `offeredWarnSeconds` apply without a restart, as the waiting nodes read them at
 * each poll; changing another remounts the plugin, which resumes every run from its journal.
 */
export const Config = s.object({
  pollMs: s.number().min(500).max(60000).step(1).default(2000)
    .description('How often a node that waits reads its ticket for a failed or blocked report, in milliseconds; a node settles as soon as its ticket ends.').volatile(),
  offeredWarnSeconds: s.number().min(60).max(604800).step(1).default(3600)
    .description('How long a node may stay offered in one evaluation before the log warns once and the health detail counts it, in seconds; an evaluation whose candidate never reaches the main Session does not expire, and nothing here expires it.').volatile(),
  concurrency: s.number().min(1).max(64).step(1).default(16)
    .description('agent() calls of one run in flight at once; the Executor\'s worker limit still caps the tickets that run.'),
  maxAttempts: s.number().min(1).max(MAX_ATTEMPTS).step(1).default(1)
    .description('Attempts at each agent() call, each one a new Trigger; with 1, a node whose ticket fails or whose reply does not match its schema returns null.'),
  pair: s.string().default('')
    .description('The compute pair of the nodes of a run that names none; empty leaves the choice to the Executor.'),
})
export type WorkflowConfig = ReturnType<typeof Config>

/** The workflow kind: its nodes are senderless, so the Policy's admission row `workflow` decides whether they become candidates. */
export const workflowKind = (floor: Pick<WorkflowFloor, 'startRun' | 'status' | 'ticketEnded'>): SourceKind<Record<string, never>> => ({
  kind: SOURCE,
  title: { zh: '工作流', en: 'Workflows' },
  description: { zh: '运行工作流脚本；脚本的每个 agent() 调用成为一个候选，接受后成为一张工单。', en: 'Runs workflow scripts; each agent() call of a script becomes a candidate, and a ticket once accepted.' },
  schema: z.object({}).strict(),
  fields: [],
  health: [SOURCE],
  scope: () => ({ listened: true, observed: true, row: SOURCE }),
  tools: workflowTools(floor),
  ticketEnded: ticket => { floor.ticketEnded(ticket) },
})

export const name = 'dsh-superagent-workflow'
export const inject = ['orchestrator']
/** Refuses configuration keys the entry does not use, so a misspelt `pollMs` fails the load instead of running on the default. */
function checked(config: WorkflowConfig): WorkflowConfig {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent-workflow configuration has keys it does not use: ${unknown.join(', ')}; docs/009-workflows.md lists the keys`)
  return config
}
export function apply(ctx: Context, config: WorkflowConfig): void {
  checked(config)
  ctx.effect(() => {
    const floor = new WorkflowFloor(ctx.orchestrator, config, ctx.logger)
    const unregister = ctx.orchestrator.sources.register(workflowKind(floor))
    // DSH ends its process on an unhandled rejection, so a failure that escapes the start becomes the Source's health.
    const running = floor.start().catch((error: unknown) => { ctx.orchestrator.context({ kind: SOURCE, health: [SOURCE] }).report(SOURCE, { state: 'error', detail: String(error) }) })
    // Stop the runs first, so nothing reports to the kind's entries after they are released.
    return async () => { floor.stop(); await running; unregister() }
  }, 'workflow: source kind and runs')
}
