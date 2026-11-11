import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { instanceName, labels, NAME_REGEX, formatInstantUtc } from '../src/scheduled/names.ts'

describe('C5.6 instanceName & labels', () => {
  it('formats admitted occurrence of master:fleet-nightly at 2026-11-12T00:00:00Z', () => {
    const name = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: '2026-11-12T00:00:00Z',
    })
    expect(name).toBe('sch-master-fleet-nightly-20261112t0000z')
    expect(NAME_REGEX.test(name)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('formats Date instances in UTC', () => {
    const date = new Date(Date.UTC(2026, 10, 12, 0, 0, 0)) // Nov is 10
    const name = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: date,
    })
    expect(name).toBe('sch-master-fleet-nightly-20261112t0000z')
    expect(NAME_REGEX.test(name)).toBe(true)
  })

  it('formats a run-now occurrence with now- prefix and last 6 lowercase ULID characters', () => {
    const name = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: '2026-11-12T00:00:00Z',
      kind: 'now',
      ulid: '01ARYZ6S41YYYYYYYYYY789ABC',
    })
    expect(name).toBe('now-master-fleet-nightly-20261112t0000z-789abc')
    expect(NAME_REGEX.test(name)).toBe(true)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('appends -r<k> for rerun k >= 1 and omits it for initial run', () => {
    const initial = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: '2026-11-12T00:00:00Z',
      rerun: 0,
    })
    expect(initial).toBe('sch-master-fleet-nightly-20261112t0000z')

    const rerun1 = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: '2026-11-12T00:00:00Z',
      rerun: 1,
    })
    expect(rerun1).toBe('sch-master-fleet-nightly-20261112t0000z-r1')
    expect(NAME_REGEX.test(rerun1)).toBe(true)

    const rerun2 = instanceName({
      agency: 'master',
      stem: 'fleet-nightly',
      instant: '2026-11-12T00:00:00Z',
      rerun: 2,
    })
    expect(rerun2).toBe('sch-master-fleet-nightly-20261112t0000z-r2')
    expect(NAME_REGEX.test(rerun2)).toBe(true)
  })

  it('replaces / in agency id with - and normalizes ~ to master', () => {
    const subAgency = instanceName({
      agency: 'mecattaf/crm',
      stem: 'sync-contacts',
      instant: '2026-11-12T00:00:00Z',
    })
    expect(subAgency).toBe('sch-mecattaf-crm-sync-contacts-20261112t0000z')
    expect(NAME_REGEX.test(subAgency)).toBe(true)

    const tildeAgency = instanceName({
      agency: '~',
      stem: 'backup',
      instant: '2026-11-12T00:00:00Z',
    })
    expect(tildeAgency).toBe('sch-master-backup-20261112t0000z')
    expect(NAME_REGEX.test(tildeAgency)).toBe(true)
  })

  it('cuts a name over 63 bytes to 63 bytes ending in four hex of sha256 of workflow id', () => {
    const agency = 'mecattaf/long-department-agency-name'
    const stem = 'extremely-long-workflow-stem-that-exceeds-sixty-three-bytes-limit'
    const workflowId = `${agency}:${stem}`
    const expectedHash4 = createHash('sha256').update(workflowId).digest('hex').slice(0, 4)

    const name = instanceName({
      agency,
      stem,
      instant: '2026-11-12T00:00:00Z',
    })

    expect(name.length).toBe(63)
    expect(name.endsWith(expectedHash4)).toBe(true)
    expect(NAME_REGEX.test(name)).toBe(true)
    // First 59 chars match prefix
    const rawExpectedPrefix = 'sch-mecattaf-long-department-agency-name-extremely-long-work'
    expect(name.slice(0, 59)).toBe(rawExpectedPrefix.slice(0, 59))
  })

  it('handles run-now names with reruns that exceed 63 bytes', () => {
    const agency = 'mecattaf/very-deep-hierarchy-sub-agency'
    const stem = 'long-running-data-pipeline-processor-step'
    const workflowId = `${agency}:${stem}`
    const expectedHash4 = createHash('sha256').update(workflowId).digest('hex').slice(0, 4)

    const name = instanceName({
      agency,
      stem,
      instant: '2026-11-12T00:00:00Z',
      kind: 'now',
      ulid: '01ARYZ6S41YYYYYYYYYYABCDEF',
      rerun: 3,
    })

    expect(name.length).toBe(63)
    expect(name.endsWith(expectedHash4)).toBe(true)
    expect(NAME_REGEX.test(name)).toBe(true)
  })

  it('produces the five scheduled.* labels', () => {
    const l = labels({
      root: '/home/tom/.agency',
      workflowId: 'master:fleet-nightly',
      occurrence: '2026-11-12T00:00:00Z',
      attempt: 1,
      rev: 'sha256-abcdef123456',
    })

    expect(l).toEqual({
      'scheduled.agency': '/home/tom/.agency',
      'scheduled.workflow': 'master:fleet-nightly',
      'scheduled.occurrence': '2026-11-12T00:00:00Z',
      'scheduled.attempt': '1',
      'scheduled.rev': 'sha256-abcdef123456',
    })
  })

  it('supports positional arguments for labels', () => {
    const l = labels(
      '/home/tom/mecattaf/crm',
      'mecattaf/crm:sync',
      '2026-11-12T08:00:00Z',
      2,
      'rev-42',
    )
    expect(l['scheduled.agency']).toBe('/home/tom/mecattaf/crm')
    expect(l['scheduled.workflow']).toBe('mecattaf/crm:sync')
    expect(l['scheduled.occurrence']).toBe('2026-11-12T08:00:00Z')
    expect(l['scheduled.attempt']).toBe('2')
    expect(l['scheduled.rev']).toBe('rev-42')
  })
})
