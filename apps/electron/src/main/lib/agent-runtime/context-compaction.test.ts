/**
 * Proma / AI SDK 上下文压缩单元测试
 *
 * 验证自动压缩判断、历史文本转换、摘要调用与持久化压缩。
 * 通过 mock.module 隔离 @gravitas/core 的 LLM 调用；会话文件用临时配置目录。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@gravitas/shared'

mock.module('electron', () => buildElectronMock())

// 内存版 SDK 会话存储：隔离真实 JSONL 文件 I/O。
// 背景：bun 全量高并发下，对同一路径「先写后立即读」存在 fs 可见性 flaky，
// 导致 compactSDKMessages 内 getAgentSessionSDKMessages 读到空、压缩后文件只剩 1 行。
// 这里用内存 Map 实现相同语义，验证 maybeAutoCompact 的摘要/编排逻辑；
// 真实 JSONL 读写在 agent-session-manager 自身测试已覆盖。
const inMemorySdk = new Map<string, SDKMessage[]>()
let compactPersistenceMode: 'success' | 'fail' = 'success'
mock.module('../agent-session-manager', () => ({
  getAgentSessionSDKMessages: (id: string): SDKMessage[] => inMemorySdk.get(id) ?? [],
  compactSDKMessages: (id: string, summary: string, keepRecent: number, contextPacket?: unknown): SDKMessage[] => {
    if (compactPersistenceMode === 'fail') throw new Error('模拟压缩落盘失败')
    const all = inMemorySdk.get(id) ?? []
    const keepCount = Math.max(0, Math.min(keepRecent, all.length))
    const kept = all.slice(all.length - keepCount)
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: id,
      summary,
      contextPacket,
    } as unknown as SDKMessage
    const result = [boundary, ...kept]
    inMemorySdk.set(id, result)
    return result
  },
}))

let capturedSummaryPrompt = ''
let summaryStreamMode: 'success' | 'hang' | 'abort-aware' | 'invalid' = 'success'
let summaryStreamStarted: Promise<void>
let resolveSummaryStreamStarted: () => void
mock.module('@gravitas/core', () => ({
  getAdapter: () => ({
    providerType: 'deepseek',
    buildStreamRequest: (input: { userMessage: string }) => ({
      url: 'http://mock',
      headers: {},
      body: JSON.stringify({ prompt: input.userMessage }),
    }),
    parseSSELine: () => [],
  }),
  streamSSE: async (opts: { signal?: AbortSignal; onEvent: (e: { type: string; delta?: string }) => void }) => {
    resolveSummaryStreamStarted()
    // 捕获摘要 prompt，模拟 LLM 返回摘要
    capturedSummaryPrompt = JSON.parse((opts as unknown as { request: { body: string } }).request.body).prompt
    if (summaryStreamMode === 'hang') await new Promise<void>(() => {})
    if (summaryStreamMode === 'abort-aware') {
      await new Promise<void>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const error = new Error('操作已中止')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }
    if (summaryStreamMode === 'invalid') {
      opts.onEvent({ type: 'chunk', delta: '{}' })
      return
    }
    opts.onEvent({ type: 'chunk', delta: JSON.stringify({ version: 1, summary: '用户偏好 TypeScript，正在开发 Gravitas。', facts: ['用户偏好 TypeScript。'], decisions: ['使用 ContextPacket v1。'], openTasks: ['完成 P3。'], importantFiles: ['context-compaction.ts'], toolState: ['无外部写入。'] }) })
    opts.onEvent({ type: 'done' })
  },
}))

const {
  sdkMessagesToCompactText,
  maybeAutoCompact,
  compactSessionNow,
  ContextCompactionTimeoutError,
  DEFAULT_KEEP_RECENT_MESSAGES,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  MAX_COMPACTION_TIMEOUT_MS,
  SUMMARY_SOURCE_MAX_CHARS,
  truncateSummarySource,
  resolveAdaptiveCompactionTimeout,
} = await import('./context-compaction')
const { getContextCompactionMetrics } = await import('../context-compaction-audit-service')

function makeHistory(count: number): SDKMessage[] {
  const messages: SDKMessage[] = []
  for (let i = 0; i < count; i++) {
    messages.push({
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: { content: [{ type: 'text', text: `消息 ${i} 的内容足够长用于摘要：这是关于 proma-mit 项目的一次重要讨论，涉及 WebSearch 双后端、记忆系统、代理设置与上下文压缩的实现细节和决策记录。` }] },
      parent_tool_use_id: null,
      uuid: `m-${i}`,
    } as unknown as SDKMessage)
  }
  return messages
}

describe('上下文压缩（Proma / AI SDK）', () => {
  let tempDir: string
  const originalTestConfigDir = process.env.PROMA_TEST_CONFIG_DIR

  beforeEach(() => {
    compactPersistenceMode = 'success'
    summaryStreamMode = 'success'
    capturedSummaryPrompt = ''
    summaryStreamStarted = new Promise<void>((resolve) => { resolveSummaryStreamStarted = resolve })
    tempDir = mkdtempSync(join(tmpdir(), 'proma-compaction-test-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    delete process.env.PROMA_TEST_CONFIG_DIR
    if (originalTestConfigDir !== undefined) process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('sdkMessagesToCompactText 提取 user/assistant 文本', () => {
    const text = sdkMessagesToCompactText(makeHistory(2))
    expect(text).toContain('[用户]')
    expect(text).toContain('[助手]')
    expect(text).toContain('消息 0')
    expect(text).toContain('消息 1')
  })

  test('summarizeHistory：已有 ContextPacket 作为增量基线注入摘要请求', async () => {
    const previousPacket = {
      version: 1 as const,
      summary: '此前已完成架构选择。',
      facts: ['既有事实必须保留。'],
      decisions: ['统一使用 ContextGovernor。'],
      openTasks: ['继续 P2。'],
      importantFiles: ['context-compaction.ts'],
      toolState: ['没有待处理副作用。'],
    }
    const history = [
      {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 's-incremental',
        summary: previousPacket.summary,
        contextPacket: previousPacket,
      } as unknown as SDKMessage,
      ...makeHistory(45),
    ]
    inMemorySdk.set('s-incremental', history)

    await compactSessionNow({
      sessionId: 's-incremental',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      keepRecent: 20,
    })

    expect(capturedSummaryPrompt).toContain('已有 ContextPacket v1')
    expect(capturedSummaryPrompt).toContain('既有事实必须保留')
    expect(capturedSummaryPrompt).toContain('统一使用 ContextGovernor')
  })

  test('maybeAutoCompact：历史不足时不压缩', async () => {
    const result = await maybeAutoCompact({
      sessionId: 's1',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: makeHistory(30),
    })
    expect(result.compacted).toBe(false)
  })

  test('maybeAutoCompact：旧工具结果裁剪后低于预算则不调用摘要且生命周期闭合', async () => {
    const hugeToolResult: SDKMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'x'.repeat(900_000) }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const history = [hugeToolResult, ...makeHistory(21)]
    const lifecycle: string[] = []
    inMemorySdk.set('s-prune-only', history)

    const result = await maybeAutoCompact({
      sessionId: 's-prune-only',
      provider: 'kimi-coding',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'kimi-for-coding',
      historyMessages: history,
      onLifecycle: (event) => lifecycle.push(event.status),
    })

    expect(result).toMatchObject({ compacted: false, pruned: true })
    expect(lifecycle).toEqual(['started', 'succeeded'])
    expect(capturedSummaryPrompt).toBe('')
    expect(JSON.stringify(result.history)).toContain('较早工具结果已从模型视图裁剪')
    expect(JSON.stringify(inMemorySdk.get('s-prune-only'))).toContain('x'.repeat(10_000))
  })

  test('maybeAutoCompact：超过阈值时压缩并持久化 boundary', async () => {
    // 写入内存会话历史（compactSDKMessages 内存版会读它），隔离真实文件 I/O
    const sessionId = 's2'
    const history = makeHistory(65)
    inMemorySdk.set(sessionId, history)

    const result = await maybeAutoCompact({
      sessionId,
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      observedUsage: { contextTokens: 220_000, modelId: 'm', recordedAt: Date.now() },
    })

    expect(result.compacted).toBe(true)
    expect(result.summary).toContain('用户偏好 TypeScript')
    expect(result.packet?.openTasks).toEqual(['完成 P3。'])
    // 摘要 prompt 应包含早期历史
    expect(capturedSummaryPrompt).toContain('消息 0')

    // 持久化（内存版）：应为 boundary + 最近 20 条
    const persisted = inMemorySdk.get(sessionId) ?? []
    expect(persisted.length).toBe(DEFAULT_KEEP_RECENT_MESSAGES + 1)
    const boundary = persisted[0] as { type?: string; subtype?: string; summary?: string; contextPacket?: import('@gravitas/shared').ContextPacket }
    expect(boundary?.type).toBe('system')
    expect(boundary?.subtype).toBe('compact_boundary')
    expect(boundary?.summary).toContain('用户偏好 TypeScript')
    expect(boundary?.contextPacket).toEqual({ version: 1, summary: '用户偏好 TypeScript，正在开发 Gravitas。', facts: ['用户偏好 TypeScript。'], decisions: ['使用 ContextPacket v1。'], openTasks: ['完成 P3。'], importantFiles: ['context-compaction.ts'], toolState: ['无外部写入。'] })
    // 最近消息仍在
    expect(JSON.stringify(persisted[persisted.length - 1])).toContain('消息 64')
    // result.history 与持久化一致
    expect(result.history.length).toBe(persisted.length)
  })

  test('自动压缩会写入不含摘要正文的本机审计指标', async () => {
    const sessionId = 's-auto-audit'
    const history = makeHistory(65)
    inMemorySdk.set(sessionId, history)

    await maybeAutoCompact({
      sessionId,
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      observedUsage: { contextTokens: 220_000, modelId: 'm', recordedAt: Date.now() },
      audit: { sessionId, runtime: 'proma', trigger: 'automatic' },
    })

    expect(await getContextCompactionMetrics()).toMatchObject({
      total: 1,
      byRuntime: [{ key: 'proma', count: 1 }],
      byTrigger: [{ key: 'automatic', count: 1 }],
    })
  })

  test('maybeAutoCompact：早期文本过小不压缩', async () => {
    const tiny: SDKMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: 'hi' }] }, parent_tool_use_id: null } as unknown as SDKMessage,
    ]
    const result = await maybeAutoCompact({
      sessionId: 's3',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: tiny,
    })
    expect(result.compacted).toBe(false)
  })

  test('compactSessionNow：摘要请求超时会发出 timed_out 终止态并拒绝', async () => {
    const history = makeHistory(65)
    const lifecycle: string[] = []
    summaryStreamMode = 'hang'

    await expect(compactSessionNow({
      sessionId: 's-timeout',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      timeoutMs: 5,
      onLifecycle: (event) => lifecycle.push(event.status),
    })).rejects.toBeInstanceOf(ContextCompactionTimeoutError)

    expect(lifecycle).toEqual(['started', 'timed_out'])
  })

  test('compactSessionNow：主动中止会发出 aborted 终止态', async () => {
    const controller = new AbortController()
    const lifecycle: string[] = []
    summaryStreamMode = 'abort-aware'
    const running = compactSessionNow({
      sessionId: 's-aborted',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: makeHistory(65),
      signal: controller.signal,
      onLifecycle: (event) => lifecycle.push(event.status),
    })

    await summaryStreamStarted
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(lifecycle).toEqual(['started', 'aborted'])
  })

  test('compactSessionNow：无效摘要会发出 failed 终止态且不改写历史', async () => {
    const history = makeHistory(65)
    const lifecycle: string[] = []
    summaryStreamMode = 'invalid'

    await expect(compactSessionNow({
      sessionId: 's-invalid',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      onLifecycle: (event) => lifecycle.push(event.status),
    })).rejects.toThrow('压缩摘要未通过 ContextPacket 校验。')

    expect(lifecycle).toEqual(['started', 'failed'])
    expect(inMemorySdk.get('s-invalid')).toBeUndefined()
  })

  test('compactSessionNow：压缩落盘失败会发出 failed 终止态', async () => {
    const history = makeHistory(65)
    const lifecycle: string[] = []
    compactPersistenceMode = 'fail'

    await expect(compactSessionNow({
      sessionId: 's-persistence-failed',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      onLifecycle: (event) => lifecycle.push(event.status),
    })).rejects.toThrow('模拟压缩落盘失败')

    expect(lifecycle).toEqual(['started', 'failed'])
  })

  test('truncateSummarySource：超长输入保留头尾并插入截断标记', () => {
    const text = '头'.repeat(1_000) + '[MIDDLE_MARKER]' + '中'.repeat(SUMMARY_SOURCE_MAX_CHARS) + '尾'.repeat(1_000)
    const truncated = truncateSummarySource(text, 4_000)
    expect(truncated.length).toBeLessThan(text.length)
    expect(truncated).toContain('头'.repeat(100))
    expect(truncated).toContain('尾'.repeat(100))
    expect(truncated).toContain('已截断')
    // 中段内容被丢弃
    expect(truncated).not.toContain('[MIDDLE_MARKER]')
  })

  test('truncateSummarySource：未超长时原样返回', () => {
    const text = '短文本'
    expect(truncateSummarySource(text)).toBe(text)
  })

  test('resolveAdaptiveCompactionTimeout：小历史用默认值，大历史线性放大且封顶', () => {
    expect(resolveAdaptiveCompactionTimeout(1_000)).toBe(DEFAULT_COMPACTION_TIMEOUT_MS)
    // 150 chars/s：90_000 字符 → 600s，被 480s 封顶
    expect(resolveAdaptiveCompactionTimeout(90_000)).toBe(MAX_COMPACTION_TIMEOUT_MS)
    // 45_000 字符 → 300s
    expect(resolveAdaptiveCompactionTimeout(45_000)).toBe(300_000)
  })

  test('summarizeHistory：超长早期历史会被截断后再进入摘要 prompt', async () => {
    const bigText = 'A'.repeat(70_000)
    const history: SDKMessage[] = [
      { type: 'user', message: { content: [{ type: 'text', text: bigText }] }, parent_tool_use_id: null } as unknown as SDKMessage,
      ...makeHistory(44),
    ]
    inMemorySdk.set('s-truncated', history)

    await compactSessionNow({
      sessionId: 's-truncated',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      keepRecent: 20,
    })

    expect(capturedSummaryPrompt).toContain('已截断')
    // 尾部（早期历史里最接近当前对话的部分）仍在：早期历史为 big + 消息 0..23
    expect(capturedSummaryPrompt).toContain('消息 23')
  })

  test('maybeAutoCompact：压缩超时降级为裁剪历史并继续回合', async () => {
    // 除超大旧工具结果外，普通消息也放大到足够规模，
    // 保证裁剪后估算仍超预算、真正进入摘要压缩路径（而非仅 prune 就结束）。
    const hugeToolResult: SDKMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'old-tool', content: 'y'.repeat(900_000) }] },
      parent_tool_use_id: null,
    } as unknown as SDKMessage
    const bigTextMessages = makeHistory(30).map((m) => ({
      ...m,
      message: { content: [{ type: 'text', text: 'Z'.repeat(40_000) }] },
    }))
    const history = [hugeToolResult, ...bigTextMessages]
    const lifecycle: Array<{ status: string; message?: string }> = []
    inMemorySdk.set('s-degraded', history)
    summaryStreamMode = 'hang'

    const result = await maybeAutoCompact({
      sessionId: 's-degraded',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      observedUsage: { contextTokens: 220_000, modelId: 'm', recordedAt: Date.now() },
      timeoutMs: 5,
      onLifecycle: (event) => lifecycle.push({ status: event.status, message: event.message }),
    })

    expect(result.compacted).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.history).not.toBe(history)
    expect(JSON.stringify(result.history)).toContain('较早工具结果已从模型视图裁剪')
    // 原始 JSONL 未改写
    expect(JSON.stringify(inMemorySdk.get('s-degraded'))).toContain('y'.repeat(10_000))
    const last = lifecycle.at(-1)
    expect(last?.status).toBe('failed')
    expect(last?.message).toContain('降级')
    // boundary 未落盘
    expect(inMemorySdk.get('s-degraded')?.[0]).toMatchObject({ type: 'user' })
  })

  test('maybeAutoCompact：用户主动中止时不降级，向上传播 AbortError', async () => {
    const controller = new AbortController()
    summaryStreamMode = 'abort-aware'
    const history = makeHistory(65)
    inMemorySdk.set('s-abort-degrade', history)

    const running = maybeAutoCompact({
      sessionId: 's-abort-degrade',
      provider: 'deepseek',
      apiKey: 'k',
      baseUrl: 'http://mock',
      model: 'm',
      historyMessages: history,
      observedUsage: { contextTokens: 220_000, modelId: 'm', recordedAt: Date.now() },
      signal: controller.signal,
    })

    await summaryStreamStarted
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })
})
