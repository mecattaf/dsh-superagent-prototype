/** Resolve node requests to configured worker profiles. An unknown or ambiguous route never falls back to another provider. */
import type { DshdPair } from './dshd-config.ts'

type Request = Readonly<Record<string, unknown>>
const named = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.trim() !== value) throw new Error(`invalid ${field}: expected a nonempty selector`)
  return value
}

export function selectPair(pairs: Record<string, DshdPair>, defaultPair: string, request: Request): { name: string; pair: DshdPair } {
  const explicit = named(request.pair, 'pair')
  const model = named(request.model, 'model')
  const effort = named(request.effort, 'effort')
  const base = explicit ?? named(request.fallbackPair, 'fallbackPair') ?? defaultPair
  const get = (name: string): DshdPair => {
    const pair = Object.hasOwn(pairs, name) ? pairs[name] : undefined
    if (!pair) throw new Error(`unknown pair ${name}`)
    return pair
  }
  if (model === undefined && effort === undefined) return { name: base, pair: get(base) }
  // Effort alone varies the default model, never the provider/model family.
  const family = model === undefined ? get(base) : undefined
  if (family && !family.model) throw new Error(`pair ${base} does not declare model metadata for effort selection`)
  const matches = (pair: DshdPair): boolean => {
    const sameModel = model === undefined
      ? pair.provider === family!.provider && pair.model === family!.model
      : pair.model === model || (pair.provider !== undefined && `${pair.provider}/${pair.model}` === model)
    return sameModel && (effort === undefined || pair.effort === effort)
  }
  if (explicit !== undefined) {
    const pair = get(explicit)
    if (!matches(pair)) throw new Error(`pair ${explicit} does not match requested model/effort`)
    return { name: explicit, pair }
  }
  const choices = Object.entries(pairs).filter(([, pair]) => matches(pair))
  const preferred = choices.find(([name]) => name === base)
  if (preferred) return { name: preferred[0], pair: preferred[1] }
  if (choices.length !== 1) throw new Error(choices.length
    ? `ambiguous model/effort route (${choices.map(([name]) => name).sort().join(', ')}); specify agent({ pair })`
    : `no configured pair matches model ${model ?? family!.model} and effort ${effort ?? '(default)'}`)
  return { name: choices[0]![0], pair: choices[0]![1] }
}
