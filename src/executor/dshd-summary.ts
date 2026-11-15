/** The Report summary the dshd executor gives a unit that exited 0 without a final answer; it imports nothing, so a Source may read it. */
const NO_ANSWER = /^Unit [a-z0-9][a-z0-9_-]* exited 0\.$/
/** The whole summary of an Assignment whose unit `name` exited 0 and printed no final answer: the Ticket completed with no result. */
export const noAnswerSummary = (name: string): string => `Unit ${name} exited 0.`
/** Whether a `ready` Report's summary is the one `noAnswerSummary` writes, so its worker gave no answer. */
export const isNoAnswer = (summary: string): boolean => NO_ANSWER.test(summary)
