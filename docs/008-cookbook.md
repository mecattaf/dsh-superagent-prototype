# 008 Cookbook

This cookbook shows how to extend dsh-superagent, and how to run its work on dshd, from a scheduler and from workflow scripts. It uses the terms in [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md), and the components in [007 Architecture](007-architecture.md).

## Add a Source

This recipe implements a Source kind called `webhook`. It reads an imaginary message queue through an invented CLI, `hookq`, and converts messages to Triggers. All other interfaces are part of dsh-superagent.

The implementation has four responsibilities: translate events, define receiving and authorization rules, provide replies and context, and maintain a polling loop. The numbered steps build those pieces in order.

The example assumes this CLI contract:

- `hookq pull --after <n> --json` prints the messages after position `n`, oldest first: `{"me": "<the agent's id on the queue>", "items": […], "next": <position>}`. An item has `id`, `conversation`, `thread` (the id of the message that started its thread, absent on that message), `sender` with `id` and `bot`, `mentions_me`, `text`, `at` and `url`.
- `hookq reply --conversation <id> --to <message id> --key <key> --text <text>` replies under a message, once per key. For a conversation that was deleted it fails with `{"error": {"code": 410, "message": "…"}}` on standard error.
- `hookq thread --conversation <id> --root <message id> --json`, with `--after <cursor>` for a later page, prints a page of a thread, oldest first: `{"items": […], "next": "<cursor>"}`, without `next` on the last page.

Put the kind and its plugin entry in `src/sources/webhook.ts`, following `src/sources/github.ts`. If the Source grows, split translation, Channel and polling code into separate modules as the Feishu Source does.

### 1. Map the events onto the domain

Choose stable mappings before writing code. Trigger ids, Thread ids and Channel addresses are persisted, so changing them later can disconnect existing records.

| Concept | For the webhook queue |
| --- | --- |
| Trigger | One message |
| Thread | A message and the replies to it in one conversation: `<conversation>:<id of the first message>` |
| Actor | The sender's id on the queue, as the allowed list names it |
| Channel address | The conversation and the message a reply goes under |
| Receiving scope | A conversation, with its own row in the admission table |

### 2. Configuration: schema, fields, facts and health

The module imports what the steps below use:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
```

```ts
const ConfigSchema = z.object({
  conversations: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    listen: z.enum(['mentions', 'all']),
  }).strict()).default([]),
  pollSeconds: z.number().int().min(10).max(3600).default(30),
}).strict()
export type WebhookConfig = z.infer<typeof ConfigSchema>

export const webhookKind: SourceKind<WebhookConfig> = {
  kind: 'webhook',
  title: { zh: 'Webhook 队列', en: 'Webhook queue' },
  description: { zh: '接收 webhook 队列里下列对话的消息。', en: 'Receives the messages of these conversations from the webhook queue.' },
  schema: ConfigSchema,
  fields: [
    { key: 'conversations', type: 'rows', label: { zh: '接收的对话', en: 'Conversations' }, columns: [
      { key: 'id', type: 'text', label: { zh: '对话', en: 'Conversation' }, pattern: '[a-z0-9-]+' },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [
        { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: ['webhook'],
  // find, scope, channel, threadContext, policy and environment follow in the next steps.
}
```

- `kind` is the stable Source id. It appears in Trigger `source`, Thread-key prefixes, the `source:webhook` settings block and the Source Policy.
- `schema` validates stored configuration and supplies defaults. Before an operator saves an instance, the registry creates an enabled instance from those defaults. Make defaults receive nothing; this example defaults to no conversations.
- `fields` generates the Source settings form without custom panel code. A `rows` field edits entries keyed by its first column; `advanced` hides less common settings. Implement `refreshLabels` if the Source can resolve ids to display names. Save those names under `KV.sources.labels(kind)`. Columns with `choose` and `refresh` can then offer them.
- Optional `facts(deployment)` displays values derived by setup, such as the account behind a CLI. Setup currently checks only GitHub and Feishu fields listed in `SETUP_FIELDS`, so this example supplies no facts.
- `health` declares the Source's health entries, initially `starting`. Registration claims each name and refuses collisions with entries such as `runtime`, `reply`, `worker` or effect kinds. Use the kind's name and reserve `sync:<id>` for Policy syncs. An `error` makes the status script exit 2 and the hourly check notify the operator, so report it only when human action may be needed.

### 3. Translate a message into a Trigger

Validate CLI responses before converting them:

```ts
/** One message as `hookq pull` and `hookq thread` print it. */
const MessageSchema = z.looseObject({
  id: z.string().min(1), conversation: z.string().min(1), thread: z.string().optional(),
  sender: z.looseObject({ id: z.string(), bot: z.boolean().default(false) }), mentions_me: z.boolean().default(false),
  text: z.string(), at: z.string(), url: z.string().optional(),
})
type QueueMessage = z.infer<typeof MessageSchema>
/** The answer of `hookq pull`, whose items are read one by one, and of `hookq thread`. */
const PageSchema = z.looseObject({ me: z.string(), items: z.array(z.unknown()), next: z.number().int() })
const ThreadPageSchema = z.looseObject({ items: z.array(MessageSchema), next: z.string().optional() })
```

```ts
/** The Trigger of one queue message; the agent's own messages produce none. */
export function webhookTrigger(message: QueueMessage, me: string): Trigger | undefined {
  if (message.sender.id === me) return undefined
  const thread = `${message.conversation}:${message.thread ?? message.id}`
  return {
    id: key('webhook', message.id),
    source: 'webhook',
    threads: [{ source: 'webhook', id: thread }],
    actor: { source: 'webhook', id: message.sender.id },
    human: !message.sender.bot,
    ...(message.mentions_me ? { addressed: 'mention' as const } : {}),
    at: message.at,
    text: message.text,
    channel: { source: 'webhook', thread: `webhook:${thread}`,
      address: { conversation: message.conversation, message: message.id, ...(message.url ? { url: message.url } : {}) } },
    ...(message.url ? { url: message.url } : {}),
    meta: { conversation: message.conversation, messageId: message.id, root: message.thread ?? message.id },
  }
}
```

- **Stable ids.** Derive the Trigger id from the queue id through `key`. `Engine.receive` returns `duplicate` for stored ids, and duplicate accepts create only one Ticket. Re-reading messages is therefore safe. To treat edits as new events, include an edit version in the id, as GitHub does with comment `updated_at`.
- **Threads.** The first Thread is primary and owns the Eval. Additional Threads add Correlation context. The Source chooses the id; its full key is `webhook:<id>`.
- **Sender.** Use Source-native ids in `actor`. Set `human: false` for bots and CI. Listed bots can only become inferred candidates. An empty actor id, as for CI, uses the admission cell for unlisted, unaddressed senders. Set `addressed` to `mention` or `direct` only when the message actually addresses the agent; this gives an allowed person's message explicit strength. Never produce a Trigger for the agent's own message.
- **Reply destination and metadata.** `channel` identifies where replies go; `url` links to the source message. `channel.thread` groups messages for ordered delivery: a Ticket's later messages wait behind its earlier ones until an earlier message has failed three times. Other Tickets do not wait. Keep Source-specific fields in `meta`, such as the receiving conversation and Thread root. Both `meta` and `text` are untrusted data, not authorization.

Agents can read the new kind through `orchestrator_read trigger/<id>` and `thread/<key>`. These expose message text, disposition and neighboring Triggers. A new kind does not automatically receive a built-in skill, resources for original service records or pull-request binding.

Text search works without extra code. Implement `find(query)` when people use Source-specific references such as message ids, URLs or `#12`. Return the Thread keys and search terms those references identify:

```ts
  find: query => ({ threads: [], terms: [...new Set(query.match(/\bm[0-9]+\b/g) ?? [])] }),
```

Here a queue message id in the query, such as `m42`, searches the Triggers for it.

### 4. What the Source receives: scope

```ts
  scope({ meta }, config) {
    const conversation = config.conversations.find(item => item.id === meta.conversation)
    if (!conversation) return { listened: false, reason: 'conversation_not_listed' }
    return { listened: true, observed: conversation.listen === 'all', row: conversation.id }
  },
```

The Engine calls `scope` through `SourceRegistry` for each incoming Trigger. Out-of-scope messages are stored as filtered with their reason and create no Thread. Pass messages to `receive` rather than silently dropping them in the polling loop, so the panel can explain filtering.

`observed: true` means the Source receives unaddressed messages in that scope, allowing admission-table decisions for them. `row` identifies the corresponding admission row.

Revalidation calls `scope` with the Mandate's stored metadata. Make it depend only on `meta` and configuration. Resuming requires `listened`, not `observed`. Without `scope`, a kind receives every Trigger it produces but observes none.

### 5. Replies: the Channel

```ts
  channel: {
    allowed: (address, config) => config.conversations.some(item => item.id === address.conversation),
    send: sendWebhook,
    link: address => ({ url: address.url ?? '',
      label: { zh: `Webhook 对话 ${address.conversation}`, en: `Webhook conversation ${address.conversation}` } }),
  },
```

```ts
export async function sendWebhook(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { conversation, message: to } = message.channel.address
  if (!conversation || !to) throw new Error('Missing webhook reply target')
  try {
    await host.commands.run('hookq', ['reply', '--conversation', conversation, '--to', to, '--key', message.id,
      '--text', message.text])
    return 'sent'
  } catch (error) {
    if (error instanceof CliError && error.code === 410) return 'gone'
    throw error
  }
}
```

- **Idempotent sends.** Outbox calls `SourceRegistry.send`, which invokes `channel.send`. Messages wait while the Source plugin is unloaded. A send may fail after the remote service received it, so retries must not duplicate messages. Use `message.id` as an idempotency key: `hookq` supports `--key`; GitHub stores a hidden comment marker; Feishu accepts an idempotency key.
- **Permanent versus retryable failure.** Return `sent` on success and `gone` only when delivery is permanently impossible, such as the example's 410. A gone message is retained as dropped and never queued again; it appears in `GET sources` and on the Source page. Throw for other failures so Outbox retries after 5 seconds, doubling to 300 seconds. `CliError.code` is the code reported by the CLI output.
- **Allowed destinations.** `allowed(address, config)` checks only the saved address and current configuration. Put every required fact in the address; for example, Feishu records whether the chat is direct. A destination no longer listened to is dropped, while a disabled Source leaves messages waiting. Without `allowed`, all addresses are permitted while the Source is enabled.
- **Links.** `link(address, links)` returns the URL and label the panel displays through `SourceRegistry.link`.

### 6. Thread context for assessments

```ts
  threadContext: {
    messageId: trigger => String(trigger.meta.messageId ?? ''),
    // A queue thread is flat: its root, and the message a reply answers, are on its first page, as on GitHub.
    read: async (commands, trigger, _part, cursor) => {
      const page = ThreadPageSchema.parse(JSON.parse(await commands.run('hookq', ['thread', '--conversation',
        String(trigger.meta.conversation), '--root', String(trigger.meta.root), '--json', ...(cursor ? ['--after', cursor] : [])])))
      const messages = page.items.map(item => ({ id: item.id, from: item.sender.id, at: item.at, text: item.text,
        ...(item.sender.bot ? { bot: true as const } : {}), ...(item.url ? { url: item.url } : {}) }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { messages } }
    },
  },
```

Proactive assessment needs the conversation around a Trigger. `orchestrator_eval` reads an initial window; `orchestrator_eval_read` expands pages, the root or the parent message. Implement the optional `threadContext` interface to provide these reads:

- `read(commands, trigger, part, cursor, config)` returns a `ContextPart`. Its `messages` use `ContextMessage`: `{id, from, at, text}` plus applicable `bot`, `deleted`, `reply_to`, `url`, `path` and `line` fields. `next` is omitted on the last page. `body` is the content shown to the assessing Session, here the same messages. Optional `status` can describe special results such as Feishu's `chat_neighbours`. `part` is `thread`, `root` or `parent`.
- `messageId(trigger)` finds the Trigger's own message among them.
- `images(text)` and `image(…)` are for a kind whose messages carry images, as Feishu's do; the example leaves them out.

A kind without `threadContext` gives assessments no Thread context; the Trigger's own text stays readable.

If messages reply to earlier messages, add `repliesTo(trigger)`. It returns the corresponding Trigger id, allowing follow-up notices and worker Inputs to show the replied-to message when stored. For example, if `hookq` supplies `reply_to` and translation stores it as `meta.replyTo`:

```ts
  repliesTo: trigger => typeof trigger.meta.replyTo === 'string' ? key('webhook', trigger.meta.replyTo) : undefined,
```

### 7. Who may ask: the Source's part of the Policy

```ts
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict())
      .default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' }, columns: [
      { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的人在消息里 @ 智能体。', en: 'Someone on the list mentions the agent in a message.' },
    rows: stored => ConfigSchema.parse(stored).conversations.map(conversation => {
      const all = conversation.listen === 'all'
      return { id: conversation.id, label: conversation.id, note: all ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
        cells: { listedUnaddressed: all, unlistedAddressed: true, unlistedUnaddressed: all } }
    }),
  },
```

- `schema` validates the Source Policy, including `allowed` sender ids. Id comparison is case-insensitive. Admission tables are validated separately and shared across kinds. This Policy part is saved at `policy.sources.webhook` and contributes to the Policy version.
- `fields` generates the form under **Eval → On each Source**, beginning with `allowed`. `explicit` explains how to address the agent. Optional `unnamed: {person, bot}` supplies display labels for opaque ids such as Feishu's `ou_…`; this example omits it because queue ids are readable names.
- `rows(config)` lists admission scopes and their available cells. Each row id must match the `row` returned by `scope`. Unaddressed-message cells are available only where the Source observes those messages. Kinds without `rows` use default cells.
- Optional `bots` lists bots eligible for inferred candidacy, using the same entry shape as `allowed`. Without it, no bot is admitted.
- Optional `sync: {label, ready(part), run(host, part, signal)}` refreshes membership at startup and on **Sync now**. Feishu uses chat membership. Failures appear under `sync:<id>` and retry after one minute, doubling to one hour until successful.

### 8. Variables for the Executor

```ts
  environment: {
    variables: [{ key: 'DSH_SUPERAGENT_WEBHOOK_CONVERSATION', description: {
      zh: '接下工单的 webhook 对话；工单不是从这个来源来的时为空',
      en: 'The webhook conversation that started the ticket; empty when the ticket did not start on this Source' } }],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEBHOOK_CONVERSATION: trigger?.source === 'webhook' ? String(trigger.meta.conversation ?? '') : '' }),
  },
```

Execution settings show declared `variables` beside the prepare command even when the Source is disabled. While enabled, `values` supplies Ticket-specific values using deployment, configuration and the originating Trigger.

The prepare command reads environment variables; the worker reads their values in its instructions. Use the `DSH_SUPERAGENT_<KIND>_…` prefix, return an empty value for Tickets from another Source, and never include credentials. Mark a variable `ticket: true` when it describes the Ticket a Session works on, as the Executor's `DSH_SUPERAGENT_DIR` does: the main Session, which works on none, is then not shown it.

### 9. The plugin entry and its loop

```ts
export const name = 'dsh-superagent-webhook'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(webhookKind), 'webhook: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, webhookKind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loop becomes the Source's health.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('webhook', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
```

The plugin injects `orchestrator`. Its first effect registers the kind and unregisters it on disposal. The second runs the polling loop with a `SourceContext`. Disposal aborts the loop and awaits completion, including during application stop or restart.

```ts
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then the Source reads nothing.
  if (!ctx.configured()) { ctx.report('webhook', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<WebhookConfig>('webhook')
    if (!config) ctx.report('webhook', health('paused', 'sourceOff'))
    else {
      const at = new Date().toISOString()
      try {
        const { read, unreadable } = await pollQueue(ctx, signal)
        failures = 0
        ctx.report('webhook', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at })
      } catch (error) {
        failures += 1
        // One network failure is retried on the next round; three in a row need a person.
        if (!signal.aborted && failures >= 3) {
          ctx.report('webhook', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    await delay((config?.pollSeconds ?? 30) * 1000, undefined, { signal }).catch(() => {})
  }
}

/** Read the queue after the cursor, take in each message, then move the cursor past them. */
export async function pollQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const after = ctx.state.get(KV.webhook.cursor) ?? 0
  const output = await ctx.commands.withSignal(signal).run('hookq', ['pull', '--after', String(after), '--json'])
  const page = PageSchema.parse(JSON.parse(output))
  let unreadable = 0
  for (const item of page.items) {
    if (signal.aborted) throw new Error('The webhook Source stopped during the read')
    const message = MessageSchema.safeParse(item)
    if (!message.success) { unreadable++; continue }
    const trigger = webhookTrigger(message.data, page.me)
    if (!trigger) continue
    await ctx.receive(trigger)
    const conversation = { label: { zh: '对话', en: 'Conversation' }, value: message.data.conversation }
    for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { facts: { conversation } })
  }
  ctx.state.set(KV.webhook.cursor, page.next)
  return { read: page.items.length, unreadable }
}
```


- **Setup and the switch.** Wait for `ctx.ready`, and read nothing while `ctx.configured()` is false. Read `ctx.config(kind)` on every round: it is undefined while the Source is off.
- **Cursors.** Store read positions in `ctx.state` using typed entries in `KV` (`src/kv.ts`), such as `webhook: {cursor: record<number>('webhook-cursor')}`. `tests/store.spec.ts` requires key literals to appear only in that registry. External packages can define keys with exported `record` and `family`. Setting `undefined` removes a record; `ctx.atomic` groups writes in a transaction.

  Advance a cursor only after every covered Trigger has been stored. An interrupted round leaves the cursor unchanged; stable ids make replay safe. For timestamp cursors, `cursorAt(started)` from `src/sources/poll.ts` subtracts five seconds to allow for late remote writes.
- **Thread metadata.** After receiving a Trigger, call `ctx.threads.describe(key, {label, url, facts})` to populate its display information. `ctx.threads.patch(key, meta)` delegates to `threads.patchMeta`, setting Source-owned keys or removing them when the value is `undefined`. Both ignore absent Threads, including those of filtered Triggers.
- **Per-item errors.** Count malformed items and continue rather than failing the entire batch. `validItems(item, list, tally)` in `src/infra/commands.ts` supports this pattern. For independently polled Threads, use `pollThreads` from `src/sources/poll.ts`; it records each failure as `pollError`. Its `polled` predicate keeps live subscriptions and a two-week window after the later of the last Trigger and Ticket end.
- **Health.** Write only declared entries through `ctx.report`. `health(state, code, values)` provides fixed messages such as `setupPending`, `sourceOff` and `pollFailures`. Count consecutive failures before reporting `error`.
- **Abort.** Pass the signal to `ctx.commands.withSignal(signal)` and to `delay`, and check it between items, so a stop or a restart ends the loop at once.

This example does not send Source-originated notices. A Source that needs them calls `ctx.notify`; Outbox delivers them like other replies.

It also does not bind Threads to Ticket completion. Use `ctx.tickets.bindThread` and `threadClosed` only when a Source's Thread lifecycle determines whether work is done, as GitHub pull requests do. The Engine still decides when the Ticket ends.

### 10. Register the plugin

Build the module as its own entry in `tsdown.config.ts`:

```ts
entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
  'webhook-watch': 'src/sources/webhook.ts' },
```

Then export the built file in `package.json` by adding `"./webhook-watch": "./lib/webhook-watch.js"` to `exports`, and add the plugin to the `insert` list of the bundle's `cordis.patch.yml`, disabled, as Feishu is:

```yaml
    - id: dsh-superagent-webhook
      name: dsh-superagent/webhook-watch
      disabled: true
```

Enable the plugin in a profile's `cordis.patch.yml` with `id: dsh-superagent-webhook` and `disabled: false`. Build and restart. The new Source appears in Sources settings and under **Eval → On each Source**.

Add its module and spec to the module and test tables in [007 Architecture](007-architecture.md). `tests/docs.spec.ts` checks that both indexes are complete.

### 11. Tests

Create `tests/webhook.spec.ts` using the pattern in `tests/sources.spec.ts`: a real Store in a temporary directory, a `SourceRegistry` with `HealthBoard`, an Engine with stand-in ports, and a `SourceContext` from `sourceContextOf`.

Mock CLI calls by spying on `Commands.run`. Also spy on `withSignal`, because it normally returns a new `Commands` instance.

```ts
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'webhook-')), 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    sources: { webhook: { enabled: true, config: { conversations: [{ id: 'ops', listen: 'mentions' }] } } },
    policy: { sources: { webhook: { allowed: [{ id: 'alice' }] } } },
  }))
  // The registry claims the kind's health entries on the board, where the test reads them.
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(webhookKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // The Source's own notices go to the outbox, which keeps their receipts and sends nothing here.
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  return { ...deps, store, engine, commands, receive, health: board.all, ctx: sourceContextOf(deps, webhookKind) }
}
/** The queue as `hookq` answers it. */
function queue(h: ReturnType<typeof host>, answer: () => unknown) {
  vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
  return vi.spyOn(h.commands, 'run').mockImplementation(async () => JSON.stringify(answer()))
}

it('takes in what the queue holds after the cursor, once, and moves the cursor after it', async () => {
  const h = host()
  queue(h, () => ({ me: 'agent', items: [message('m1'), { id: 'broken' }, message('m2', { conversation: 'elsewhere' })], next: 3 }))
  expect(await pollQueue(h.ctx, new AbortController().signal)).toEqual({ read: 3, unreadable: 1 })
  expect(await h.receive.mock.results[0]!.value).toBe('stored')
  expect(await h.receive.mock.results[1]!.value).toBe('filtered')
  expect(h.store.get(KV.webhook.cursor)).toBe(3)
  // An allowed sender who mentions the agent makes an explicit request.
  expect(h.engine.candidate(key('webhook', 'm1'))?.strength).toBe('explicit')
  await pollQueue(h.ctx, new AbortController().signal)
  expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
  h.store.close()
})
```

`message(id, fields)` builds a queue item. Cover at least:

- the translation: a stable id, the Thread, the actor, `human` and `addressed`, and no Trigger for the agent's own message;
- a round: Triggers stored once, one outside the scope `filtered`, the cursor moved after them, an allowed sender's mention evaluated as `explicit`;
- a round cut short, which keeps its cursor;
- `send`: `sent`, `gone` for a 410 only, and a throw for any other failure, with the CLI's error built by `commandError`;
- the Thread context: the messages of a page and the cursor of the next, as `tests/registry.spec.ts` reads a kind's Threads through `SourceRegistry.threadContext`;
- the plugin: `apply` registers the kind and reports `setupPending` while setup waits, its disposers unregister the kind, and a failure that escapes the loop becomes the Source's health instead of an unhandled rejection;
- the Source's part of the Policy and its admission rows, as `tests/registry.spec.ts` and `tests/policy.spec.ts` check the Feishu Source's.

### Checklist

1. Map Triggers, Threads, actors, Channel addresses and receiving scopes.
2. Write the kind: `schema`, `fields`, `health`, and `facts` if setup derives any.
3. Translate events into Triggers with stable ids, and drop the agent's own.
4. Decide what the Source receives in `scope`, from `meta` alone.
5. Give it a Channel whose `send` posts each message once and answers `gone` only when the conversation can never receive it.
6. Give assessments its Thread context, if it can read a Thread.
7. Give it a part of the Policy with `allowed` and the admission rows.
8. Register its execution environment variables.
9. Write the plugin entry and a loop that waits for setup, follows the switch, moves cursors after `receive`, keeps errors per item, reports health and stops on abort; name the cursors in `KV`.
10. Add the build entry, the export and the `cordis.patch.yml` insert, and list the module and its spec in the tables of 007.
11. Test it as `tests/sources.spec.ts` tests the other Sources.

## Add main-Session tools to a Source

A Source kind can give the main Session tools of its own, for work a person asks the main Session for rather than sending it through the Source; the workflow Source's `orchestrator_workflow_start` is one. A kind's tools reach the main Session when the kind registers, although Source plugins register after the main Session was decorated, and leave it when the kind unregisters.

Continue the `webhook` example with a tool that reads the queue position:

```ts
import { sourceTool, type SourceTool } from './kind.ts'

/** The main Session's webhook tools. */
export const webhookTools = (ctx: SourceContext): SourceTool[] => [
  sourceTool({
    name: 'orchestrator_webhook_position',
    description: 'Read how far the webhook Source has read its queue: the position after the last message it took in.',
    schema: z.object({}).strict(),
    execute: async () => ({ position: ctx.state.get(KV.webhook.cursor) ?? 0 }),
  }),
]
```

Build the kind with its tools in the effect that registers it, so they use that effect's `SourceContext`:

```ts
  ctx.effect(() => ctx.orchestrator.sources.register({ ...webhookKind, tools: webhookTools(sourceContext(ctx.orchestrator, webhookKind)) }),
    'webhook: source kind')
```

- **Names.** Each name starts with `orchestrator_<kind>_`, or `SourceRegistry.register` refuses the kind. The prefix keeps a kind's tools apart from the host's and from each other's, and inside the `orchestrator_` names that bridges to other agent runtimes pass.
- **Schema.** `sourceTool` types `execute` by a strict zod object; describe its fields as the host's own tools do. `execute` returns a JSON value, which the main Session reads as the tool's output; a thrown error is the tool's refusal.
- **State.** A tool changes state only through the `SourceContext`, as the kind's loop does: it raises a Trigger with `receive`, never a Ticket.
- **Tests.** Register the kind on `startRuntime()` from `tests/fixtures/host.ts` and call the tool on the main Session with `runTool`, as the tests of a kind's main-Session tools in `tests/sources.spec.ts` do: an unprefixed name is refused, and the tool leaves the main Session when the kind unregisters.

### Checklist

1. Name each tool `orchestrator_<kind>_<verb>`.
2. Type it with `sourceTool` and a strict schema whose fields are described.
3. Build the kind with `tools` in the effect that registers it.
4. Change state only through the `SourceContext`.
5. Test the refused name, a call on the main Session, and the removal when the kind unregisters.
6. Name the tools under Main Session tools in [007 Architecture](007-architecture.md).

## Run Assignments as dshd units

With `executor: dshd`, each Assignment runs as one dshd headless unit: a DeepSeek Harness process of its own, with its own profile, that goes on while dsh-superagent restarts. Use it when workers need another provider or harness than the main Session, or must outlive the process that started them. [006 Deployment](006-deployment.md) lists the keys.

### 1. Make a headless profile per pair

A pair is a name for one way to run a worker: a headless profile whose bundles and model decide the provider and the harness. Create each one under the `DSH_HOME` that dsh-superagent runs with. A pair's profile that loads this bundle, for example for its agent presets, sets `engine: false` on its `dsh-superagent` row, so the worker opens no state of its own.

### 2. Configure the executor

In the profile that runs dsh-superagent:

```yaml
- id: dsh-superagent
  config:
    stateDir: <absolute path>
    executor: dshd
    dshd:
      pairs:
        <pair>: { profile: <headless profile> }
        <second pair>: { profile: <another headless profile>, maxWorkers: 1 }
      defaultPair: <pair>
```

`defaultPair` must be one of `pairs`, or startup stops and the log names the key. Give a pair whose model serves one request at a time `maxWorkers: 1`; Execution's `maxWorkers` caps all units together.

### 3. Give units their environment

A unit starts from an empty environment: the `passEnv` names of dsh-superagent's process, then `dshd.env`, then its pair's `env`. dshd records every value with the unit, so a credential reaches a worker through a file or a wrapper its profile reads, never as a value here. Keep `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` in `passEnv`, or dshd cannot reach the user's service manager.

### 4. Choose the directory and the pair per Trigger

A Source chooses where and on what a Ticket's units run through its Trigger's `meta`:

| Key | Value | Effect |
| --- | --- | --- |
| `cwd` | An absolute path | The units' working directory; it must exist at launch |
| `pair` | A key of `dshd.pairs` | The units' pair; an unknown one fails the Ticket |
| `labels` | Strings by `superagent.*` key | Added to the units' labels |

The scheduled Source sets `cwd`, and `pair` when a record names one; the workflow Source sets `cwd` and `labels`, and `pair` when a run names one. Without them a Ticket runs in `dshd.cwd`, else in its directory under the Execution directory, on `defaultPair`.

### 5. Follow the units

Restart dsh-superagent and accept a Ticket. `dshd get <unit>` shows a unit's state and labels, and `dshd read <unit>` its output; the unit's last final answer is the summary of its Ticket's Report. Units go on while dsh-superagent restarts, and its next start adopts them. dshd keeps ended units until someone removes them.

### Checklist

1. Create one headless profile per pair, with `engine: false` where it loads this bundle.
2. Set `executor: dshd`, the pairs and `defaultPair`.
3. Keep secrets out of `dshd.env`, the pairs' `env` and the values `passEnv` copies.
4. Set `meta.cwd`, `meta.pair` and `meta.labels` in the Sources that choose them.
5. Restart, accept a Ticket, and read its unit with `dshd get` and `dshd read`.

## Feed occurrences from an external scheduler

dsh-superagent keeps no clock. A scheduler outside it, such as a timer of the service manager, decides when an item is due and drops one record per due occurrence into the scheduled Source's inbox; the Source turns each into a Trigger. This recipe writes such a producer.

### 1. Enable the Source

Enable `dsh-superagent-scheduled` in the profile, and set what [006 Deployment](006-deployment.md) names under Scheduled occurrences: the `occurrence` admission cell `inferred`, the accept mode `auto`, and a rule that accepts occurrences. The inbox is `<stateDir>/inbox/scheduled` unless `inbox` names another directory; the Source creates it.

### 2. Write one record per occurrence

```json
{"v": 1, "kind": "schedule", "namespace": "team/widgets", "item": "nightly-digest", "name": "Nightly digest",
 "cwd": "/srv/work/widgets", "due": "2026-11-12T02:00:00.000Z", "missed": 0, "revision": "3f9d2b7c1a0e",
 "text": "Summarize the pull requests merged yesterday into notes/digest.md, then commit it.",
 "by": "my-scheduler", "at": "2026-11-12T02:00:04.512Z"}
```

| Field | Rule |
| --- | --- |
| `v` | `1` |
| `kind` | `schedule` for a due occurrence; `manual` for a run someone asked for now, which also carries `run`, a ULID |
| `namespace` | Groups the producer's items, and may contain `/` |
| `item` | A lowercase slug; with `cwd`, it names the item |
| `cwd` | The absolute directory the work runs in; it must exist when the Source reads the record |
| `due` | The occurrence's due instant, with its offset; for a manual run, when it was asked for |
| `missed` | Due instants of the item before `due` that got no record of their own |
| `revision` | 12 hexadecimal digits that change when the item's definition does |
| `text` | The whole task, at most 32 768 characters, frozen when the record is written |
| `pair` | Optional: the compute pair, a key of `dshd.pairs` |
| `name`, `file` | Optional: a display name, and the absolute path of the file the item came from, for people |
| `by`, `at` | Who wrote the record, and when |

The Trigger's id comes from `cwd`, `item` and `due`, or from `run` for a manual record, so a record written twice is stored once. A scheduler that was down needs no backlog: it writes the latest due occurrence and counts the skipped ones in `missed`.

### 3. Drop it in whole

The Source reads only names that end in `.json` and do not start with `.`. Write the record under a dot-name in the inbox, then rename it:

```sh
inbox=<stateDir>/inbox/scheduled
name='team+widgets~nightly-digest@20261112T0200Z'
printf '%s\n' "$record" > "$inbox/.$name.json.tmp" && mv "$inbox/.$name.json.tmp" "$inbox/$name.json"
```

The name without `.json` names the occurrence's Thread. The panel's search finds an occurrence by a name of the form `<namespace>~<item>@<due>`, with each `/` of the namespace written as `+`.

### 4. Read what happened

Within `pollSeconds`, the record moves into `.done/`, or into `.bad/` with an `.error` line that names its fault. The occurrence's Thread is labelled `<namespace>:<item> — <name>`. Of several schedule records of one item read in one round, only the latest runs; the others are stored filtered as `superseded`. Until the Policy admits occurrences, each is only recorded.

### 5. Test the producer against the fixture

Keep a byte-identical copy of `tests/fixtures/scheduled-occurrence-v1.json` in the producer's tests, and check that what it writes for those two cases has the same fields. A change of format is a new `v` with a new fixture on both sides; the Source quarantines any `v` but 1.

### Checklist

1. Enable the entry, the `occurrence` cell, `auto` mode and a rule.
2. Write records of version 1 with a stable `cwd`, `item` and `due`.
3. Count skipped occurrences in `missed` instead of writing each.
4. Write under a dot-name and rename into the inbox.
5. Watch `.done/` and `.bad/`.
6. Test the producer against the shared fixture.

## Run a workflow script

A workflow script turns a job of several steps into Tickets: each `agent()` call is a node, which runs as a Ticket once the main Session accepts it. The script decides the order; the main Session may hold a node, but never stops a running Ticket to reorder work.

### 1. Enable the Source

Enable `dsh-superagent-workflow` in the profile, and set what [006 Deployment](006-deployment.md) names under Workflows: the `workflow` admission cell `inferred`, the accept mode `auto`, and a rule, such as `workflow-node`, that accepts each next node. With the dshd executor each node is one unit in the run's directory.

### 2. Write the script

```js
export const meta = {
  name: 'release-notes',
  description: 'Collect the merged changes, then write the release notes from them',
  phases: [{ title: 'collect' }, { title: 'write' }],
}
phase('collect')
const [fixes, features] = await parallel([
  () => agent('List the bug fixes merged since the last tag, one line each. Reply with the list only.', { label: 'fixes' }),
  () => agent('List the features merged since the last tag, one line each. Reply with the list only.', { label: 'features' }),
])
phase('write')
const notes = await agent(`Write RELEASE-NOTES.md from these lists, then reply with its title and line count.\n\nFixes:\n${fixes}\n\nFeatures:\n${features}`,
  { label: 'notes', schema: { type: 'object', required: ['title', 'lines'], properties: { title: { type: 'string' }, lines: { type: 'number' } } } })
log(`release notes: ${JSON.stringify(notes)}`)
return notes
```

- **Builtins.** `agent(prompt, { label, schema })` returns the node's text, or, with `schema`, the JSON value of its reply; the node's prompt is then followed by an instruction to reply with that JSON only. `parallel` runs thunks together, `pipeline` runs items through stages, `phase` and `log` mark progress, `args` is the value the run started with, and `workflow(name, args)` runs one child script, one level deep.
- **Results.** A node's result is its Ticket's final answer. A node whose Ticket fails, or whose reply is not JSON valid against its schema, is `null`; check for it before using the value.
- **Determinism.** Every resume runs the script again from the top and answers finished nodes from the journal, so the script reads no clock or random value: the interpreter refuses `Date.now()`, `new Date()` and `Math.random()`, and the script's realm holds only the workflow builtins.
- **Prompts.** Each node is a fresh worker that knows only its prompt: say where it works, what it writes and what it replies.

### 3. Try it offline

From a checkout of this repository, after `pnpm install`, `src/workflow/cli.ts` runs a script under a mock backend that calls no model, so `meta`, the builtins and the shape of the run are checked before any Ticket exists. The plugin that `dsh plugin` installs ships only the built `lib/`, not this runner.

```sh
node --experimental-transform-types src/workflow/cli.ts /srv/work/widgets/release-notes.workflow.js --print-result
```

### 4. Start and follow the run

Ask the main Session to run the script, naming it and the directory, for example "Run release-notes.workflow.js in /srv/work/widgets". It calls `orchestrator_workflow_start`, and each node then arrives as an inferred candidate. `orchestrator_workflow_status` shows each node `waiting`, `offered`, `held`, `unavailable`, `ticket`, `done` or `null`. A `held` node was decided without a Ticket, and an `unavailable` one was never assessed, as when the main Session did not answer in time; each also gives `decided_at` and `reason`, and waits until its Trigger is requeued with `orchestrator_trigger_requeue`. The panel labels each node's Thread `<name> · <label>`, and shows its Ticket as any other. A restart resumes every unfinished run from its journal; no finished node runs again.

### Checklist

1. Enable the entry, the `workflow` cell, `auto` mode and a rule.
2. Write `meta`, then the nodes, each with a `label`, and a `schema` where the reply is data.
3. Handle `null` results.
4. Keep the script free of clocks and random values.
5. Run it once under the mock backend.
6. Start it through the main Session, naming the script and the directory, and follow it with `orchestrator_workflow_status`.
