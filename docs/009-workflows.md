# 009 Workflows

This document describes the workflow Source: how a workflow script's `agent()` calls become Tickets, what a deployment configures for it, and how a run resumes. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [003 Execution](003-execution.md) and [008 Cookbook](008-cookbook.md).

## What it is

The workflow Source is the plugin `dsh-superagent-workflow`, inserted disabled by the bundle. It runs workflow scripts with the interpreter in `src/workflow`, a vendored copy of Substrate's. A script's `agent()` call is a node. Each attempt of a node is one Trigger of the `workflow` Source on the node's own Thread; the node's result is the result of the Ticket accepted from it.

| Concept | Definition | Rules it keeps |
| --- | --- | --- |
| Run | One start of one script in one directory, with its arguments | The script's text is kept when the run starts, and every resume reads that text; each `workflow()` child is kept the first time it is read |
| Node | One `agent()` call of a run | Named by its content identity and its occurrence among identical calls, so a resumed run names it as the run before did |
| Node Trigger | One attempt of a node, on the node's Thread | Senderless, unaddressed and not from a person; its text is the prompt, followed by the schema instruction when the call has a schema; `meta` carries `cwd`, `pair`, `labels`, the run and the node |
| Journal | The run's lines in the interpreter's journal format | One `kv` record per line, written as the line is; nothing else records a node |

## Settings a deployment gives it

The plugin's Config holds machine settings, set on the row `dsh-superagent-workflow` of a profile's `cordis.patch.yml`. Changing any key but `pollMs` restarts the plugin, which resumes every run from its journal:

| Key | Default | Meaning |
| --- | --- | --- |
| `pollMs` | 2000 | How often a node that waits reads its Ticket; a change applies at the next poll, without a restart |
| `concurrency` | 16 | `agent()` calls of one run in flight; the Executor's `maxWorkers` still caps the Tickets that run |
| `maxAttempts` | 1 | Attempts at each call, each a new Trigger; with 1, a failed node or a reply that does not match its schema is `null` |
| `pair` | empty | The compute pair of a run that names none; empty leaves it to the Executor |

A node is a senderless Trigger, so the gate admits it only through the Source's admission table, and only as an inferred candidate. Three settings make the next node proceed by default; the Source sets none of them:

- `eval.mode` is `auto`, so inferred candidates may be accepted;
- `policy.sources.workflow.admission.workflow.unlistedUnaddressed` is `inferred`; without it every node is ignored with `admission_ignored`;
- an enabled rule that accepts workflow nodes, such as `workflow-node`, whose instruction says that a node proceeds unless other work should go first, and that a held node is released with `orchestrator_trigger_requeue`.

## Starting and reading runs

The kind adds two main-Session tools. They reach the main Session when the plugin registers the kind and leave it when the plugin stops.

| Tool | Does |
| --- | --- |
| `orchestrator_workflow_start` | Starts `script` in the absolute directory `cwd` with `args` and `pair`. A repeated `trigger_id` with the same script, directory and arguments returns the run it started. It refuses a relative or missing directory, a script it cannot read, and a script whose `meta` is invalid |
| `orchestrator_workflow_status` | One run, or the newest runs, with each node `waiting`, `offered`, `held`, `ticket`, `done` or `null`, and its latest Trigger and its Ticket once it has them. A node a resumed run answered from its journal is `done` or `null` as its journal line says. A node's `usage` and the run's `usage` give the tokens its workers used (see below) |

## The window

The main Session assesses node candidates as it assesses any inferred candidate. It never sequences work by stopping a Ticket.

| Act | How |
| --- | --- |
| Proceed | Accept the candidate; the Ticket launches when a worker slot is free, oldest first |
| Hold | Ignore the candidate with a reason; the node waits, and its run with it |
| Release | `orchestrator_trigger_requeue` with the node's Trigger: the same Trigger goes to a fresh Eval |
| Other work first | Accept the other work now and hold the node |
| No answer | An Eval that expires twice more is recorded unavailable; the node waits as a held one does, until it is requeued |

## Results, failures and resume

- A node's result is the summary of its Ticket's `ready` report, verbatim, once the Ticket ended completed; a node with a schema parses it as one JSON value, inside one code fence at most.
- A node has no answer when that summary is no JSON value and the node has a schema, or when the summary only says the unit exited 0, which the dshd Executor reports for a worker that gave no final answer. The interpreter treats no answer as it treats any: it tries the node again while attempts remain, else the node is `null`, with `no structured output` or `no text output` in its journal line.
- A Ticket that ends otherwise, or whose worker reports `failed` or `blocked`, makes the node `null` with the reason in its journal line. A resumed run answers that line with the same `null`, and never raises the node again.
- At start, the plugin resumes every run that has not ended. A node with a result or a failure in the journal answers from it. A node whose Trigger the Engine already has waits for that Trigger's Ticket, and one whose Trigger never reached the Engine raises it once.
- When the plugin stops, every node that waits parks: its run writes nothing more until the next start.
- A node's `usage` is what its workers used, in DSH's usage names (`inputTokens`, `outputTokens`, and `totalTokens`, `cacheReadTokens`, `cacheWriteTokens` or `reasoningTokens` when the provider reports them). The dshd Executor sums, once a unit ended, the usage on each `step_end` status its headless run printed, which dsh takes from the step's `assistant/message` in the worker's Session, and keeps it on the Assignment's binding. It is known only when the lines it reads reach back to the run's start and every step printed its usage. The run's `usage.total` sums the nodes measured, keeping a bucket only when each of them reports it, and `unmeasured_nodes` counts the nodes with an ended unit whose usage is not known, which is every node on an Executor that records none.
- A run's journal reads back as one JSON line per record: `SELECT value FROM kv WHERE key LIKE 'workflow-journal:<run>:%' ORDER BY key`. The script it ran is the record `workflow-script:<sha256>`.

## Not supported

| Not supported | Why |
| --- | --- |
| Token budgets | Usage is measured, not limited: the interpreter's budget is not set, and a node's tokens are not journaled |
| A call's `model` and `effort` | Recorded in the Trigger's `meta`; nodes run on their pair |
| Nesting deeper than one `workflow()` | The interpreter's limit |
| A run started by a Scheduled item's own key | A Scheduled nudge asks the main Session, which starts the run with the tool |
