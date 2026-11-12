# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source and its main-Session tools, running Assignments as dshd units, feeding occurrences from a scheduler, and running a workflow script
- [009 Workflows](docs/009-workflows.md)

## Optional parts

The first four are off until a profile turns them on; [006 Deployment](docs/006-deployment.md) lists their configuration.

- **dshd executor.** With `executor: dshd`, each Assignment runs as one dshd headless unit on a named provider-harness pair, in the working directory its Trigger names. Units go on while dsh-superagent restarts, and its next start adopts them.
- **Inert entry.** With `engine: false`, a profile loads the bundle, for example for its agent presets, without running dsh-superagent: no state, lock, Session or Source.
- **Scheduled occurrences.** The `dsh-superagent-scheduled` Source reads one record per due occurrence from an inbox directory that an outside scheduler writes, and raises one Trigger per occurrence, each on its own Thread.
- **Workflows.** The `dsh-superagent-workflow` Source runs workflow scripts with a vendored copy of Substrate's interpreter: each `agent()` call becomes a Trigger, then a Ticket once the main Session accepts it, and a restart resumes each run from its journal.
- **Source tools.** A Source kind may add main-Session tools named `orchestrator_<kind>_…`; the workflow Source adds `orchestrator_workflow_start` and `orchestrator_workflow_status`.

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
