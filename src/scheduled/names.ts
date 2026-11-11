import { createHash } from 'node:crypto'

/** Regex matching valid dshd instance names: at most 63 bytes, lowercase alnum start/end, alnum/hyphen/underscore middle. */
export const NAME_REGEX = /^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$/

export interface InstanceNameOptions {
  agency: string
  stem: string
  instant: Date | string
  kind?: 'scheduled' | 'now' | 'manual'
  ulid?: string
  rerun?: number
  attempt?: number
}

/** Formats a timestamp into UTC `<yyyymmdd>t<hhmm>z`. */
export function formatInstantUtc(instant: Date | string): string {
  if (typeof instant === 'string') {
    const compactMatch = instant.match(/^(\d{8})t(\d{4})z$/i)
    if (compactMatch) return instant.toLowerCase()
  }
  const d = typeof instant === 'string' ? new Date(instant) : instant
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid instant: ${String(instant)}`)
  }
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  const min = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${day}t${h}${min}z`
}

/**
 * Derives the dshd instance name for a scheduled or run-now occurrence attempt.
 *
 * Pattern:
 * - scheduled: `sch-<agency>-<stem>-<yyyymmdd>t<hhmm>z`
 * - run-now: `now-<agency>-<stem>-<yyyymmdd>t<hhmm>z-<last 6 of ULID, lowercase>`
 * - rerun k >= 1: appends `-r<k>`
 * - `/` in agency id becomes `-`
 * - names over 63 bytes are cut to 63 bytes ending in 4 hex of sha256 of the workflow id (`<agency>:<stem>`)
 * - always matches `^[a-z0-9]([a-z0-9_-]{0,61}[a-z0-9])?$`
 */
export function instanceName(options: InstanceNameOptions): string {
  const rawAgency = options.agency === '~' ? 'master' : options.agency
  const cleanAgency = rawAgency
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9_-]/g, '-')
  const cleanStem = options.stem
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')

  const timePart = formatInstantUtc(options.instant)
  const isNow = options.kind === 'now' || options.kind === 'manual' || Boolean(options.ulid && options.kind !== 'scheduled')

  let baseName: string
  if (isNow) {
    const ulidPart = options.ulid ? options.ulid.slice(-6).toLowerCase() : ''
    baseName = ulidPart
      ? `now-${cleanAgency}-${cleanStem}-${timePart}-${ulidPart}`
      : `now-${cleanAgency}-${cleanStem}-${timePart}`
  } else {
    baseName = `sch-${cleanAgency}-${cleanStem}-${timePart}`
  }

  // Rerun suffix: -r<k> for rerun k >= 1
  const k = options.rerun !== undefined
    ? options.rerun
    : (options.attempt !== undefined && options.attempt > 1 ? options.attempt - 1 : 0)

  let name = k >= 1 ? `${baseName}-r${k}` : baseName

  // If over 63 bytes, cut and end in four hex of sha256 of the workflow id (<agency id>:<stem>)
  if (name.length > 63) {
    const workflowId = `${rawAgency}:${options.stem}`
    const hash4 = createHash('sha256').update(workflowId).digest('hex').slice(0, 4)
    name = `${name.slice(0, 59)}${hash4}`
  }

  return name
}

export interface ScheduledLabels {
  'scheduled.agency': string
  'scheduled.workflow': string
  'scheduled.occurrence': string
  'scheduled.attempt': string
  'scheduled.rev': string
}

export interface LabelsOptions {
  agency?: string
  root?: string
  agencyRoot?: string
  workflow?: string
  workflowId?: string
  occurrence?: string
  instant?: string
  attempt: number | string
  rev?: string
  revision?: string
}

/**
 * Derives the five `scheduled.*` labels for dshd launch.
 * Supports both options object and positional arguments.
 */
export function labels(
  optionsOrAgency: LabelsOptions | string,
  workflow?: string,
  occurrence?: string,
  attempt?: number | string,
  rev?: string,
): ScheduledLabels {
  if (typeof optionsOrAgency === 'string') {
    return {
      'scheduled.agency': optionsOrAgency,
      'scheduled.workflow': workflow ?? '',
      'scheduled.occurrence': occurrence ?? '',
      'scheduled.attempt': String(attempt ?? 1),
      'scheduled.rev': rev ?? '',
    }
  }

  const opts = optionsOrAgency
  return {
    'scheduled.agency': opts.root ?? opts.agencyRoot ?? opts.agency ?? '',
    'scheduled.workflow': opts.workflowId ?? opts.workflow ?? '',
    'scheduled.occurrence': opts.occurrence ?? opts.instant ?? '',
    'scheduled.attempt': String(opts.attempt ?? 1),
    'scheduled.rev': opts.rev ?? opts.revision ?? '',
  }
}
