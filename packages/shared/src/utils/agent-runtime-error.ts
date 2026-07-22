import type { TypedError } from '../types/agent'
import type { ProviderType } from '../types/channel'

export interface NormalizeAgentRuntimeErrorInput {
  runtime: 'proma' | 'ai-sdk' | 'pi'
  provider?: ProviderType
  model?: string
  error: unknown
}

export function normalizeAgentRuntimeError(input: NormalizeAgentRuntimeErrorInput): TypedError {
  const originalError = getRuntimeErrorMessage(input.error)
  const statusCode = getRuntimeErrorStatusCode(input.error, originalError)
  const lower = originalError.toLowerCase()
  const details = buildDetails(input, statusCode, originalError)

  if (statusCode === 401 || /unauthenticated|invalid authentication|invalid api key|api key.*invalid|unauthorized/.test(lower)) {
    return makeTypedError({
      code: 'invalid_api_key',
      title: 'API Key 无效',
      message: providerPrefix(input) + '认证失败，请检查渠道 API Key、鉴权方式和 baseURL。',
      canRetry: false,
      details,
      originalError,
      actions: [
        { key: 'settings', label: '检查渠道设置', action: 'open_channel_settings' },
      ],
    })
  }

  if (statusCode === 429 || /rate limit|too many requests|quota|insufficient_quota/.test(lower)) {
    return makeTypedError({
      code: 'rate_limited',
      title: '请求被限流',
      message: providerPrefix(input) + '请求达到限流或额度限制，稍后重试或切换渠道。',
      canRetry: true,
      retryDelayMs: 10_000,
      details,
      originalError,
      actions: [
        { key: 'retry', label: '稍后重试', action: 'retry' },
        { key: 'settings', label: '切换渠道', action: 'open_channel_settings' },
      ],
    })
  }

  if (isGoogleModelNotFound(input, lower, statusCode)) {
    return makeTypedError({
      code: 'invalid_model',
      title: 'Google 模型不可用',
      message: `当前 Google 模型 ${input.model ?? 'unknown'} 不可用，请改用已开放模型并确认 baseURL 包含 /v1beta。`,
      canRetry: false,
      details,
      originalError,
      actions: [
        { key: 'settings', label: '修改模型配置', action: 'open_channel_settings' },
      ],
    })
  }

  if (isKimiCodingPlanConfigError(input, lower)) {
    return makeTypedError({
      code: 'invalid_request',
      title: 'Kimi Coding Plan 配置不匹配',
      message: 'Kimi Coding Plan 需要使用 coding endpoint 与 kimi-for-coding 模型，请检查渠道 baseURL 和模型。',
      canRetry: false,
      details,
      originalError,
      actions: [
        { key: 'settings', label: '检查 Kimi 配置', action: 'open_channel_settings' },
      ],
    })
  }

  if (isQwenMaxTokensError(input, lower)) {
    return makeTypedError({
      code: 'invalid_request',
      title: 'Qwen 参数超出限制',
      message: 'Qwen 返回 max_tokens 参数范围错误，请降低 token 上限或使用 runtime 默认限制。',
      canRetry: false,
      details,
      originalError,
      actions: [
        { key: 'settings', label: '检查模型参数', action: 'open_channel_settings' },
      ],
    })
  }

  if (statusCode === 404 || /model.*not found|not found|unknown model|model_not_found/.test(lower)) {
    return makeTypedError({
      code: 'invalid_model',
      title: '模型不可用',
      message: providerPrefix(input) + `模型 ${input.model ?? 'unknown'} 不存在或当前账号不可用。`,
      canRetry: false,
      details,
      originalError,
      actions: [
        { key: 'settings', label: '修改模型配置', action: 'open_channel_settings' },
      ],
    })
  }

  if (statusCode && statusCode >= 500) {
    return makeTypedError({
      code: 'service_error',
      title: '服务端暂时异常',
      message: providerPrefix(input) + '服务端返回异常状态，请稍后重试。',
      canRetry: true,
      retryDelayMs: 3_000,
      details,
      originalError,
      actions: [
        { key: 'retry', label: '重试', action: 'retry' },
      ],
    })
  }

  if (/fetch failed|socket hang up|econnreset|timeout|network|terminated/.test(lower)) {
    return makeTypedError({
      code: 'network_error',
      title: '网络连接异常',
      message: providerPrefix(input) + '请求中断或网络不可达，请检查网络、代理或稍后重试。',
      canRetry: true,
      retryDelayMs: 3_000,
      details,
      originalError,
      actions: [
        { key: 'retry', label: '重试', action: 'retry' },
      ],
    })
  }

  return makeTypedError({
    code: 'provider_error',
    title: '模型调用失败',
    message: providerPrefix(input) + originalError,
    canRetry: false,
    details,
    originalError,
    actions: [
      { key: 'settings', label: '检查渠道设置', action: 'open_channel_settings' },
      { key: 'retry', label: '重试', action: 'retry' },
    ],
  })
}

export function getRuntimeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error) || '未知错误'
  }
}

function getRuntimeErrorStatusCode(error: unknown, message: string): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const statusCode = record.statusCode ?? record.status ?? record.code
    if (typeof statusCode === 'number') return statusCode
    if (typeof statusCode === 'string' && /^\d{3}$/.test(statusCode)) return Number(statusCode)
  }
  const statusMatch = message.match(/\b(400|401|403|404|408|409|422|429|500|502|503|504)\b/)
  return statusMatch ? Number(statusMatch[1]) : undefined
}

function buildDetails(input: NormalizeAgentRuntimeErrorInput, statusCode: number | undefined, originalError: string): string[] {
  return [
    `runtime: ${input.runtime}`,
    ...(input.provider ? [`provider: ${input.provider}`] : []),
    ...(input.model ? [`model: ${input.model}`] : []),
    ...(statusCode ? [`status: ${statusCode}`] : []),
    `error: ${truncate(originalError, 800)}`,
  ]
}

function providerPrefix(input: NormalizeAgentRuntimeErrorInput): string {
  return input.provider ? `${input.provider} ` : ''
}

function isGoogleModelNotFound(input: NormalizeAgentRuntimeErrorInput, lower: string, statusCode?: number): boolean {
  return input.provider === 'google'
    && (statusCode === 404 || /models\/.+not found|no longer available|generativelanguage\.googleapis\.com/.test(lower))
}

function isKimiCodingPlanConfigError(input: NormalizeAgentRuntimeErrorInput, lower: string): boolean {
  return input.provider === 'kimi-coding'
    && (/coding/.test(lower) || /kimi/.test(lower))
    && (/not found|invalid|404|model|baseurl|endpoint|path/.test(lower))
}

function isQwenMaxTokensError(input: NormalizeAgentRuntimeErrorInput, lower: string): boolean {
  return input.provider === 'qwen'
    && /max_tokens/.test(lower)
    && /range|invalidparameter|should be/.test(lower)
}

function makeTypedError(error: TypedError): TypedError {
  return error
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value
}
