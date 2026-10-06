import type {
  TypeSafeRecommendationFeedback,
  UpdateTypeSafeJudgmentSettingsInput,
} from '@gravitas/shared'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BOOLEAN_FIELDS = ['enabled', 'skillShadowEnabled', 'chatAgentRecommendEnabled'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateTypeSafeSettingsInput(input: unknown): UpdateTypeSafeJudgmentSettingsInput {
  if (!isRecord(input)) throw new Error('TypeSafe 设置格式无效')

  const result: UpdateTypeSafeJudgmentSettingsInput = {}
  for (const field of BOOLEAN_FIELDS) {
    const value = input[field]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error(`TypeSafe 设置 ${field} 必须是布尔值`)
    result[field] = value
  }

  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== 'string') throw new Error('TypeSafe API Key 必须是字符串')
    if (input.apiKey.length > 512) throw new Error('TypeSafe API Key 长度超过限制')
    result.apiKey = input.apiKey
  }

  return result
}

export function validateTypeSafeFeedback(input: unknown): TypeSafeRecommendationFeedback {
  if (!isRecord(input)) throw new Error('TypeSafe 推荐反馈格式无效')
  if (typeof input.decisionId !== 'string' || !UUID_PATTERN.test(input.decisionId)) {
    throw new Error('TypeSafe decisionId 无效')
  }
  if (input.action !== 'accepted' && input.action !== 'dismissed') {
    throw new Error('TypeSafe 推荐反馈动作无效')
  }
  return { decisionId: input.decisionId, action: input.action }
}
