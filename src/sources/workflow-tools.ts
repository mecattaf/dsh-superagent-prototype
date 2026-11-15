/** The main Session's workflow tools: `orchestrator_workflow_start` starts a run of a script, `orchestrator_workflow_status` reads runs. */
import { z } from 'zod'
import { sourceTool, type SourceTool } from './kind.ts'
import type { WorkflowRuns } from './workflow-runs.ts'

export function workflowTools(runs: Pick<WorkflowRuns, 'startRun' | 'status'>): SourceTool[] {
  return [
    sourceTool({
      name: 'orchestrator_workflow_start',
      description: 'Start a requested script in cwd. Assess each agent() candidate; acceptance runs its Ticket. For a Source request pass trigger_id; for a direct Session request omit it. Retain run_id and collect pending answers without repeating start.',
      schema: z.object({
        script: z.string().min(1).describe('Path, absolute or relative to cwd.'),
        cwd: z.string().regex(/^\//, 'An absolute path').describe('Absolute directory all nodes work in.'),
        args: z.unknown().optional().describe('Value the script reads as args.'),
        pair: z.string().min(1).optional().describe('Default worker pair; nodes may override it.'),
        max_agents: z.number().int().min(1).max(1_000_000).optional().describe('Lifetime agent() call cap including replay; default 1000, persisted across restart. Separate from time and worker limits.'),
        trigger_id: z.string().min(1).optional().describe('The request\'s trigger; repeating it with the same script, cwd and args returns its run.'),
      }).strict(),
      execute: async args => runs.startRun(args),
    }),
    sourceTool({
      name: 'orchestrator_workflow_status',
      description: 'Read run/node state; omit run_id for newest runs. Held/unavailable nodes wait for trigger requeue.',
      schema: z.object({ run_id: z.string().min(1).optional() }).strict(),
      execute: async args => ({ runs: runs.status(args.run_id) }),
    }),
  ]
}
