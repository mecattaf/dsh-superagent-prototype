export const meta = {
  name: 'mixed-cloud',
  description: 'Independent source analysis on configured cloud worker pairs, followed by a separate review.',
}

if (typeof args?.source !== 'string' || !args.source.trim()) throw new Error('args.source must contain approved source context')
const [trace, draft] = await Promise.all([
  agent(`Trace the ownership and failure paths in this source. Cite exact symbols and separate confirmed defects from hypotheses.\n\n${args.source}`,
    { label: 'source-trace', pair: 'zen-deepseek' }),
  agent(`Propose one small patch for a confirmed defect in this source, or explain that no defect is established. Include a minimal independent check.\n\n${args.source}`,
    { label: 'code-draft', pair: 'groq' }),
])
if (trace === null || draft === null) throw new Error('A worker returned no accepted answer; inspect its invocation before retrying')
return await agent(`Check these two proposals against the original source. Identify unsupported claims and give concrete acceptance checks. Do not infer that a patch is integrated.\n\nSource:\n${args.source}\n\nTrace:\n${trace}\n\nDraft:\n${draft}`,
  { label: 'independent-review', pair: 'antigravity' })
