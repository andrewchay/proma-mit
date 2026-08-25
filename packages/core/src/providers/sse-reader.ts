/**
 * 共享 SSE 流式读取器
 *
 * 封装所有供应商通用的 SSE 解析逻辑：
 * - fetch 调用 + 错误检查
 * - ReadableStream reader + TextDecoder 管理
 * - 逐行 buffer 分割 + data: 前缀检测 + [DONE] 哨兵处理
 * - 通过 adapter.parseSSELine() 委托供应商特定解析
 * - 通过回调分发事件
 * - 累积工具调用信息（tool use 支持）
 */

import type { ProviderAdapter, ProviderRequest, StreamEventCallback, StreamUsageEvent, ThinkingBlock, ToolCall } from './types.ts'

// ===== 流式请求 =====

/** streamSSE 的输入选项 */
export interface StreamSSEOptions {
  /** 构建好的 HTTP 请求配置 */
  request: ProviderRequest
  /** 供应商适配器（用于解析 SSE 行） */
  adapter: ProviderAdapter
  /** 事件回调 */
  onEvent: StreamEventCallback
  /** AbortSignal 用于取消请求 */
  signal?: AbortSignal
  /** 自定义 fetch 函数（代理等场景下由调用方注入） */
  fetchFn?: typeof globalThis.fetch
  /**
   * 流式读取的空闲看门狗超时（毫秒）。
   *
   * 解决「SSE 中途无任何数据、连接也不报错 → 静默挂起」问题：
   * 若在 idleTimeoutMs 内 `reader.read()` 从未返回任何数据，判定为挂起/断流，
   * 自动 abort 底层 fetch 并抛出一个可重试的瞬时网络错误，让上层 withRetry /
   * Pi 断流重试接管，避免会话永远卡死。任何实际数据到达都会重置计时。
   *
   * 默认 120_000（120s）。传入 0 或负数可禁用看门狗（保持旧行为）。
   */
  idleTimeoutMs?: number
}

/** streamSSE 的返回结果 */
export interface StreamSSEResult {
  /** 累积的完整文本内容 */
  content: string
  /** 累积的推理内容（扁平文本，所有思考块拼接） */
  reasoning: string
  /**
   * 结构化的思考块（每块含 thinking 文本和可选 signature）
   *
   * 思考+工具模式下必须原样（含签名）回传给 Anthropic 协议家族服务端：
   * 签名缺失时会被 DeepSeek v4 等服务端以 "content[].thinking must be passed back" 拒绝。
   */
  thinkingBlocks: ThinkingBlock[]
  /** 本轮返回的工具调用列表 */
  toolCalls: ToolCall[]
  /** 停止原因（'tool_use' 表示需要执行工具后继续） */
  stopReason?: string
  /** 本轮流式请求的用量统计（取决于供应商协议，可能缺失） */
  usage?: StreamUsageEvent['usage']
}

/**
 * 执行流式 SSE 请求
 *
 * 通用流程：
 * 1. 发起 fetch POST 请求
 * 2. 检查响应状态
 * 3. 获取 ReadableStream reader，逐 chunk 读取
 * 4. 按换行分行，过滤 "data: " 前缀和 "[DONE]" 哨兵
 * 5. 调用 adapter.parseSSELine() 解析供应商特定 JSON
 * 6. 累积 content/reasoning/toolCalls，通过 onEvent 回调分发
 * 7. 返回完整内容
 */
export async function streamSSE(options: StreamSSEOptions): Promise<StreamSSEResult> {
  const { request, adapter, onEvent, signal, fetchFn = fetch } = options

  // 空闲看门狗：在「流无任何数据到达」时判定挂起并中断，避免静默卡死。
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000
  const idleEnabled = idleTimeoutMs > 0
  const idleEnabledRef = { enabled: idleEnabled, ms: idleTimeoutMs }

  // 内部 controller：既响应外部 abort，也负责超时自中断（fetch 只能绑定一个 signal）。
  const idleController = new AbortController()
  if (idleEnabled && signal) {
    if (signal.aborted) idleController.abort()
    else signal.addEventListener('abort', () => idleController.abort(), { once: true })
  }
  const effectiveSignal = idleEnabled ? idleController.signal : signal

  // 1. 发起请求（支持通过 fetchFn 注入代理）
  const response = await fetchFn(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: effectiveSignal,
  })

  // 2. 错误检查
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${adapter.providerType} API 错误 (${response.status}): ${text.slice(0, 300)}`)
  }

  if (!response.body) {
    throw new Error('响应体为空')
  }

  // 3. 读取流
  let content = ''
  let reasoning = ''
  let stopReason: string | undefined
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // 工具调用追踪
  const pendingToolCalls = new Map<string, { id: string; name: string; args: string; metadata?: Record<string, unknown> }>()
  let currentToolCallId: string | undefined

  // 思考块追踪（Anthropic 协议：每个 thinking 块由多个 thinking_delta + signature_delta 组成）
  const thinkingBlocks: ThinkingBlock[] = []
  let currentThinking: ThinkingBlock | null = null

  // 用量统计追踪
  let lastUsage: StreamUsageEvent['usage'] | undefined

  // 终止信号追踪：
  // OpenAI 协议以 data: [DONE] 哨兵结束；Anthropic 协议以 message_delta 的
  // stop_reason（done 事件）结束。若流在收到这些终止信号前就被服务端/网络
  // 提前关闭（reader 返回 done），则视为“断流”，应抛错让上层重试，而不是
  // 静默返回不完整内容。Google 等供应商以流自然结束为终止，不要求该信号。
  const requiresTerminator = adapter.requiresTerminator !== false
  let sawTerminator = false

  try {
    // 空闲看门狗：对每次 reader.read() 单独计时——若某次 read 在 idleTimeoutMs 内
    // 没有任何数据返回（读挂起），判定为静默挂起：取消底层 fetch 并抛可重试的
    // 瞬时网络错误，让上层 withRetry / Pi 断流重试接管，避免会话永远卡死。
    type ReadResult = Awaited<ReturnType<typeof reader.read>>
    const readWithIdleGuard = async (): Promise<ReadResult> => {
      if (!idleEnabledRef.enabled) return reader.read()
      let timer: ReturnType<typeof setTimeout> | undefined
      let rejectRead: ((e: Error) => void) | null = null
      // 标记本次 read 是否因看门狗空闲超时而被中断（区别于用户/外部 abort）。
      let idleTimedOut = false
      const readPromise = reader.read().catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e))
        // 仅当本次中断确由看门狗超时触发时才吞掉 AbortError（交由下方竞态中的拒绝分支
        // 抛出统一的空闲超时错误）；外部 abort（用户中断）应原样抛出，交给上层 abort 处理。
        if (err.name === 'AbortError' && idleTimedOut) return { done: true, value: undefined } as unknown as ReadResult
        throw err
      })
      timer = setTimeout(() => {
        idleTimedOut = true
        const err = new Error(
          `${adapter.providerType} SSE 流空闲超时 (no data for ${idleEnabledRef.ms}ms): stream ended without data`
        )
        err.name = 'AbortError'
        idleController.abort()
        rejectRead?.(err)
      }, idleEnabledRef.ms)
      try {
        return await Promise.race<ReadResult>([
          readPromise,
          new Promise<ReadResult>((_resolve, reject) => {
            rejectRead = reject
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        rejectRead = null
      }
    }

    while (true) {
      const { done, value } = await readWithIdleGuard()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后一个可能不完整的行
      buffer = lines.pop() || ''

      for (const line of lines) {
        // SSE 规范：冒号后的空格是可选的，兼容 "data: {...}" 和 "data:{...}" 两种格式
        let data: string
        if (line.startsWith('data: ')) {
          data = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          data = line.slice(5).trim()
        } else {
          continue
        }
        if (data === '[DONE]') {
          sawTerminator = true
          continue
        }
        if (!data) continue

        // 4. 委托给 adapter 解析供应商特定 JSON
        const events = adapter.parseSSELine(data)

        for (const event of events) {
          if (event.type === 'chunk') {
            content += event.delta
          } else if (event.type === 'reasoning') {
            reasoning += event.delta
            // 同步追加到当前思考块
            if (currentThinking) {
              currentThinking.thinking += event.delta
            } else {
              // 容错：有些 Provider 不发 content_block_start，直接发 thinking_delta
              currentThinking = { thinking: event.delta }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_signature') {
            if (currentThinking) {
              currentThinking.signature = (currentThinking.signature ?? '') + event.signature
            } else {
              // 容错：signature_delta 出现时没有活跃思考块，自建一个
              currentThinking = { thinking: '', signature: event.signature }
              thinkingBlocks.push(currentThinking)
            }
          } else if (event.type === 'reasoning_block_start') {
            currentThinking = { thinking: '' }
            thinkingBlocks.push(currentThinking)
          } else if (event.type === 'reasoning_block_stop') {
            currentThinking = null
          } else if (event.type === 'tool_call_start') {
            currentToolCallId = event.toolCallId
            pendingToolCalls.set(event.toolCallId, {
              id: event.toolCallId,
              name: event.toolName,
              args: '',
              metadata: event.metadata,
            })
          } else if (event.type === 'tool_call_delta') {
            const tcId = event.toolCallId || currentToolCallId
            if (tcId) {
              const pending = pendingToolCalls.get(tcId)
              if (pending) {
                pending.args += event.argumentsDelta
              }
            }
          } else if (event.type === 'done') {
            sawTerminator = true
            if (event.stopReason) {
              stopReason = event.stopReason
            }
          } else if (event.type === 'usage') {
            lastUsage = event.usage
          }
          onEvent(event)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 提前终止检测：需要终止信号的供应商在 EOF 时未收到任何终止信号 → 断流
  if (requiresTerminator && !sawTerminator) {
    throw new Error(
      `stream ended prematurely: ${adapter.providerType} SSE 流在收到终止信号前被提前关闭（已收到 ${content.length} 字符）`
    )
  }

  // 将 pending 工具调用解析为最终结果
  const toolCalls: ToolCall[] = []
  for (const [, pending] of pendingToolCalls) {
    try {
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: pending.args ? JSON.parse(pending.args) : {},
        metadata: pending.metadata,
      })
    } catch {
      // JSON 解析失败仍保留工具调用（空参数）
      toolCalls.push({
        id: pending.id,
        name: pending.name,
        arguments: {},
        metadata: pending.metadata,
      })
    }
  }

  // 有工具调用但无显式 stopReason 时自动推断
  if (toolCalls.length > 0 && !stopReason) {
    stopReason = 'tool_use'
  }

  onEvent({ type: 'done', stopReason })
  return { content, reasoning, thinkingBlocks, toolCalls, stopReason, usage: lastUsage }
}

// ===== 非流式标题请求 =====

/**
 * 执行非流式标题生成请求
 *
 * @param request 构建好的 HTTP 请求配置
 * @param adapter 供应商适配器（用于解析响应）
 * @returns 提取的标题文本，失败返回 null
 */
export async function fetchTitle(
  request: ProviderRequest,
  adapter: ProviderAdapter,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<string | null> {
  try {
    console.log('[fetchTitle] 发送请求:', {
      url: request.url,
      provider: adapter.providerType,
      bodyPreview: request.body.slice(0, 200),
    })

    const response = await fetchFn(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })

    console.log('[fetchTitle] 收到响应:', {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown')
      console.warn('[fetchTitle] 请求失败:', {
        status: response.status,
        error: errorText.slice(0, 500),
      })
      return null
    }

    const data: unknown = await response.json()
    console.log('[fetchTitle] 解析响应体:', {
      provider: adapter.providerType,
      dataPreview: JSON.stringify(data).slice(0, 500),
    })

    const title = adapter.parseTitleResponse(data)
    console.log('[fetchTitle] 解析标题结果:', { title })
    return title
  } catch (error) {
    console.error('[fetchTitle] 异常:', error)
    return null
  }
}
