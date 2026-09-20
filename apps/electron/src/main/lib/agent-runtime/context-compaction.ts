/**
 * Proma / AI SDK runtime 的上下文压缩（自研，借鉴上游 Pi session.compact() 语义）。
 *
 * Claude 使用 SDK 原生压缩；Proma / Pi / AI SDK runtime 统一由这里管理：
 * - 自动压缩：依据当前 outgoing payload 估算与同模型已报告 token 的较高值触发；
 * - 分层治理：先裁剪模型视图中的旧工具结果，仍超预算时再增量更新 ContextPacket；
 * - CompactContext 工具：手动请求压缩当前会话（立即执行，下一轮生效）。
 *
 * 压缩结果持久化为 system(compact_boundary) 摘要消息 + 最近消息，
 * 后续 query 读取历史时会自然看到摘要。
 */

import { calculateContextBudget, resolveModelContextCapability, type ContextPacket, type ProviderType, type SDKMessage } from '@gravitas/shared'
import { getAdapter, streamSSE } from '@gravitas/core'
import type { StreamEvent, ToolResult } from '@gravitas/core'
import { getFetchFn } from '../proxy-fetch'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { compactSDKMessages } from '../agent-session-manager'
import type { RuntimeToolDefinition } from './types'
import { appendContextCompactionAudit, type ContextCompactionAuditInput } from '../context-compaction-audit-service'
import { estimateTokenCount } from '../agent-tool-token-estimator'

export const COMPACT_CONTEXT_TOOL_NAME = 'CompactContext'

/** 压缩时保留的最近消息条数（与 prompt-builder 的 MAX_HISTORY_MESSAGES 对齐） */
export const DEFAULT_KEEP_RECENT_MESSAGES = 20

/** 为下一轮响应预留的输出 token，避免把已报告输入压到窗口边缘。 */
export const DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS = 32_000

/** 网络协议和工具追加的不确定性缓冲。 */
export const DEFAULT_CONTEXT_SAFETY_BUFFER_TOKENS = 8_000

/** 单次摘要压缩的默认截止时间，避免 runtime 永久停留在 compacting。 */
export const DEFAULT_COMPACTION_TIMEOUT_MS = 120_000

/** 压缩后的目标低水位，给后续多轮工具调用留出增长空间。 */
export const COMPACTION_LOW_WATER_RATIO = 0.65

/** 摘要输入的最大字符数；超出时保留头尾并插入截断标记，避免摘要 prompt 无上限。 */
export const SUMMARY_SOURCE_MAX_CHARS = 60_000

/** 截断时保留头部字符占比（早期历史开头通常包含任务背景）。 */
const SUMMARY_SOURCE_HEAD_RATIO = 0.2

/** 自适应压缩超时的保守吞吐假设：摘要模型每秒处理的输入字符数。 */
const SUMMARY_TIMEOUT_CHARS_PER_SECOND = 150

/** 自适应压缩超时上限；避免超大历史把回合拖得过久。 */
export const MAX_COMPACTION_TIMEOUT_MS = 480_000

/** 早期历史转文本的最小字符数；太小不值得压缩 */
const MIN_SUMMARY_SOURCE_CHARS = 2_000

/** 旧工具结果超过该规模时，优先从模型视图裁剪；原始 JSONL 不改写。 */
export const TOOL_RESULT_PRUNE_THRESHOLD_CHARS = 2_000

const SUMMARY_SYSTEM_PROMPT =
  '你是会话上下文压缩器。只输出一个合法 JSON 对象，不要 Markdown 或额外文本。字段必须为 version=1、summary（非空字符串）、facts、decisions、openTasks、importantFiles、toolState（均为字符串数组；无内容用 []）。保留关键事实、决定、用户偏好、未完成任务、重要文件和工具状态。使用中文。'

const SUMMARY_USER_PROMPT_PREFIX =
  "请把以下历史对话压缩为 ContextPacket v1 JSON：\n\n"

export interface ContextCompactionOptions {
  sessionId: string
  provider: ProviderType
  /** 底层 ProviderAdapter 的供应商；DeepSeek 在 Proma runtime 下使用 OpenAI adapter */
  adapterProvider?: ProviderType
  apiKey: string
  baseUrl: string
  model: string
  /** 完整历史消息（SDKMessage 格式） */
  historyMessages: SDKMessage[]
  /** 最近一次由 Provider 或 SDK 报告的完整输入上下文用量。仅同模型且窗口已确认时参与判断。 */
  observedUsage?: ContextUsageObservation
  /** 即将发送的用户输入、系统指令和工具 schema，用于估算真实 outgoing payload。 */
  currentPrompt?: string
  systemPrompt?: string
  tools?: ContextBudgetTool[]
  /** 自动治理内部使用：提交后的模型视图不得超过该 token 目标。 */
  targetInputTokens?: number
  /** 压缩时保留的最近消息条数 */
  keepRecent?: number
  signal?: AbortSignal
  /** 单次压缩截止时间；0 表示禁用。 */
  timeoutMs?: number
  onLifecycle?: (event: ContextCompactionLifecycleEvent) => void
  audit?: Omit<ContextCompactionAuditInput, "packetVersion">
}

export interface ContextCompactionLifecycleEvent {
  status: 'started' | 'succeeded' | 'noop' | 'failed' | 'aborted' | 'timed_out'
  message?: string
}

export class ContextCompactionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`上下文压缩超时（${timeoutMs}ms）`)
    this.name = 'ContextCompactionTimeoutError'
  }
}

/** 从模型输出中读取并校验 ContextPacket v1；不合法的结果不能触发破坏性压缩。 */
export function parseContextPacket(raw: string): ContextPacket | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim())
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
    const packet = value as Record<string, unknown>
    const isStringArray = (items: unknown): items is string[] => Array.isArray(items) && items.every((item) => typeof item === "string" && item.trim().length > 0)
    if (packet.version !== 1 || typeof packet.summary !== "string" || packet.summary.trim().length === 0) return undefined
    if (!isStringArray(packet.facts) || !isStringArray(packet.decisions) || !isStringArray(packet.openTasks) || !isStringArray(packet.importantFiles) || !isStringArray(packet.toolState)) return undefined
    return { version: 1, summary: packet.summary.trim(), facts: packet.facts, decisions: packet.decisions, openTasks: packet.openTasks, importantFiles: packet.importantFiles, toolState: packet.toolState }
  } catch {
    return undefined
  }
}

export interface ContextCompactionResult {
  /** 是否发生了压缩 */
  compacted: boolean
  /** 摘要文本（压缩时） */
  summary?: string
  /** 已校验并持久化的 ContextPacket（压缩时） */
  packet?: ContextPacket
  /** 压缩后的历史（含 boundary + 最近消息）；未压缩时返回原历史 */
  history: SDKMessage[]
  /** 是否只对本轮模型视图执行了无损工具结果裁剪。 */
  pruned?: boolean
  /** 自动压缩失败后是否降级继续（历史为已裁剪工具结果的版本，未持久化 boundary）。 */
  degraded?: boolean
}

export interface ContextBudgetTool {
  name: string
  description?: string
  parameters?: unknown
}

export interface ContextUsageObservation {
  contextTokens: number
  modelId?: string
  recordedAt: number
}

export interface AutoCompactionTrigger {
  shouldCompact: boolean
  source: 'reported_usage' | 'estimated_payload'
  estimatedInputTokens: number
  inputBudgetTokens: number
}

/**
 * 截断超长摘要输入：保留头尾并在中间插入标记。
 * 头部保留任务背景，尾部（更接近当前对话的部分）对增量摘要最有价值；
 * 中段丢失的事实由已有 ContextPacket 增量基线兜底。
 */
export function truncateSummarySource(text: string, maxChars: number = SUMMARY_SOURCE_MAX_CHARS): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * SUMMARY_SOURCE_HEAD_RATIO)
  const tailChars = maxChars - headChars
  const omitted = text.length - headChars - tailChars
  return `${text.slice(0, headChars)}\n\n[……中间约 ${omitted} 字符的较早历史已截断；仍有效的事实以最近一次 ContextPacket 增量基线为准……]\n\n${text.slice(text.length - tailChars)}`
}

/**
 * 按摘要输入规模自适应压缩截止时间：小历史保持默认 120s，
 * 大历史按保守吞吐线性放大，封顶 MAX_COMPACTION_TIMEOUT_MS。
 * 显式传入的 timeoutMs（含 0=禁用）优先于自适应值。
 */
export function resolveAdaptiveCompactionTimeout(sourceChars: number): number {
  const adaptive = Math.ceil(sourceChars / SUMMARY_TIMEOUT_CHARS_PER_SECOND) * 1_000
  return Math.min(Math.max(DEFAULT_COMPACTION_TIMEOUT_MS, adaptive), MAX_COMPACTION_TIMEOUT_MS)
}

/**
 * 解析自动压缩触发：估算本轮完整 outgoing payload，并以同模型已报告输入作为下界。
 */
export function resolveAutoCompactionTrigger(options: {
  historyMessages: SDKMessage[]
  provider: ProviderType
  modelId: string
  observedUsage?: ContextUsageObservation
  keepRecent?: number
  currentPrompt?: string
  systemPrompt?: string
  tools?: ContextBudgetTool[]
}): AutoCompactionTrigger {
  const { provider, modelId, observedUsage } = options
  const sameModel = observedUsage?.modelId?.toLowerCase() === modelId.toLowerCase()
  const capability = resolveModelContextCapability({ provider, modelId })
  const estimatedInputTokens = estimateOutgoingContextTokens(options)
  const reportedTokens = sameModel
    && Number.isInteger(observedUsage.contextTokens)
    && observedUsage.contextTokens >= 0
    ? observedUsage.contextTokens
    : undefined
  const inputTokens = Math.max(estimatedInputTokens, reportedTokens ?? 0)
  const budget = calculateContextBudget({
    contextWindow: capability.contextWindow,
    inputTokens,
    requestedOutputTokens: DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS,
    safetyBufferTokens: DEFAULT_CONTEXT_SAFETY_BUFFER_TOKENS,
  })
  return {
    shouldCompact: budget.shouldCompact,
    source: reportedTokens !== undefined && reportedTokens >= estimatedInputTokens ? 'reported_usage' : 'estimated_payload',
    estimatedInputTokens,
    inputBudgetTokens: budget.inputBudgetTokens,
  }
}

/**
 * 对即将构造的 Provider 请求做保守 token 估算。
 * Provider tokenizer 不统一，因此这里以 CJK/ASCII 启发式覆盖 history、prompt、system 和 tools，
 * 再加入每条消息的协议 framing；已报告 usage 仅作为更高的下界，不再是唯一触发证据。
 */
export function estimateOutgoingContextTokens(input: {
  historyMessages: SDKMessage[]
  currentPrompt?: string
  systemPrompt?: string
  tools?: ContextBudgetTool[]
}): number {
  const payload = [
    JSON.stringify(input.historyMessages),
    input.currentPrompt ?? '',
    input.systemPrompt ?? '',
    input.tools ? JSON.stringify(input.tools) : '',
  ].join('\n')
  return estimateTokenCount(payload) + 256 + input.historyMessages.length * 12
}

/** 按低水位预算选择可保留的最近消息数量；超大单项会被纳入摘要而不是强行保留。 */
export function resolveAdaptiveKeepRecent(input: {
  historyMessages: SDKMessage[]
  inputBudgetTokens: number
  desiredKeepRecent?: number
  currentPrompt?: string
  systemPrompt?: string
  tools?: ContextBudgetTool[]
}): number {
  const desired = Math.max(0, Math.min(input.desiredKeepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES, input.historyMessages.length))
  const staticTokens = estimateOutgoingContextTokens({
    historyMessages: [],
    currentPrompt: input.currentPrompt,
    systemPrompt: input.systemPrompt,
    tools: input.tools,
  })
  const historyBudget = Math.max(0, Math.floor(input.inputBudgetTokens * COMPACTION_LOW_WATER_RATIO) - staticTokens)
  let selected = 0
  for (let index = input.historyMessages.length - 1; index >= 0 && selected < desired; index--) {
    const candidate = input.historyMessages.slice(index)
    const candidateTokens = estimateOutgoingContextTokens({ historyMessages: candidate })
    if (candidateTokens > historyBudget) break
    selected += 1
  }
  return selected
}

export interface ToolResultPruningResult {
  history: SDKMessage[]
  prunedResults: number
}

/**
 * 优先裁剪最近窗口之外的大型成功 tool_result。函数只返回克隆后的模型视图，
 * 不触碰 session JSONL；错误结果保留，以免丢失失败原因与恢复状态。
 */
export function pruneOldToolResults(
  historyMessages: SDKMessage[],
  options: { keepRecentMessages?: number; thresholdChars?: number } = {},
): ToolResultPruningResult {
  const keepRecentMessages = options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES
  const thresholdChars = options.thresholdChars ?? TOOL_RESULT_PRUNE_THRESHOLD_CHARS
  const protectedStart = Math.max(0, historyMessages.length - keepRecentMessages)
  let prunedResults = 0
  const history = historyMessages.map((message, messageIndex) => {
    if (messageIndex >= protectedStart || message.type !== 'user') return message
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return message
    let changed = false
    const nextContent = content.map((rawBlock) => {
      const block = rawBlock as { type?: string; content?: unknown; is_error?: boolean; tool_use_id?: string }
      if (block.type !== 'tool_result' || block.is_error === true) return rawBlock
      const serialized = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      if (serialized.length <= thresholdChars) return rawBlock
      changed = true
      prunedResults += 1
      return {
        ...block,
        content: `[较早工具结果已从模型视图裁剪；原始记录保留于会话 JSONL。字符数=${serialized.length}]`,
      }
    })
    if (!changed) return message
    return {
      ...message,
      message: {
        ...(message as { message?: object }).message,
        content: nextContent,
      },
    } as SDKMessage
  })
  return { history, prunedResults }
}

/** 把早期 SDKMessage 列表转换为可读文本（用于摘要输入） */
export function sdkMessagesToCompactText(messages: SDKMessage[]): string {
  const parts: string[] = []
  for (const msg of messages) {
    const text = extractMessageText(msg)
    if (!text) continue
    const role = msg.type === 'user' ? '用户' : msg.type === 'assistant' ? '助手' : '系统'
    parts.push(`[${role}] ${text}`)
  }
  return parts.join('\n\n')
}

function extractMessageText(msg: SDKMessage): string {
  if (msg.type === 'system') {
    return (msg as { message?: string; summary?: string }).message
      ?? (msg as { message?: string; summary?: string }).summary
      ?? ''
  }
  const content = (msg as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: string; content?: unknown; name?: string; input?: unknown }
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'tool_use') return `[调用工具 ${b.name ?? ''}: ${JSON.stringify(b.input ?? {})}]`
      if (b.type === 'tool_result') {
        const c = b.content
        return `[工具结果: ${typeof c === 'string' ? c : JSON.stringify(c)?.slice(0, 500)}]`
      }
      return ''
    })
    .filter((t) => t.length > 0)
    .join('\n')
}

/**
 * 用当前渠道的 LLM 生成历史摘要。
 * 复用 @gravitas/core 的 ProviderAdapter + streamSSE（与 provider-agnostic adapter 同路径）。
 */
export async function summarizeHistory(options: ContextCompactionOptions): Promise<ContextPacket | undefined> {
  const { provider, adapterProvider, apiKey, baseUrl, model, historyMessages, keepRecent = DEFAULT_KEEP_RECENT_MESSAGES, signal } = options
  const earlyCount = Math.max(0, historyMessages.length - keepRecent)
  const earlyMessages = historyMessages.slice(0, earlyCount)
  const sourceText = truncateSummarySource(sdkMessagesToCompactText(earlyMessages))

  const adapter = getAdapter(adapterProvider ?? provider)
  const previousPacket = findLatestContextPacket(earlyMessages)
  const incrementalPrefix = previousPacket
    ? `已有 ContextPacket v1（把它作为增量基线，结合新历史输出完整的更新包，不要遗漏仍有效的事实、决定、待办和工具状态）：\n${JSON.stringify(previousPacket)}\n\n`
    : ''
  const request = adapter.buildStreamRequest({
    providerType: provider,
    baseUrl,
    apiKey,
    modelId: model,
    history: [],
    userMessage: SUMMARY_USER_PROMPT_PREFIX + incrementalPrefix + sourceText,
    systemMessage: SUMMARY_SYSTEM_PROMPT,
    readImageAttachments: () => [],
  })

  const proxyUrl = await getEffectiveProxyUrl()
  const fetchFn = getFetchFn(proxyUrl)
  let content = ''
  await streamSSE({
    request,
    adapter,
    fetchFn,
    signal,
    onEvent: (event: StreamEvent) => {
      if (event.type === 'chunk') content += event.delta
    },
  })
  return parseContextPacket(content)
}

function findLatestContextPacket(messages: SDKMessage[]): ContextPacket | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'system') continue
    const packet = (message as { contextPacket?: ContextPacket }).contextPacket
    if (packet?.version === 1) return packet
  }
  return undefined
}

/**
 * 立即压缩当前会话：摘要早期历史 + 保留最近消息 + 持久化 boundary。
 * 返回压缩结果与新的历史。
 */
export async function compactSessionNow(options: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const { sessionId, historyMessages } = options
  let keepRecent = options.keepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES
  options.onLifecycle?.({ status: 'started' })
  const earlyCount = Math.max(0, historyMessages.length - keepRecent)
  const earlyMessages = historyMessages.slice(0, earlyCount)

  if (earlyCount <= 0) {
    options.onLifecycle?.({ status: 'noop', message: '当前上下文较小，暂时无需压缩。' })
    return { compacted: false, history: historyMessages }
  }
  if (sdkMessagesToCompactText(earlyMessages).trim().length < MIN_SUMMARY_SOURCE_CHARS) {
    options.onLifecycle?.({ status: 'noop', message: '可压缩的早期上下文过少，暂时无需压缩。' })
    return { compacted: false, history: historyMessages }
  }

  let packet: ContextPacket | undefined
  try {
    packet = await summarizeHistoryWithDeadline(options)
  } catch (error) {
    const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    const timedOut = error instanceof ContextCompactionTimeoutError
    const message = error instanceof Error ? error.message : String(error)
    options.onLifecycle?.({ status: timedOut ? 'timed_out' : aborted ? 'aborted' : 'failed', message })
    throw error
  }
  if (!packet) {
    const error = new Error('压缩摘要未通过 ContextPacket 校验。')
    options.onLifecycle?.({ status: 'failed', message: error.message })
    throw error
  }

  if (options.targetInputTokens !== undefined) {
    while (keepRecent > 0) {
      const projectedHistory = [{
        type: 'system',
        subtype: 'compact_boundary',
        session_id: sessionId,
        summary: packet.summary,
        contextPacket: packet,
      } as unknown as SDKMessage, ...historyMessages.slice(historyMessages.length - keepRecent)]
      const projectedTokens = estimateOutgoingContextTokens({
        historyMessages: projectedHistory,
        currentPrompt: options.currentPrompt,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
      })
      if (projectedTokens <= options.targetInputTokens) break
      keepRecent -= 1
    }
    const boundaryOnlyTokens = estimateOutgoingContextTokens({
      historyMessages: [{ type: 'system', subtype: 'compact_boundary', session_id: sessionId, summary: packet.summary, contextPacket: packet } as unknown as SDKMessage],
      currentPrompt: options.currentPrompt,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    })
    if (boundaryOnlyTokens > options.targetInputTokens) {
      const error = new Error('压缩后的 ContextPacket 仍超出目标 token 预算，已拒绝提交。')
      options.onLifecycle?.({ status: 'failed', message: error.message })
      throw error
    }
  }

  let history: SDKMessage[]
  try {
    history = compactSDKMessages(sessionId, packet.summary, keepRecent, packet)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    options.onLifecycle?.({ status: 'failed', message })
    throw error
  }
  try {
    if (options.audit) appendContextCompactionAudit({ ...options.audit, packetVersion: packet.version })
  } catch (error) {
    console.warn("[上下文压缩] 写入审计失败:", error)
  }
  options.onLifecycle?.({ status: 'succeeded' })
  return { compacted: true, summary: packet.summary, packet, history }
}

async function runSummarizeWithDeadline(options: ContextCompactionOptions, timeoutMs: number): Promise<ContextPacket | undefined> {
  if (timeoutMs <= 0) return summarizeHistory(options)

  const controller = new AbortController()
  const abortFromCaller = (): void => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    try {
      return await Promise.race([
        summarizeHistory({ ...options, signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            reject(new ContextCompactionTimeoutError(timeoutMs))
            controller.abort()
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      if (timedOut && !(error instanceof ContextCompactionTimeoutError)) {
        throw new ContextCompactionTimeoutError(timeoutMs)
      }
      throw error
    }
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abortFromCaller)
  }
}

/**
 * 带截止时间的摘要执行：
 * - 未显式配置 timeoutMs 时按摘要输入规模自适应（慢模型/大历史不会被 120s 写死）；
 * - 超时后重试一次（换一次网络/负载机会）；abort 立即向上传播，不重试。
 */
async function summarizeHistoryWithDeadline(options: ContextCompactionOptions): Promise<ContextPacket | undefined> {
  const earlyCount = Math.max(0, options.historyMessages.length - (options.keepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES))
  const sourceChars = sdkMessagesToCompactText(options.historyMessages.slice(0, earlyCount)).length
  const timeoutMs = options.timeoutMs ?? resolveAdaptiveCompactionTimeout(sourceChars)
  const maxAttempts = 2
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runSummarizeWithDeadline(options, timeoutMs)
    } catch (error) {
      const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
      const timedOut = error instanceof ContextCompactionTimeoutError
      if (timedOut && !aborted && attempt < maxAttempts) {
        console.warn(`[上下文压缩] 摘要超时（${timeoutMs}ms），正在重试一次: sessionId=${options.sessionId}`)
        continue
      }
      throw error
    }
  }
  // 循环内要么 return 要么 throw，此处不可达；保留类型完整性。
  throw new ContextCompactionTimeoutError(timeoutMs)
}

/**
 * 自动压缩入口：当前 outgoing payload 超出输入预算时，先裁剪旧工具结果，再摘要。
 * 供 provider-agnostic / pi / ai-sdk adapter 在 query 入口调用。
 */
export async function maybeAutoCompact(options: ContextCompactionOptions): Promise<ContextCompactionResult> {
  const { historyMessages, keepRecent } = options
  const trigger = resolveAutoCompactionTrigger({
    historyMessages,
    provider: options.provider,
    modelId: options.model,
    observedUsage: options.observedUsage,
    keepRecent,
    currentPrompt: options.currentPrompt,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
  })
  if (!trigger.shouldCompact) {
    return { compacted: false, history: historyMessages }
  }
  const pruning = pruneOldToolResults(historyMessages, { keepRecentMessages: keepRecent })
  if (pruning.prunedResults > 0) {
    const afterPruning = resolveAutoCompactionTrigger({
      historyMessages: pruning.history,
      provider: options.provider,
      modelId: options.model,
      currentPrompt: options.currentPrompt,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    })
    if (!afterPruning.shouldCompact) {
      options.onLifecycle?.({ status: 'started' })
      options.onLifecycle?.({ status: 'succeeded', message: `已从模型视图裁剪 ${pruning.prunedResults} 条较早工具结果。` })
      return { compacted: false, pruned: true, history: pruning.history }
    }
  }
  const adaptiveKeepRecent = resolveAdaptiveKeepRecent({
    historyMessages: pruning.history,
    inputBudgetTokens: trigger.inputBudgetTokens,
    desiredKeepRecent: keepRecent,
    currentPrompt: options.currentPrompt,
    systemPrompt: options.systemPrompt,
    tools: options.tools,
  })
  try {
    return await compactSessionNow({
      ...options,
      historyMessages: pruning.history,
      keepRecent: adaptiveKeepRecent,
      targetInputTokens: Math.floor(trigger.inputBudgetTokens * COMPACTION_LOW_WATER_RATIO),
    })
  } catch (error) {
    // 降级：自动压缩失败（超时/摘要不合法/落盘失败）不杀死用户回合。
    // 退回已裁剪工具结果的历史继续本轮；boundary 不落盘，下一轮会重新尝试压缩。
    // 用户主动 abort 仍向上传播，由 adapter 的中止链路处理。
    const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
    if (aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[上下文压缩] 自动压缩失败，降级为工具结果裁剪并继续本轮: sessionId=${options.sessionId}, 原因=${message}`)
    options.onLifecycle?.({
      status: 'failed',
      message: `自动压缩失败，已降级为工具结果裁剪并继续本轮对话：${message}`,
    })
    return { compacted: false, pruned: pruning.prunedResults > 0, history: pruning.history, degraded: true }
  }
}

/**
 * CompactContext 工具定义。
 * 模型可见；真实压缩逻辑由各 adapter 在工具执行循环中拦截（需要 provider 凭据做摘要）。
 * 此 execute 为占位实现，仅满足 RuntimeToolDefinition 类型要求，正常情况下不会被调用。
 */
export function createCompactContextToolDefinition(): RuntimeToolDefinition {
  return {
    name: COMPACT_CONTEXT_TOOL_NAME,
    description:
      '压缩当前 Agent 会话的上下文：将早期历史对话摘要为长期记忆要点并保留最近内容，之后本轮继续，下一轮对话基于压缩后的摘要继续。适合长会话接近上下文上限时调用。',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
    execute: async (_input: unknown, _ctx: unknown): Promise<ToolResult> => ({
      toolCallId: '',
      content: '上下文压缩由适配器拦截处理。',
      isError: false,
    }),
  }
}
