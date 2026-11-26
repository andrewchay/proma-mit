import type { AskUserQuestion, AskUserRequest } from '@gravitas/shared'

export interface AskUserAnswerState {
  selected: string[]
  customText: string
  showCustom: boolean
}

/** 接管完成和高风险核对都需要用户主动选择。 */
export function createInitialAskUserAnswer(kind: AskUserRequest['kind'], question: AskUserQuestion): AskUserAnswerState {
  const requiresExplicitChoice = kind === 'unknown_action_resolution' || kind === 'computer_use_takeover'
  const selected = !requiresExplicitChoice && question.options[0] ? [question.options[0].label] : []
  return { selected, customText: '', showCustom: false }
}
