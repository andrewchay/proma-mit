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
    })).toMatchObject({ shouldCompact: false, source: 'reported_usage' })
  })

  test('Gravitas runtime 将 K3 简写按 1M 预算处理', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(61),
      provider: 'kimi-api',
      modelId: 'K3',
      observedUsage: { contextTokens: 200_000, modelId: 'K3', recordedAt: 1 },
    })).toMatchObject({ shouldCompact: false, source: 'reported_usage' })
  })

  test('Kimi 256K 模型接近输入预算时触发压缩', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(30),
      provider: 'kimi-api',
      modelId: 'kimi-k2.6',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-k2.6', recordedAt: 1 },
    })).toMatchObject({ shouldCompact: true, source: 'reported_usage' })
  })

  test('Kimi for Coding 在 256K 窗口耗用 220K 时按报告用量触发压缩', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(30),
      provider: 'kimi-coding',
      modelId: 'kimi-for-coding',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-for-coding', recordedAt: 1 },
    })).toMatchObject({ shouldCompact: true, source: 'reported_usage' })
  })

  test('模型切换时忽略陈旧 usage，并按当前 outgoing payload 估算', () => {
    expect(resolveAutoCompactionTrigger({
      historyMessages: makeHistory(61),
      provider: 'kimi-api',
      modelId: 'kimi-k3',
      observedUsage: { contextTokens: 220_000, modelId: 'kimi-k2.6', recordedAt: 1 },
    })).toMatchObject({ shouldCompact: false, source: 'estimated_payload' })
  })
  test('Gemini 4 在 400K 输入时不再按 256K 提前压缩，手动下调后生效', () => {
    const input = {
      historyMessages: makeHistory(30), provider: 'custom' as const, modelId: 'gemini-4-argon',
      observedUsage: { contextTokens: 400_000, modelId: 'gemini-4-argon', recordedAt: 1 },
    }
    expect(resolveAutoCompactionTrigger(input).shouldCompact).toBe(false)
    expect(resolveAutoCompactionTrigger({ ...input, contextWindowOverride: 256_000 }).shouldCompact).toBe(true)
    expect(resolveAutoCompactionTrigger({ ...input, contextWindowOverride: 800_000 }).inputBudgetTokens).toBe(760_000)
  })

  test('手动设置小窗口时，输出与安全预留不会吞掉全部输入预算', () => {
    expect(resolveAutoCompactionTrigger({ historyMessages: makeHistory(2), provider: 'custom', modelId: 'small', contextWindowOverride: 32_000 })).toMatchObject({ inputBudgetTokens: 22_000, shouldCompact: false })
  })

})
