export const TYPESAFE_JUDGMENT_MODEL = 'jev-1.13.0' as const

export type TypeSafeCredentialStorage = 'encrypted' | 'memory' | 'none'

export interface TypeSafeJudgmentSettings {
  enabled: boolean
  skillShadowEnabled: boolean
  chatAgentRecommendEnabled: boolean
  model: typeof TYPESAFE_JUDGMENT_MODEL
  hasApiKey: boolean
  credentialStorage: TypeSafeCredentialStorage
}

export interface UpdateTypeSafeJudgmentSettingsInput {
  enabled?: boolean
  skillShadowEnabled?: boolean
  chatAgentRecommendEnabled?: boolean
  /** 空字符串表示不替换现有密钥。 */
  apiKey?: string
}

export interface TypeSafeConnectionTestResult {
  success: boolean
  message: string
  latencyMs?: number
  model?: string
}

export type TypeSafeAgentRoute =
  | 'chat'
  | 'agent_file_or_code'
  | 'agent_multi_step_tools'
  | 'agent_research_or_browser'

export interface TypeSafeChatRecommendation {
  conversationId: string
  decisionId: string
  source: 'typesafe'
  reason: string
  suggestedPrompt: string
  route: Exclude<TypeSafeAgentRoute, 'chat'>
  probability: number
  confidence: number
}

export type TypeSafeRecommendationFeedbackAction = 'accepted' | 'dismissed'

export interface TypeSafeRecommendationFeedback {
  decisionId: string
  action: TypeSafeRecommendationFeedbackAction
}

export const TYPESAFE_JUDGMENT_IPC_CHANNELS = {
  GET_SETTINGS: 'typesafe-judgment:get-settings',
  UPDATE_SETTINGS: 'typesafe-judgment:update-settings',
  CLEAR_API_KEY: 'typesafe-judgment:clear-api-key',
  TEST_CONNECTION: 'typesafe-judgment:test-connection',
  RECORD_FEEDBACK: 'typesafe-judgment:record-feedback',
} as const
