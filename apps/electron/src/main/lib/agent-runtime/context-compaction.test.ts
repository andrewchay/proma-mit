/**
 * Proma / AI SDK 上下文压缩单元测试
 *
 * 验证自动压缩判断、历史文本转换、摘要调用与持久化压缩。
 * 通过 mock.module 隔离 @proma/core 的 LLM 调用；会话文件用临时配置目录。
 */

import { describe, expect, mock, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@proma/shared'
import { getAgentSessionMessagesPath } from '../config-paths'

class MockBrowserWindow {}
mock.module('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: MockBrowserWindow,
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
  shell: { openExternal: () => {} },
}))

let capturedSummaryPrompt = ''
mock.module('@proma/core', () => ({
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
    // 先写入会话消息文件（compactSDKMessages 会读它）
    const sessionId = 's2'
    const messagesPath = getAgentSessionMessagesPath(sessionId)
    mkdirSync(join(tempDir, 'agent-workspaces', 'sessions'), { recursive: true })
    const history = makeHistory(65)
    writeFileSync(messagesPath, history.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf-8')

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

    // 持久化：文件应为 boundary + 最近 20 条
    const persisted = readFileSync(messagesPath, 'utf-8').trim().split('\n')
    expect(persisted.length).toBe(DEFAULT_KEEP_RECENT_MESSAGES + 1)
    const boundary = JSON.parse(persisted[0]!)
    expect(boundary.type).toBe('system')
    expect(boundary.subtype).toBe('compact_boundary')
    expect(boundary.summary).toContain('【摘要】')
    // 最近消息仍在
    expect(JSON.stringify(persisted[persisted.length - 1]!)).toContain('消息 64')
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
