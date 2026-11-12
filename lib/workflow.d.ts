import { z as Ticket } from "./intake-YOZzjx_b.js";
import { a as TokenUsage, i as WorkflowRun, r as SourceHost, t as SourceKind } from "./kind-8FRB3xyy.js";
import { Context, Volatile } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";
//#region src/sources/workflow-runs.d.ts
/** What the workflow Source logs through: the plugin's Cordis logger. */
interface RunsLogger {
  info(format: string, ...args: unknown[]): void;
  warn(format: string, ...args: unknown[]): void;
}
/** The workflow Source's machine settings, as the plugin's Config declares them; `pollMs` and `offeredWarnSeconds` are read at each use. */
interface RunsConfig {
  pollMs: Volatile<number>;
  offeredWarnSeconds: Volatile<number>;
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
 * Where a node is: `waiting` before its Trigger exists, `offered` while it waits for or is in an Eval, `held` once the main
 * Session or a person decided it without a Ticket, `unavailable` once its Eval ended without an assessment, as when the main
 * Session did not answer in time, `ticket` while its Ticket works, and `done` or `null` once its result or failure is
 * journaled. A held or unavailable node waits, and is offered again once its Trigger is requeued. A node answered from the
 * journal on a resume is `done` or `null` as its line says. Its latest Trigger and its Ticket, when the Store has them, come
 * with every state but `waiting`; a held or unavailable node also gives when its Decision was recorded and why, and an offered
 * node in an Eval when that Eval started, as an Eval whose candidate never reaches the main Session does not expire.
 */
type NodeState = 'waiting' | 'offered' | 'held' | 'unavailable' | 'ticket' | 'done' | 'null';
interface NodeStatus {
  node: string;
  label?: string;
  phase?: string;
  trigger_id?: string;
  ticket_id?: string;
  state: NodeState;
  decided_at?: string;
  reason?: string;
  offered_since?: string;
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
/** A node's `usage`: the tokens its Tickets' workers used, once every unit of them ended and printed its usage (see `nodeUsage`). */
interface NodeStatus {
  usage?: TokenUsage;
}
/** A run's `usage` (see `RunUsage`). */
interface RunStatus {
  usage: RunUsage;
}
/**
 * What a run's nodes used: `total`, while `measured_nodes` is not 0, sums the nodes measured, keeping a bucket only when each
 * of them reports it; `unmeasured_nodes` counts those with an ended unit whose usage is not known, such as one whose Executor
 * records none. A node with a unit that still runs, or none that ended, is neither.
 */
interface RunUsage {
  total?: TokenUsage;
  measured_nodes: number;
  unmeasured_nodes: number;
}
/**
 * The workflow Source at work: it starts runs on request, drives each one with the interpreter, journals it in the Store, and
 * after a restart resumes every run that had not ended, answering finished calls from the journal without raising them again.
 */
declare class WorkflowRuns {
  private readonly host;
  private readonly config;
  private readonly logger;
  private source;
  private waiter;
  private readonly stopped;
  private readonly driving;
  constructor(host: SourceHost, config: RunsConfig, logger: RunsLogger);
  /** Waits for setup, then resumes every run that had not ended; it resolves once they are under way, not once they end. */
  start(): Promise<void>;
  /** Parks every waiting call: nothing more is journaled, and the runs resume on the next start. */
  stop(): void;
  /**
   * Starts a run of a script in a directory, once per `trigger_id`; the script's text is kept, and a resume reads that text.
   * @throws UserError when the Source is not running, `cwd` is not an absolute directory, or the script cannot be read or has no valid meta.
   */
  startRun(request: StartRequest): StartResult;
  /**
   * The state of one run and of each of its nodes, or of the newest runs when `runId` names none.
   * @throws UserError when the Source is not running or `runId` names no run.
   */
  status(runId?: string): RunStatus[];
  /** Settles the nodes that wait for `ticket`, which has just ended. */
  ticketEnded(ticket: Ticket): void;
  /** How many runs this process drives now. */
  get active(): number;
  private ready;
  private runs;
  private drive;
  private finish;
  private runStatus;
  /**
   * A waiting node came to be held, unavailable or offered past the threshold, or left that state: the log says which once, and
   * the health counts them, so a node that waits on the main Session's absence reads apart from one it decided to hold. None is
   * offered again or expired here.
   */
  private observed;
  private reportHealth;
}
//#endregion
//#region src/sources/workflow-trigger.d.ts
declare const SOURCE = "workflow";
//#endregion
//#region src/sources/workflow.d.ts
/**
 * The Source's machine settings. `pollMs` and `offeredWarnSeconds` apply without a restart, as the waiting nodes read them at
 * each poll; changing another remounts the plugin, which resumes every run from its journal.
 */
declare const Config: s<Schemastery.ObjectS<NoInfer<{
  pollMs: s<number, number, "volatile-defined">;
  offeredWarnSeconds: s<number, number, "volatile-defined">;
  concurrency: s<number, number, "defined">;
  maxAttempts: s<number, number, "defined">;
  pair: s<string, string, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  pollMs: s<number, number, "volatile-defined">;
  offeredWarnSeconds: s<number, number, "volatile-defined">;
  concurrency: s<number, number, "defined">;
  maxAttempts: s<number, number, "defined">;
  pair: s<string, string, "defined">;
}>>, "plain">;
type WorkflowConfig = ReturnType<typeof Config>;
/** The workflow kind: its nodes are senderless, so the Policy's admission row `workflow` decides whether they become candidates. */
declare const workflowKind: (runs: Pick<WorkflowRuns, "startRun" | "status" | "ticketEnded">) => SourceKind<Record<string, never>>;
declare const name = "dsh-superagent-workflow";
declare const inject: string[];
declare function apply(ctx: Context, config: WorkflowConfig): void;
//#endregion
export { Config, SOURCE, WorkflowConfig, apply, inject, name, workflowKind };