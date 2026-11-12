/** Unit names: the dshd instance each Assignment runs as stays inside dshd's name rule and apart from every other Assignment's. */
import { describe, expect, it } from 'vitest'
import { key } from '../src/core/index.ts'
import { WorktreeNameSchema } from '../src/app/assessment.ts'
import { unitName } from '../src/executor/dshd.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/**
 * dshd's `InstanceName::parse` (dshd.nix `src/name.rs`): 1 to 63 bytes of a-z, 0-9, '-' and '_', a letter or digit at each end,
 * and not shaped like an instance id. dshd refuses any other name with `invalid-name`.
 */
const dshdAccepts = (name: string): boolean =>
  name.length >= 1 && name.length <= 63 && /^[a-z0-9_-]+$/.test(name) && /^[a-z0-9]/.test(name) && /[a-z0-9]$/.test(name) && !UUID.test(name)
/** An accepted Ticket's execution name, as upstream's DshExecutor makes it: its worktree words and the first 12 characters of its ID. */
const executionName = (words: string, ticketId: string): string => `${WorktreeNameSchema.parse(words)}-${ticketId.slice(0, 12)}`
/** The longest worktree name the assessment allows: 32 characters. */
const LONGEST = 'abcdefghijklmnopq-rstuvwxy-zabcd'
const ticketId = (n: number) => key('ticket', String(n))

describe('unit names', () => {
  it('names the kth Assignment <prefix>-<execution name>-a<k>, the same name each time, and dshd accepts it', () => {
    const id = ticketId(1)
    expect(unitName('sa', executionName('journal-day', id), id, 1)).toBe(`sa-journal-day-${id.slice(0, 12)}-a1`)
    expect(unitName('sa', executionName('journal-day', id), id, 2)).toBe(`sa-journal-day-${id.slice(0, 12)}-a2`)
    expect(unitName('sa', executionName('journal-day', id), id, 1)).toBe(unitName('sa', executionName('journal-day', id), id, 1))
    // The longest prefix and execution name leave room for 999 Assignments within 61 characters.
    expect(LONGEST).toHaveLength(32)
    const longest = unitName('abcdefghij', executionName(LONGEST, id), id, 999)
    expect(longest).toBe(`abcdefghij-${LONGEST}-${id.slice(0, 12)}-a999`)
    expect(longest).toHaveLength(61)
    expect(dshdAccepts(longest)).toBe(true)
  })
  it('falls back to <prefix>-t<first 12 characters of the ticket id>-a<k> when the Ticket has no execution name or dshd would refuse the one it makes', () => {
    const id = ticketId(2)
    const fallback = `sa-t${id.slice(0, 12)}-a3`
    for (const name of [undefined, '', 'Journal-Day', 'journal.day', 'journal day', 'x'.repeat(58)]) {
      expect(unitName('sa', name, id, 3)).toBe(fallback)
    }
    expect(dshdAccepts(fallback)).toBe(true)
  })
  it('never gives two Assignments the same name, and dshd accepts every name', () => {
    const words = ['fix', 'journal-day', 'fix-regression', 'nightly-sweep-of-logs', 'a', LONGEST]
    for (const prefix of ['sa', 'x', 'abcdefghij']) {
      const names = new Set<string>()
      let count = 0
      for (let n = 0; n < 300; n++) {
        const id = ticketId(n)
        // Every fifth Ticket has no execution name, so fallback names share the set with ordinary ones.
        const name = n % 5 === 4 ? undefined : executionName(words[n % words.length]!, id)
        for (let k = 1; k <= 12; k++) { names.add(unitName(prefix, name, id, k)); count++ }
      }
      expect(names.size).toBe(count)
      expect([...names].filter(name => !dshdAccepts(name))).toEqual([])
    }
  })
})
