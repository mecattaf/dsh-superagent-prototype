/** The workflow Source's records in the Store: its runs, their journals line by line, and the scripts they were started with. */
import { family, KV } from '../kv.ts'
import { parseJournal, type JournalEvent, type JournalSink, type LoadedJournal } from '../workflow/index.ts'
import type { SourceContext } from './host.ts'

/** One journal line, in the interpreter's journal format. */
export type JournalLine = JournalEvent
/** A `workflow()` child a run resolved: the script it read and the SHA-256 it is kept under, so a resumed run reads the same child. */
export interface NestedPin { path: string; sha256: string }
/**
 * A workflow run: the script it runs, by path and by the SHA-256 of the text it was started with; the directory each node runs
 * in; its arguments and compute pair; the trigger it was started for; how it ended; and `seq`, the journal lines written so far.
 */
export interface WorkflowRun {
  id: string
  name: string
  scriptPath: string
  scriptSha256: string
  cwd: string
  args?: unknown
  pair?: string
  requestedBy?: string
  state: 'running' | 'completed' | 'failed'
  startedAt: string
  endedAt?: string
  result?: unknown
  error?: string
  seq: number
}
/** What the Store side of the workflow Source reads and writes through. */
export type WorkflowState = Pick<SourceContext, 'state' | 'atomic'>

const lineKey = (seq: number): string => String(seq).padStart(6, '0')
/** The keys of one run's journal, which share the run's prefix. */
const journalOf = (run: string) => family<JournalLine, [line: string]>(KV.workflow.journal(run, ''))

/**
 * The journal of one run in the Store: each line is its own `kv` record, written with the run's line count in one transaction,
 * so a stopped process keeps every line it wrote and a resumed run reads them back in order. Once `signal` aborts, it writes
 * nothing more.
 */
export class KvJournal implements JournalSink {
  constructor(private readonly store: WorkflowState, private readonly run: string, private readonly signal?: AbortSignal) {}
  append(event: JournalEvent): void {
    if (this.signal?.aborted) return
    this.store.atomic(() => {
      const run = this.store.state.get(KV.workflow.run(this.run))
      if (!run) throw new Error(`workflow: run ${this.run} has no record`)
      this.store.state.set(KV.workflow.journal(this.run, lineKey(run.seq)), event)
      this.store.state.set(KV.workflow.run(this.run), { ...run, seq: run.seq + 1 })
    })
  }
  /** The run's journal as the interpreter's text format: one JSON line per record, in the order they were written. */
  static text(store: WorkflowState, run: string): string {
    return store.state.keys(journalOf(run)).sort().map(name => `${JSON.stringify(store.state.get(name))}\n`).join('')
  }
  static load(store: WorkflowState, run: string): LoadedJournal { return parseJournal(KvJournal.text(store, run)) }
}
