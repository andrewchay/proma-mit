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
mock.module('../agent-session-manager', () => ({
  getAgentSessionSDKMessages: (id: string): SDKMessage[] => inMemorySdk.get(id) ?? [],
  compactSDKMessages: (id: string, summary: string, keepRecent: number): SDKMessage[] => {
    const all = inMemorySdk.get(id) ?? []
    const keepCount = Math.max(0, Math.min(keepRecent, all.length))
    const kept = all.slice(all.length - keepCount)
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: id,
      summary,
    } as unknown as SDKMessage
    const result = [boundary, ...kept]
    inMemorySdk.set(id, result)
    return result
  },
}))

let capturedSummaryPrompt = ''
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
  streamSSE: async (opts: { onEvent: (e: { type: string; delta?: string }) => void }) => {
    // 捕获摘要 prompt，模拟 LLM 返回摘要
    capturedSummaryPrompt = JSON.parse((opts as unknown as { request: { body: string } }).request.body).prompt
    opts.onEvent({ type: 'chunk', delta: '【摘要】用户偏好 TypeScript，正在开发 proma-mit。' })
    opts.onEvent({ type: 'done' })
  },
}))

const {
  shouldAutoCompact,
  sdkMessagesToCompactText,
  maybeAutoCompact,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  DEFAULT_KEEP_RECENT_MESSAGES,
} = await import('./context-compaction')

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
    tempDir = mkdtempSync(join(tmpdir(), 'proma-compaction-test-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    delete process.env.PROMA_TEST_CONFIG_DIR
    if (originalTestConfigDir !== undefined) process.env.PROMA_TEST_CONFIG_DIR = originalTestConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('shouldAutoCompact：历史超过阈值 + keepRecent 时触发', () => {
    expect(shouldAutoCompact(makeHistory(61), 40, 20)).toBe(true)
    expect(shouldAutoCompact(makeHistory(60), 40, 20)).toBe(false)
    expect(shouldAutoCompact(makeHistory(41), 40, 0)).toBe(true)
  })

  test('sdkMessagesToCompactText 提取 user/assistant 文本', () => {
    const text = sdkMessagesToCompactText(makeHistory(2))
    expect(text).toContain('[用户]')
    expect(text).toContain('[助手]')
    expect(text).toContain('消息 0')
    expect(text).toContain('消息 1')
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
    })

    expect(result.compacted).toBe(true)
    expect(result.summary).toContain('【摘要】')
    // 摘要 prompt 应包含早期历史
    expect(capturedSummaryPrompt).toContain('消息 0')

    // 持久化（内存版）：应为 boundary + 最近 20 条
    const persisted = inMemorySdk.get(sessionId) ?? []
    expect(persisted.length).toBe(DEFAULT_KEEP_RECENT_MESSAGES + 1)
    const boundary = persisted[0] as { type?: string; subtype?: string; summary?: string }
    expect(boundary?.type).toBe('system')
    expect(boundary?.subtype).toBe('compact_boundary')
    expect(boundary?.summary).toContain('【摘要】')
    // 最近消息仍在
    expect(JSON.stringify(persisted[persisted.length - 1])).toContain('消息 64')
    // result.history 与持久化一致
    expect(result.history.length).toBe(persisted.length)
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
})
