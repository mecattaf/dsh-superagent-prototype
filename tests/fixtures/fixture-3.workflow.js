export const meta = {
  name: 'fixture-3',
  description: 'Two waves, three nodes: a1 and a2 each write one file, b1 reads both and returns them as JSON',
  phases: [{ title: 'a' }, { title: 'b' }],
}
const tag = args && typeof args.tag === 'string' ? args.tag : 'untagged'
phase('a')
const [a1, a2] = await parallel([
  () => agent(`In the current working directory, create the directory fixture if it is missing, then write the file fixture/a1.txt containing exactly one line: alpha ${tag}. Do nothing else. Then reply with the single word DONE.`, { label: 'a1' }),
  () => agent(`In the current working directory, create the directory fixture if it is missing, then write the file fixture/a2.txt containing exactly one line: beta ${tag}. Do nothing else. Then reply with the single word DONE.`, { label: 'a2' }),
])
phase('b')
const b1 = await agent(
  'In the current working directory, read fixture/a1.txt and fixture/a2.txt. Change nothing. Reply with their first lines as {"a1": <first line of a1.txt>, "a2": <first line of a2.txt>}.',
  { label: 'b1', schema: { type: 'object', required: ['a1', 'a2'], properties: { a1: { type: 'string' }, a2: { type: 'string' } } } },
)
log(`fixture-3 ${tag}: a1=${a1} a2=${a2} b1=${JSON.stringify(b1)}`)
return { a1, a2, b1 }
