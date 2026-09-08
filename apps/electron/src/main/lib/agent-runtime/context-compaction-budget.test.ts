import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@gravitas/shared'
import { resolveAutoCompactionTrigger } from './context-compaction'

function makeHistory(count: number): SDKMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    type: index % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text: `消息 ${index}` }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage))
}

describe('上下文压缩预算触发', () => {
  test('Kimi K3 已报告输入远低于 1M 预算时，抑制旧的消息数量触发', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(61),
      provider: 'kimi-api',
      modelId: 'kimi-k3',
      observedUsage: { contextTokens: 200_000, modelId: 'kimi-k3', recordedAt: 1 },
    })).toEqual({ shouldCompact: false, source: 'reported_usage' })
  })

  test('Gravitas runtime 将 K3 简写按 1M 预算处理', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(61),
      provider: 'kimi-api',
      modelId: 'K3',
      observedUsage: { contextTokens: 200_000, modelId: 'K3', recordedAt: 1 },
    })).toEqual({ shouldCompact: false, source: 'reported_usage' })
  })

  test('Kimi 256K 模型接近输入预算时触发压缩', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(30),
      provider: 'kimi-api',
      modelId: 'kimi-k2.6',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-k2.6', recordedAt: 1 },
    })).toEqual({ shouldCompact: true, source: 'reported_usage' })
  })

  test('Kimi for Coding 在 256K 窗口耗用 220K 时按报告用量触发压缩', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(30),
      provider: 'kimi-coding',
      modelId: 'kimi-for-coding',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-for-coding', recordedAt: 1 },
    })).toEqual({ shouldCompact: true, source: 'reported_usage' })
  })

  test('模型切换或未知窗口时保留消息数量兼容回退', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(61),
      provider: 'kimi-api',
      modelId: 'kimi-k3',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-k2.6', recordedAt: 1 },
    })).toEqual({ shouldCompact: true, source: 'legacy_message_count' })
  })
})
