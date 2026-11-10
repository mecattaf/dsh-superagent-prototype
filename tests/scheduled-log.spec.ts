import { describe, expect, it } from 'vitest'
import { floorLine, floorLog } from '../src/scheduled/log.ts'

describe('floor journal grammar', () => {
  it('prints the event and key=value pairs on one line', () => {
    expect(floorLine('launch', { occ: 'master:fleet-nightly@2026-11-12T00:00:00.000Z', name: 'sch-master-fleet-nightly-20261112t0000z', attempt: 1 }))
      .toBe('floor: launch occ=master:fleet-nightly@2026-11-12T00:00:00.000Z name=sch-master-fleet-nightly-20261112t0000z attempt=1')
  })
  it('quotes values with spaces, drops undefined and prints null as -', () => {
    expect(floorLine('reject', { file: 'a b.json', reason: undefined, prev: null })).toBe('floor: reject file="a b.json" prev=-')
  })
  it('keeps a newline inside one physical line', () => {
    const line = floorLine('error', { message: 'one\ntwo' })
    expect(line.includes('\n')).toBe(false)
  })
  it('writes through the injected writer', () => {
    const lines: string[] = []
    floorLog('upkeep', { pruned: 2 }, (line: string) => lines.push(line))
    expect(lines).toEqual(['floor: upkeep pruned=2'])
  })
})
