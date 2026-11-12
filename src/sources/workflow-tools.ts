/** The main Session's workflow tools: `orchestrator_workflow_start` starts a run of a script, `orchestrator_workflow_status` reads runs. */
import { z } from 'zod'
import { sourceTool, type SourceTool } from './kind.ts'
import type { WorkflowFloor } from './workflow-floor.ts'

export function workflowTools(floor: Pick<WorkflowFloor, 'startRun' | 'status'>): SourceTool[] {
  return [
    sourceTool({
      name: 'orchestrator_workflow_start',
      description: 'Start a workflow script on an explicit request that names the script and the directory to run it in. Each agent() call of the script arrives as an inferred candidate from the workflow Source, which you assess like any other: accepting it runs that node as a ticket in the directory, and the run waits for each ticket it needs. A repeated trigger_id starts nothing new.',
      schema: z.object({
        script: z.string().min(1).describe('The workflow script: an absolute path, or one relative to cwd.'),
        cwd: z.string().regex(/^\//, 'An absolute path').describe('The absolute directory every node of the run works in.'),
        args: z.unknown().optional().describe('The value the script reads as args.'),
        pair: z.string().min(1).optional().describe('The compute pair every node runs on; without it, the Source\'s pair, else the Executor\'s default.'),
        trigger_id: z.string().min(1).optional().describe('The trigger of the request this run answers; starting with the same trigger, script, cwd and args again returns the run it started.'),
      }).strict(),
      execute: async args => floor.startRun(args),
    }),
    sourceTool({
      name: 'orchestrator_workflow_status',
      description: 'Read a workflow run and where each of its nodes is: waiting, offered, held, unavailable, ticket, done or null; without run_id, the newest runs. A held node was decided without a ticket; an unavailable one was never assessed, as when its evaluation timed out. Each gives when and why, and waits until its trigger is requeued. An offered node in an evaluation gives offered_since, when it started; an evaluation whose candidate never reaches you does not expire.',
      schema: z.object({ run_id: z.string().min(1).optional() }).strict(),
      execute: async args => ({ runs: floor.status(args.run_id) }),
    }),
  ]
}
