/** The main Session's workflow tools: `orchestrator_workflow_start` starts a run of a script, `orchestrator_workflow_status` reads runs. */
import { z } from 'zod'
import { sourceTool, type SourceTool } from './kind.ts'
import type { WorkflowFloor } from './workflow-floor.ts'

export function workflowTools(floor: Pick<WorkflowFloor, 'startRun' | 'status'>): SourceTool[] {
  return [
    sourceTool({
      name: 'orchestrator_workflow_start',
      description: 'Start a workflow script on an explicit request naming the script and its directory. Each agent() call arrives as an inferred workflow candidate you assess like any other; accepting one runs its node as a ticket there, which the run waits for. A repeated trigger_id starts nothing new.',
      schema: z.object({
        script: z.string().min(1).describe('Path, absolute or relative to cwd.'),
        cwd: z.string().regex(/^\//, 'An absolute path').describe('Absolute directory all nodes work in.'),
        args: z.unknown().optional().describe('Value the script reads as args.'),
        pair: z.string().min(1).optional().describe('Compute pair of all nodes; else the Source\'s, else the Executor\'s default.'),
        trigger_id: z.string().min(1).optional().describe('The request\'s trigger; repeating it with the same script, cwd and args returns its run.'),
      }).strict(),
      execute: async args => floor.startRun(args),
    }),
    sourceTool({
      name: 'orchestrator_workflow_status',
      description: 'Read a workflow run and where each of its nodes is: waiting, offered, held, ticket, done or null; without run_id, the newest runs. A held node waits until its trigger is requeued.',
      schema: z.object({ run_id: z.string().min(1).optional() }).strict(),
      execute: async args => ({ runs: floor.status(args.run_id) }),
    }),
  ]
}
