# 009 Workflows

This document describes the workflow Source: how a workflow script's `agent()` calls become Tickets, what a deployment configures for it, and how a run resumes. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [003 Execution](003-execution.md), [006 Deployment](006-deployment.md) and [008 Cookbook](008-cookbook.md).

## What it is

The workflow Source is the plugin `dsh-superagent-workflow`, inserted disabled by the bundle; enable it in the profile with `disabled: false` on that row. It runs workflow scripts with the interpreter in `src/workflow`, a vendored copy of Substrate's. A script's `agent()` call is a node. Each attempt of a node is one Trigger of the `workflow` Source on the node's own Thread; the node's result is the result of the Ticket accepted from it.

| Concept | Definition | Rules it keeps |
| --- | --- | --- |
| Run | One start of one script in one directory, with its arguments | The script's text is kept when the run starts, and every resume reads that text; each `workflow()` child is kept the first time it is read |
| Node | One `agent()` call of a run | Named by its content identity and its occurrence among identical calls, so a resumed run names it as the run before did |
| Node Trigger | One attempt of a node, on the node's Thread | Senderless, unaddressed and not from a person; its text is the prompt; then, on a later attempt, why the interpreter did not accept the attempt before it, as each attempt runs in a new worker; and last the schema instruction when the call has a schema; `meta` carries `cwd`, `pair`, `labels`, the run and the node |
| Journal | The run's lines in the interpreter's journal format | One `kv` record per line, written as the line is; nothing else records a node |

## Settings a deployment gives it

[006 Deployment](006-deployment.md) lists the plugin's Config keys, set on the row `dsh-superagent-workflow` of a profile's `cordis.patch.yml`, and an example rule for its nodes. Changing any key but `pollMs` and `offeredWarnSeconds` restarts the plugin, which resumes every run from its journal.

A node is a senderless Trigger, so the gate admits it only through the Source's admission table, and only as an inferred candidate. Three settings make the next node proceed by default; the Source sets none of them:

- `eval.mode` is `auto`, so inferred candidates may be accepted;
- `policy.sources.workflow.admission.workflow.unlistedUnaddressed` is `inferred`; without it every node is ignored with `admission_ignored`;
- an enabled rule that accepts workflow nodes, such as `workflow-node`, whose instruction says that a node proceeds unless other work should go first, and that a held node is released with `orchestrator_trigger_requeue`.

## Starting and reading runs

The kind adds two main-Session tools. They reach the main Session when the plugin registers the kind and leave it when the plugin stops.

| Tool | Does |
| --- | --- |
| `orchestrator_workflow_start` | Starts `script` in the absolute directory `cwd` with `args` and `pair`. A repeated `trigger_id` with the same script, directory and arguments returns the run it started, so its description tells the main Session always to pass the `trigger_id` of the request it answers. It refuses a relative or missing directory, a script it cannot read, and a script whose `meta` is invalid |
| `orchestrator_workflow_status` | One run, or the newest runs, with each node `waiting`, `offered`, `held`, `unavailable`, `ticket`, `done` or `null`, and its latest Trigger and its Ticket once it has them. A `held` or `unavailable` node also gives `decided_at` and `reason`, from its Decision. An `offered` node in an Eval gives `offered_since`, when that Eval started. A node a resumed run answered from its journal is `done` or `null` as its journal line says |

## The window

The main Session assesses node candidates as it assesses any inferred candidate. It never sequences work by stopping a Ticket.

| Act | How |
| --- | --- |
| Proceed | Accept the candidate; the Ticket launches when a worker slot is free, oldest first |
| Hold | Ignore the candidate with a reason; the node waits, and its run with it |
| Release | `orchestrator_trigger_requeue` with the node's Trigger: the same Trigger goes to a fresh Eval |
| Other work first | Accept the other work now and hold the node |
| No answer | An Eval that expires twice more is recorded unavailable; the node is `unavailable`, not `held`, and waits as a held one does, until it is requeued. The Source logs a warning for it, and its health detail counts the held and the unassessed nodes apart |
| Main Session away | An Eval whose candidate never reaches the main Session does not expire, so its node stays `offered`. Past `offeredWarnSeconds` the Source logs a warning for it, once, and its health detail counts the nodes offered for longer; the node still waits for its assessment. A candidate that reached the main Session is not counted, however old its Eval: it is being assessed, and its Eval expires on its own deadline |

So every node costs one Eval of the main Session, and a run moves only as fast as that Session assesses: while it cannot answer, each new node waits as a held one does, and so does its run. This keeps admission as upstream defines it, where a senderless Trigger can only be an inferred candidate or ignored (`src/admission.ts`). Letting a node launch without an Eval, with the main Session reordering only by hold and release, would need a new admission value in that table.

## Results, failures and resume

- A node's result is the summary of its Ticket's `ready` report, verbatim, once the Ticket ended completed; a node with a schema parses it as one JSON value, inside one code fence at most.
- A node has no answer when that summary is no JSON value and the node has a schema, or when the summary only says the unit exited 0, which the dshd Executor reports for a worker that gave no final answer. The interpreter treats no answer as it treats any: it tries the node again while attempts remain, else the node is `null`, with `no structured output` or `no text output` in its journal line.
- The Source finds a node's Ticket among its Thread's subscriptions, or among the open Tickets once that Thread was unsubscribed, and keeps its ID as `workflow-ticket:<trigger>`, so a node whose Thread a person or the main Session unsubscribed still settles when its Ticket ends.
- A Ticket that ends otherwise, or whose worker reports `failed` or `blocked`, makes the node `null` with the reason in its journal line. A resumed run answers that line with the same `null`, and never raises the node again.
- A node's Ticket whose worker reported `failed` or `blocked`, which the dshd Executor reports for a unit that could not launch or did not exit 0, stays open and waits for a person, as any such Ticket does ([003 Execution](003-execution.md)): the failure is recorded and left in view, not cleared. The run has its `null` and reads that Ticket no more, so a **Retry** runs the work again but its answer reaches no run. A person who has read the failure ends the Ticket with **Stop**, or `POST tickets/<id>/stop`; work the node should still do needs a new run.
- At start, the plugin resumes every run that has not ended. A node with a result or a failure in the journal answers from it. A node whose Trigger the Engine already has waits for that Trigger's Ticket, and one whose Trigger never reached the Engine raises it once.
- When the plugin stops, every node that waits parks: its run writes nothing more until the next start.
- `orchestrator_workflow_status` also gives each node's `usage` and the run's `usage`: the tokens the node's workers used, in DSH's usage names (`inputTokens`, `outputTokens`, and `totalTokens`, `cacheReadTokens`, `cacheWriteTokens` or `reasoningTokens` when the provider reports them). Once a unit ended, the dshd Executor sums the usage on each `step_end` status its headless run printed, which dsh takes from the step's `assistant/message` in the worker's Session, and keeps it on the Assignment's binding. It is known only when a read the Executor makes anyway, for the run's answer and Session, reaches back to the run's start, and every step printed its usage. A node's usage sums the units of all its attempts, each Ticket once, and shows only once none of them runs. The run's `usage.total` sums the nodes measured, keeping a bucket only when each of them reports it, and `unmeasured_nodes` counts the nodes with an ended unit whose usage is not known, which is every node on an Executor that records none.
- A run's journal reads back as one JSON line per record: `SELECT value FROM kv WHERE key LIKE 'workflow-journal:<run>:%' ORDER BY key`. The script it ran is the record `workflow-script:<sha256>`.

## Not supported

| Not supported | Why |
| --- | --- |
| Token budgets | Usage is measured, not limited: the interpreter's budget is not set, and a node's tokens are not journaled |
| A call's `model` and `effort` | Recorded in the Trigger's `meta`; nodes run on their pair |
| Nesting deeper than one `workflow()` | The interpreter's limit |
| A run started by a Scheduled item's own key | A Scheduled nudge asks the main Session, which starts the run with the tool |

## Where it differs from the other Sources

- **Its export is `dsh-superagent/workflow`.** The other Sources export `<kind>-watch`, as each watches something outside DSH: a repository, a chat, an inbox. This one watches nothing; it runs scripts. Profiles name the export in the row `dsh-superagent-workflow`, so it keeps its name.
- **Its refusals are plain errors.** A request the main Session gets wrong, such as a relative `cwd` or a script whose `meta` is invalid, fails `orchestrator_workflow_start` with an error whose message starts `orchestrator_workflow_start:`, not with a `UserError` code: the codes live in `src/core`, which the fork leaves as it is.
- **Unknown configuration keys fail the load**, as they do for `dsh-superagent` and `dsh-superagent-scheduled`, so a misspelt `pollMs` never runs on the default.
