import { TypeSafeClient, choice, APIError } from '@typesafe-ai/sdk'
import {
  TYPESAFE_JUDGMENT_MODEL,
  type FileAttachment,
  type TypeSafeAgentRoute,
  type TypeSafeChatRecommendation,
  type TypeSafeConnectionTestResult,
} from '@gravitas/shared'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { getTypeSafeApiKey, getTypeSafeJudgmentSettings } from './typesafe-judgment-config'
import { recordTypeSafeDecision } from './typesafe-judgment-audit'

const REQUEST_TIMEOUT_MS = 1_100
const TOTAL_REQUEST_BUDGET_MS = 2_600
const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_OPEN_MS = 60_000
const MAX_STATE_CHARS = 8_000
export const CHAT_AGENT_PROBABILITY_THRESHOLD = 0.75
export const CHAT_AGENT_CONFIDENCE_THRESHOLD = 0.35

interface CircuitState {
  failures: number
  openUntil: number
}

const circuit: CircuitState = { failures: 0, openUntil: 0 }

export interface TypeSafeSkillCandidate {
  slug: string
  name: string
  description?: string
}

export interface TypeSafeSkillRouteResult {
  status: 'success' | 'unavailable'
  decisionId?: string
  selected?: string
  probability?: number
  confidence?: number
  probabilities?: Record<string, number>
  reasonCode?: string
}

export interface TypeSafeChatRouteResult {
  status: 'success' | 'unavailable'
  recommendation?: TypeSafeChatRecommendation
  route?: TypeSafeAgentRoute
  probability?: number
  confidence?: number
  reasonCode?: string
}

function isCircuitOpen(now = Date.now()): boolean {
  return circuit.openUntil > now
}

function markSuccess(): void {
  circuit.failures = 0
  circuit.openUntil = 0
}

function markFailure(): void {
  circuit.failures += 1
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = Date.now() + CIRCUIT_OPEN_MS
  }
}

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_STATE_CHARS)
}

function attachmentKinds(attachments?: FileAttachment[]): string[] {
  if (!attachments?.length) return []
  return attachments.map((attachment) => attachment.mediaType.split('/')[0] || 'unknown')
}

function errorReason(error: unknown): string {
  if (error instanceof APIError) return `http_${error.status}`
  if (error instanceof Error && error.name) return error.name
  return 'unknown_error'
}

function requestSignal(externalSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(TOTAL_REQUEST_BUDGET_MS)
  return externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal
}

async function createClient(): Promise<TypeSafeClient | null> {
  const apiKey = getTypeSafeApiKey()
  if (!apiKey) return null
  const proxyUrl = await getEffectiveProxyUrl()
  const proxyFetch = getFetchFn(proxyUrl)
  return new TypeSafeClient({
    apiKey,
    defaultModel: TYPESAFE_JUDGMENT_MODEL,
    timeout: REQUEST_TIMEOUT_MS,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 150,
      backoffJitter: 0.2,
      httpStatuses: new Set([429, 529]),
      respectRetryAfter: true,
      maxRetryAfterMs: 300,
      apiConnectionError: true,
      apiTimeoutError: true,
    },
    logLevel: 'off',
    fetch: (input, init) => proxyFetch(input, init),
  })
}

function topProbabilities(
  probabilities: Readonly<Record<string, number>>,
  limit = 3,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(probabilities)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit),
  )
}

function chatReason(route: Exclude<TypeSafeAgentRoute, 'chat'>): string {
  switch (route) {
    case 'agent_file_or_code':
      return '这个任务涉及文件或代码操作，Agent 模式可以直接读取、修改并验证本地内容。'
    case 'agent_multi_step_tools':
      return '这个任务需要多步骤执行和工具协作，Agent 模式更适合持续推进并核验结果。'
    case 'agent_research_or_browser':
      return '这个任务需要系统调研或网页操作，Agent 模式可以调用相应工具完成完整流程。'
  }
}

export function isTypeSafeSkillShadowAvailable(): boolean {
  const settings = getTypeSafeJudgmentSettings()
  return settings.enabled && settings.skillShadowEnabled && settings.hasApiKey && !isCircuitOpen()
}

export function isTypeSafeChatRecommendationAvailable(): boolean {
  const settings = getTypeSafeJudgmentSettings()
  return settings.enabled && settings.chatAgentRecommendEnabled && settings.hasApiKey && !isCircuitOpen()
}

export async function judgeSkillRoute(input: {
  message: string
  candidates: TypeSafeSkillCandidate[]
  contextId?: string
}): Promise<TypeSafeSkillRouteResult> {
  const startedAt = Date.now()
  if (!isTypeSafeSkillShadowAvailable()) return { status: 'unavailable', reasonCode: 'disabled' }
  if (input.candidates.length < 2) return { status: 'unavailable', reasonCode: 'insufficient_candidates' }

  const criteria: Record<string, string> = { no_skill: '当前请求不需要任何候选 Skill。' }
  for (const candidate of input.candidates.slice(0, 100)) {
    if (candidate.slug === 'no_skill') continue
    const description = candidate.description ? normalizeMessage(candidate.description).slice(0, 300) : ''
    criteria[candidate.slug] = `${candidate.name.slice(0, 120)}${description ? `：${description}` : ''}`
  }

  try {
    const client = await createClient()
    if (!client) return { status: 'unavailable', reasonCode: 'missing_api_key' }
    const result = await client.systemOne({
      model: TYPESAFE_JUDGMENT_MODEL,
      state: { user_request: normalizeMessage(input.message) },
      questions: {
        skill_route: choice(
          '选择完成该请求最相关的一个 Skill；只有确实匹配候选能力时才选择该 Skill，否则选择 no_skill。',
          criteria,
        ),
      },
    }, {
      signal: requestSignal(),
    })

    markSuccess()
    const answer = result.answers.skill_route
    const probabilities = topProbabilities(answer.probabilities)
    const probability = answer.probabilities[answer.choice] ?? 0
    const decisionId = recordTypeSafeDecision({
      kind: 'skill_shadow',
      status: 'success',
      model: result.model,
      latencyMs: Date.now() - startedAt,
      contextId: input.contextId,
      selected: answer.choice,
      probability,
      confidence: answer.confidence,
      probabilities,
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      mode: 'shadow',
    })
    return {
      status: 'success',
      decisionId,
      selected: answer.choice,
      probability,
      confidence: answer.confidence,
      probabilities,
    }
  } catch (error) {
    markFailure()
    const reasonCode = errorReason(error)
    recordTypeSafeDecision({
      kind: 'skill_shadow',
      status: 'unavailable',
      model: TYPESAFE_JUDGMENT_MODEL,
      latencyMs: Date.now() - startedAt,
      contextId: input.contextId,
      reasonCode,
      mode: 'shadow',
    })
    return { status: 'unavailable', reasonCode }
  }
}

export async function judgeChatAgentRoute(input: {
  conversationId: string
  message: string
  attachments?: FileAttachment[]
  signal?: AbortSignal
}): Promise<TypeSafeChatRouteResult> {
  const startedAt = Date.now()
  if (!isTypeSafeChatRecommendationAvailable()) {
    return { status: 'unavailable', reasonCode: isCircuitOpen() ? 'circuit_open' : 'disabled' }
  }

  const criteria = {
    chat: '简短问答、解释、短文本翻译、日常讨论，Chat 可以直接完成。',
    agent_file_or_code: '需要读取、创建或修改本地文件、代码、配置，或运行测试与构建。',
    agent_multi_step_tools: '需要多个步骤、命令、外部工具、数据处理或持续迭代才能完成。',
    agent_research_or_browser: '需要系统调研、跨来源检索、受管浏览器操作或结构化研究产出。',
  } as const

  try {
    const client = await createClient()
    if (!client) return { status: 'unavailable', reasonCode: 'missing_api_key' }
    const result = await client.systemOne({
      model: TYPESAFE_JUDGMENT_MODEL,
      state: {
        user_request: normalizeMessage(input.message),
        attachment_kinds: attachmentKinds(input.attachments),
      },
      questions: {
        route: choice(
          '判断当前请求应继续在 Chat 中回答，还是推荐用户切换到能够操作文件和工具的 Agent 模式。只按完成任务所必需的能力判断。',
          criteria,
        ),
      },
    }, {
      signal: requestSignal(input.signal),
    })

    markSuccess()
    const answer = result.answers.route
    const route = answer.choice
    const probability = answer.probabilities[route] ?? 0
    const shouldRecommend = route !== 'chat'
      && probability >= CHAT_AGENT_PROBABILITY_THRESHOLD
      && answer.confidence >= CHAT_AGENT_CONFIDENCE_THRESHOLD
    const decisionId = recordTypeSafeDecision({
      kind: 'chat_agent_route',
      status: 'success',
      model: result.model,
      latencyMs: Date.now() - startedAt,
      contextId: input.conversationId,
      selected: route,
      probability,
      confidence: answer.confidence,
      probabilities: topProbabilities(answer.probabilities, 4),
      inputTokens: result.usage.input_tokens,
      outputTokens: result.usage.output_tokens,
      mode: 'active',
    })

    return {
      status: 'success',
      route,
      probability,
      confidence: answer.confidence,
      recommendation: shouldRecommend
        ? {
            conversationId: input.conversationId,
            decisionId,
            source: 'typesafe',
            reason: chatReason(route),
            suggestedPrompt: input.message.trim(),
            route,
            probability,
            confidence: answer.confidence,
          }
        : undefined,
    }
  } catch (error) {
    const abortedByCaller = input.signal?.aborted === true
    if (!abortedByCaller) markFailure()
    const reasonCode = abortedByCaller ? 'aborted' : errorReason(error)
    recordTypeSafeDecision({
      kind: 'chat_agent_route',
      status: 'unavailable',
      model: TYPESAFE_JUDGMENT_MODEL,
      latencyMs: Date.now() - startedAt,
      contextId: input.conversationId,
      reasonCode,
      mode: 'active',
    })
    return { status: 'unavailable', reasonCode }
  }
}

export async function testTypeSafeConnection(): Promise<TypeSafeConnectionTestResult> {
  const startedAt = Date.now()
  try {
    const client = await createClient()
    if (!client) return { success: false, message: '请先保存 TypeSafe API Key' }
    const result = await client.systemOne({
      model: TYPESAFE_JUDGMENT_MODEL,
      state: 'connection-test',
      questions: { reachable: choice('选择 ok。', { ok: '连接正常', failed: '连接异常' }) },
    }, {
      signal: requestSignal(),
      retry: { maxRetries: 0 },
    })
    markSuccess()
    return {
      success: result.answers.reachable.choice === 'ok',
      message: result.answers.reachable.choice === 'ok' ? '连接成功' : '服务返回了异常判断',
      latencyMs: Date.now() - startedAt,
      model: result.model,
    }
  } catch (error) {
    markFailure()
    return {
      success: false,
      message: `连接失败（${errorReason(error)}）`,
      latencyMs: Date.now() - startedAt,
    }
  }
}

/** 仅供隔离测试重置熔断状态。 */
export function resetTypeSafeCircuitForTest(): void {
  if (process.env.NODE_ENV !== 'test' && !process.env.PROMA_TEST_CONFIG_DIR) return
  circuit.failures = 0
  circuit.openUntil = 0
}
