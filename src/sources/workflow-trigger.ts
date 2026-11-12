/** A workflow node as a Trigger: one for each attempt of each `agent()` call of a run, on the node's own Thread. */
import type { Trigger } from '../core/index.ts'
import type { AgentCall } from '../workflow/index.ts'
import type { WorkflowRun } from './workflow-store.ts'

export const SOURCE = 'workflow'
/** The most attempts the Source's Config allows at one `agent()` call. */
export const MAX_ATTEMPTS = 3
/** What a node with a schema is asked to reply with, worded as Substrate's runners word it. */
export const SCHEMA_INSTRUCTION = 'Reply with one JSON value only, no prose and no code fence, valid against this JSON Schema:'

/** How a later attempt's text introduces why the interpreter did not accept the attempt before it. */
export const RETRY_NOTE = 'A previous attempt at this task was not accepted:'

type Call = Pick<AgentCall, 'cid' | 'occurrence' | 'attempt' | 'previousErrors' | 'prompt' | 'opts' | 'phase'>
/**
 * A call's node name within its run: the start of its content identity and its occurrence among identical calls, which the
 * interpreter fixes when the script makes the call, so a resumed run names each call as the run before it did.
 */
export function nodeOf(call: Pick<AgentCall, 'cid' | 'occurrence'>): string {
  const hash = call.cid === undefined ? undefined : /^c1:([0-9a-f]{16})/.exec(call.cid)?.[1]
  if (!hash) throw new Error(`workflow: a call without a content identity (${String(call.cid)})`)
  return `${hash}-o${call.occurrence ?? 1}`
}
/**
 * The Thread of a node, its own, so no other node's Ticket receives its Triggers. A later attempt follows only a Ticket that
 * ended completed, which a Trigger that no person wrote does not resume, so it goes to Eval as the first did.
 */
export const nodeThread = (run: string, node: string): string => `${run}:${node}`
/** The Trigger id of one attempt of a node. */
export const nodeTriggerId = (run: string, node: string, attempt: number): string => `wf:${nodeThread(run, node)}-a${attempt}`

/**
 * The Trigger of one attempt of a call: senderless and unaddressed, so the gate admits it only through the workflow row of the
 * Source's admission table. Its text is the prompt; then, on a later attempt, why the attempt before it was not accepted, as
 * each attempt runs in a new worker that knows nothing of the last; and last the schema instruction when the call has a schema.
 * `meta` tells the Executor the directory, compute pair and labels of the node.
 */
export function nodeTrigger(run: WorkflowRun, call: Call, at = new Date().toISOString()): Trigger {
  const node = nodeOf(call)
  const { label, schema, model, effort } = call.opts
  const retry = call.attempt > 1 && call.previousErrors?.length ? [`${RETRY_NOTE} ${call.previousErrors.join('; ')}`] : []
  const text = [call.prompt, ...retry, ...schema === undefined ? [] : [`${SCHEMA_INSTRUCTION}\n${JSON.stringify(schema)}`]].join('\n\n')
  return {
    id: nodeTriggerId(run.id, node, call.attempt),
    source: SOURCE,
    threads: [{ source: SOURCE, id: nodeThread(run.id, node) }],
    actor: { source: SOURCE, id: '' },
    human: false,
    at,
    text,
    meta: {
      kind: 'workflow-node', run: run.id, workflow: run.name, node, cid: call.cid, occurrence: call.occurrence, attempt: call.attempt,
      ...label !== undefined && { label: String(label) }, ...call.phase !== undefined && { phase: call.phase },
      cwd: run.cwd, ...run.pair !== undefined && { pair: run.pair },
      // Recorded for the Executor and for people; nodes run on their pair's model.
      ...model !== undefined && { model: String(model) }, ...effort !== undefined && { effort: String(effort) },
      labels: { 'superagent.run': run.id, 'superagent.node': node },
    },
  }
}
