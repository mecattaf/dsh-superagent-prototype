import { i as WorkflowRun, r as SourceHost, t as SourceKind } from "./kind-BZ6bj9bY.js";
import { Context, Volatile } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
//#region src/sources/workflow-floor.d.ts
/** The workflow Source's machine settings, as the plugin's Config declares them; `pollMs` is read at each use. */
interface FloorConfig {
  pollMs: Volatile<number>;
  concurrency: number;
  maxAttempts: number;
  pair: string;
}
interface StartRequest {
  script: string;
  cwd: string;
  args?: unknown;
  pair?: string;
  trigger_id?: string;
}
interface StartResult {
  run_id: string;
  state: 'started' | 'already-started';
  script_sha256: string;
  name: string;
}
/**
 * Where a node is: `waiting` before its Trigger exists, `offered` while it waits for or is in an Eval, `held` once an Eval
 * decided it without a Ticket, `ticket` while its Ticket works, and `done` or `null` once its result or failure is journaled.
 * A node answered from the journal on a resume is `done` or `null` as its line says. Its latest Trigger and its Ticket, when
 * the Store has them, come with every state but `waiting`.
 */
type NodeState = 'waiting' | 'offered' | 'held' | 'ticket' | 'done' | 'null';
interface NodeStatus {
  node: string;
  label?: string;
  phase?: string;
  trigger_id?: string;
  ticket_id?: string;
  state: NodeState;
}
interface RunStatus {
  run_id: string;
  name: string;
  state: WorkflowRun['state'];
  cwd: string;
  started_at: string;
  ended_at?: string;
  error?: string;
  nodes: NodeStatus[];
}
/**
 * The workflow Source at work: it starts runs on request, drives each one with the interpreter, journals it in the Store, and
 * after a restart resumes every run that had not ended, answering finished calls from the journal without raising them again.
 */
declare class WorkflowFloor {
  private readonly host;
  private readonly config;
  private source;
  private waiter;
  private readonly stopped;
  private readonly driving;
  constructor(host: SourceHost, config: FloorConfig);
  /** Waits for setup, then resumes every run that had not ended; it resolves once they are under way, not once they end. */
  start(): Promise<void>;
  /** Parks every waiting call: nothing more is journaled, and the runs resume on the next start. */
  stop(): void;
  /** Starts a run of a script in a directory, once per `trigger_id`; the script's text is kept, and a resume reads that text. */
  startRun(request: StartRequest): StartResult;
  /** The state of one run and of each of its nodes, or of the newest runs when `runId` names none. */
  status(runId?: string): RunStatus[];
  /** How many runs this process drives now. */
  get active(): number;
  private ready;
  private runs;
  private drive;
  private finish;
  private runStatus;
  private reportHealth;
}
//#endregion
//#region src/sources/workflow-trigger.d.ts
declare const SOURCE = "workflow";
//#endregion
//#region src/sources/workflow.d.ts
/**
 * The Source's machine settings. `pollMs` applies without a restart, as the waiting nodes read it at each poll; changing another
 * remounts the plugin, which resumes every run from its journal.
 */
declare const Config: s<Schemastery.ObjectS<NoInfer<{
  pollMs: s<number, number, "volatile-defined">;
  concurrency: s<number, number, "defined">;
  maxAttempts: s<number, number, "defined">;
  pair: s<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  pollMs: s<number, number, "volatile-defined">;
  concurrency: s<number, number, "defined">;
  maxAttempts: s<number, number, "defined">;
  pair: s<string, string, "defined">;
}>>, "plain">;
type WorkflowConfig = ReturnType<typeof Config>;
/** The workflow kind: its nodes are senderless, so the Policy's admission row `workflow` decides whether they become candidates. */
declare const workflowKind: (floor: Pick<WorkflowFloor, "startRun" | "status">) => SourceKind<Record<string, never>>;
declare const name = "dsh-superagent-workflow";
declare const inject: string[];
declare function apply(ctx: Context, config: WorkflowConfig): void;
//#endregion
export { Config, SOURCE, WorkflowConfig, apply, inject, name, workflowKind };