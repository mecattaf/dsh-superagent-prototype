/** Harvest: collect session answer, invocationId and report.json after a dshd run ends (DESIGN 7.6, b.9). */
import { z } from 'zod'
import { floorLog } from './log.ts'

const MAX_ANSWER_BYTES = 8 * 1024 // 8 KiB

/** Caps a string at `maxBytes` on a UTF-8 boundary. */
function capUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8')
  if (buf.length <= maxBytes) return text
  // Walk back to a safe boundary
  let len = maxBytes
  while (len > 0 && (buf[len]! & 0xc0) === 0x80) len--
  return buf.subarray(0, len).toString('utf-8')
}

const ReportSchema = z.object({
  state: z.enum(['done', 'blocked', 'failed']),
  summary: z.string(),
  question: z.string().optional(),
})

export type HarvestReport = z.infer<typeof ReportSchema>

export interface HarvestResult {
  sessionId: string | null
  answer: string
  invocationId: string | null
  report: HarvestReport | null
  source: 'dshd' | 'session' | 'none'
}

export interface HarvestOptions {
  name: string
  runDir: string
  /** Runs `dshd read --json -n 100000 <name>` and returns stdout. */
  exec: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>
  /** Reads a file and returns its content, or null if not found. */
  readFile: (path: string) => string | null
  /** Falls back to the DSH session JSONL for the given sessionId. */
  sessionLog: (sessionId: string | null) => Promise<string>
}

/**
 * Harvests the answer and report for a completed dshd run.
 *
 * 1. Runs `dshd read --json -n 100000 <name>`.
 * 2. If the output has `complete: true`, takes the last line with `type: "final"` (its `text` and `sessionId`).
 * 3. Otherwise falls back to `sessionLog(sessionId)`.
 * 4. Reads `<runDir>/report.json` and validates it with zod; invalid → null + floorLog('error', …).
 */
export async function harvest(opts: HarvestOptions): Promise<HarvestResult> {
  const { name, runDir, exec, readFile, sessionLog } = opts

  let sessionId: string | null = null
  let invocationId: string | null = null
  let answer = ''
  let source: 'dshd' | 'session' | 'none' = 'none'

  // Step 1: run dshd read --json -n 100000 <name>
  const { stdout } = await exec('dshd', ['read', '--json', '-n', '100000', name])

  // Step 2: `dshd read --json` prints one envelope `{name, invocationId, complete, streams, lines}` whose `lines` are the
  // run's output lines, the DSH JSON events among them (FACT: captured from dshd-release 0.2.2-rc.1, 11 Nov). A JSONL
  // stream of events is accepted too.
  let lines = stdout.split('\n').filter(l => l.trim() !== '')
  let complete = false
  let lastFinalLine: Record<string, unknown> | null = null
  try {
    const envelope = JSON.parse(stdout) as Record<string, unknown>
    if (envelope && Array.isArray(envelope['lines'])) {
      complete = envelope['complete'] === true
      if (typeof envelope['invocationId'] === 'string') invocationId = envelope['invocationId']
      lines = (envelope['lines'] as unknown[]).filter((line): line is string => typeof line === 'string')
    }
  } catch {
    // JSONL or plain text
  }

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj['complete'] === true) complete = true
      if (obj['type'] === 'final') lastFinalLine = obj
      // Pick up invocationId from any line that carries it
      if (typeof obj['invocationId'] === 'string' && invocationId === null) {
        invocationId = obj['invocationId']
      }
    } catch {
      // skip non-JSON lines
    }
  }

  if (complete && lastFinalLine !== null) {
    // Extract sessionId from the final line
    sessionId = typeof lastFinalLine['sessionId'] === 'string' ? lastFinalLine['sessionId'] : null
    const rawText = typeof lastFinalLine['text'] === 'string' ? lastFinalLine['text'] : ''
    answer = capUtf8(rawText, MAX_ANSWER_BYTES)
    source = 'dshd'
  } else {
    // Step 3: fall back to session log
    const sessionLog_ = await sessionLog(sessionId)
    answer = capUtf8(sessionLog_, MAX_ANSWER_BYTES)
    source = sessionId !== null || sessionLog_ !== '' ? 'session' : 'none'
  }

  // Step 4: read report.json
  const reportPath = `${runDir}/report.json`
  const rawReport = readFile(reportPath)
  let report: HarvestReport | null = null
  if (rawReport !== null) {
    try {
      const parsed = JSON.parse(rawReport)
      const result = ReportSchema.safeParse(parsed)
      if (result.success) {
        report = result.data
      } else {
        floorLog('error', { name, msg: 'invalid report.json', detail: result.error.message })
      }
    } catch (e) {
      floorLog('error', { name, msg: 'report.json parse error', detail: String(e) })
    }
  }

  return { sessionId, answer, invocationId, report, source }
}
