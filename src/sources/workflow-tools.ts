/** The main Session's workflow tools: `orchestrator_workflow_start` starts a run of a script, `orchestrator_workflow_status` reads runs. */
import { z } from 'zod'
import { sourceTool, type SourceTool } from './kind.ts'
import type { WorkflowRuns } from './workflow-runs.ts'

export function workflowTools(runs: Pick<WorkflowRuns, 'startRun' | 'status'>): SourceTool[] {
  return [
    sourceTool({
      name: 'orchestrator_workflow_start',
      description: 'Start a workflow script on an explicit request naming the script and its directory. Each agent() call arrives as an inferred workflow candidate you assess like any other; accepting one runs its node as a ticket there, which the run waits for. Pass the actual trigger_id when answering a Source Trigger. A direct Session request has no Source Trigger: omit trigger_id, retain the returned run_id and never repeat a start merely because collecting its answer timed out.',
      schema: z.object({
        script: z.string().min(1).describe('Path, absolute or relative to cwd.'),
        cwd: z.string().regex(/^\//, 'An absolute path').describe('Absolute directory all nodes work in.'),
        args: z.unknown().optional().describe('Value the script reads as args.'),
        pair: z.string().min(1).optional().describe('Compute pair of all nodes; else the Source\'s, else the Executor\'s default.'),
        max_agents: z.number().int().min(1).max(1_000_000).optional().describe('Finite lifetime agent() call budget, including replayed calls; default 1000. Recorded on this run and preserved on restart. This does not change node time or worker limits.'),
        trigger_id: z.string().min(1).optional().describe('The request\'s trigger; repeating it with the same script, cwd and args returns its run.'),
      }).strict(),
      execute: async args => runs.startRun(args),
    }),
    sourceTool({
      name: 'orchestrator_workflow_status',
      description: 'Read a workflow run and where each of its nodes is: waiting, offered, held, unavailable, ticket, done or null; without run_id, the newest runs. A held or unavailable (never assessed) node waits until its trigger is requeued.',
      schema: z.object({ run_id: z.string().min(1).optional() }).strict(),
      execute: async args => ({ runs: runs.status(args.run_id) }),
    }),
  ]
}
