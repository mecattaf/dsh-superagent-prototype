import { describe, expect, it } from 'vitest'
import { selectPair } from '../src/executor/dshd-route.ts'
import { contentHash } from '../src/workflow/key.ts'
import { nodeTrigger } from '../src/sources/workflow-trigger.ts'
import type { WorkflowRun } from '../src/sources/workflow-store.ts'
import type { DshdPair } from '../src/executor/dshd-config.ts'

const pairs: Record<string, DshdPair> = {
  opus: { profile: 'worker-opus', env: {}, provider: 'claude', model: 'opus', effort: 'medium' },
  groq: { profile: 'worker-groq', env: {}, provider: 'groq', model: 'qwen/qwen3.8-27b', effort: 'low' },
  'groq-high': { profile: 'worker-groq-high', env: {}, provider: 'groq', model: 'qwen/qwen3.8-27b', effort: 'high' },
  gufo: { profile: 'worker-gufo', env: {}, provider: 'gufo', model: 'qwen3.8-flash-next' },
}

describe('configured worker routes', () => {
  it('keeps legacy default and explicit pair behavior without model metadata', () => {
    const legacy = { opus: { profile: 'worker-opus', env: {} } }
    expect(selectPair(legacy, 'opus', {}).name).toBe('opus')
    expect(selectPair(legacy, 'opus', { pair: '' }).name).toBe('opus')
    expect(() => selectPair(legacy, 'opus', { pair: 'constructor' })).toThrow('unknown pair constructor')
  })
  it('selects exact provider/model and effort without passing secrets or changing the profile', () => {
    expect(selectPair(pairs, 'opus', { model: 'groq/qwen/qwen3.8-27b', effort: 'low' }))
      .toEqual({ name: 'groq', pair: pairs.groq })
    expect(selectPair(pairs, 'opus', { pair: 'gufo' }).pair.profile).toBe('worker-gufo')
  })
  it('varies effort only within the default provider/model family', () => {
    expect(selectPair(pairs, 'groq', { effort: 'high' }).name).toBe('groq-high')
    expect(() => selectPair(pairs, 'opus', { effort: 'high' })).toThrow('no configured pair')
    expect(() => selectPair({ old: { profile: 'old', env: {} } }, 'old', { effort: 'high' })).toThrow('does not declare model')
  })
  it('refuses unknown, ambiguous or contradictory requests instead of using the subscription default', () => {
    expect(() => selectPair(pairs, 'opus', { model: 'absent' })).toThrow('no configured pair')
    expect(() => selectPair(pairs, 'opus', { model: 'qwen/qwen3.8-27b' })).toThrow('ambiguous')
    expect(() => selectPair(pairs, 'opus', { pair: 'gufo', model: 'opus' })).toThrow('does not match')
    expect(() => selectPair(pairs, 'opus', { pair: 3 })).toThrow('invalid pair')
  })
  it('prefers the matching run default when accounts share a model, and refuses ambiguity otherwise', () => {
    const duplicate = { ...pairs, 'groq-2': { ...pairs.groq!, profile: 'worker-groq-2' } }
    expect(selectPair(duplicate, 'opus', { fallbackPair: 'groq-2', model: 'qwen/qwen3.8-27b', effort: 'low' }).name).toBe('groq-2')
    expect(() => selectPair(duplicate, 'opus', { model: 'qwen/qwen3.8-27b', effort: 'low' })).toThrow('ambiguous')
  })
  it('includes explicit pairs in resume content identity, preserving old calls without a pair', () => {
    expect(contentHash('task', { pair: 'groq' })).not.toBe(contentHash('task', { pair: 'gufo' }))
    expect(contentHash('task', {})).toBe(contentHash('task', { pair: undefined }))
  })
  it('gives each node its own route while retaining the run default as a selection hint', () => {
    const run = { id: 'run1', name: 'mixed', cwd: '/tmp/project', pair: 'opus' } as WorkflowRun
    const call = { cid: `c1:${'a'.repeat(64)}#1`, prompt: 'task', occurrence: 1, attempt: 1, phase: undefined }
    const direct = nodeTrigger(run, { ...call, opts: { pair: 'gufo' } })
    expect(direct.meta.pair).toBe('gufo')
    const selected = nodeTrigger(run, { ...call, opts: { model: 'qwen/qwen3.8-27b', effort: 'low' } })
    expect(selected.meta).toMatchObject({ fallbackPair: 'opus', model: 'qwen/qwen3.8-27b', effort: 'low' })
    expect(selected.meta).not.toHaveProperty('pair')
    expect(selectPair(pairs, 'opus', selected.meta).name).toBe('groq')
    expect(nodeTrigger(run, { ...call, opts: {} }).meta.pair).toBe('opus')
  })
})
