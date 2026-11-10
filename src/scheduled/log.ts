/** The floor's journal grammar (DESIGN 12): one physical line per decision on stderr, `floor: <event> key=value ...`. */
export const FLOOR_EVENTS = ['intake', 'census', 'route', 'default-route', 'defer', 'launch', 'watch-end', 'settle', 'held', 'reject', 'invalid', 'upkeep', 'rm', 'error'] as const
export type FloorEvent = (typeof FLOOR_EVENTS)[number]
export type FloorField = string | number | boolean | null | undefined

/** Formats one line; a value with a space, quote, `=` or newline is JSON-quoted, null prints `-`, undefined is left out. */
export function floorLine(event: FloorEvent, fields: Record<string, FloorField> = {}): string {
  const parts = ['floor:', event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    const text = value === null ? '-' : String(value)
    parts.push(`${key}=${/[\s"=]/u.test(text) || text === '' ? JSON.stringify(text) : text}`)
  }
  return parts.join(' ')
}

/** Writes one line to stderr (journald stores it under `dshd@floor.service`); `write` is injectable for tests. */
export function floorLog(event: FloorEvent, fields: Record<string, FloorField> = {}, write: (line: string) => void = line => process.stderr.write(`${line}\n`)): void {
  write(floorLine(event, fields))
}
