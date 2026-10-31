import type { AskUserQuestion, AskUserRequest } from '@gravitas/shared'

export interface AskUserAnswerState {
  selected: string[]
  customText: string
  showCustom: boolean
}

/** 高风险核对请求不预选会解除重试拦截的答案。 */
export function createInitialAskUserAnswer(kind: AskUserRequest['kind'], question: AskUserQuestion): AskUserAnswerState {
  const selected = kind === 'unknown_action_resolution' ? [] : question.options[0] ? [question.options[0].label] : []
  return { selected, customText: '', showCustom: false }
}
