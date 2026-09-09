import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@gravitas/shared'
import {
  estimateOutgoingContextTokens,
  pruneOldToolResults,
  resolveAdaptiveKeepRecent,
  resolveAutoCompactionTrigger,
} from './context-compaction'

function textMessage(text: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

function toolResultMessage(content: string, toolUseId: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    parent_tool_use_id: null,
  } as unknown as SDKMessage
}

describe('ContextGovernor P2', () => {
  test('given few messages with a huge tool result then the outgoing token budget triggers compaction', () => {
    const history = [toolResultMessage('x'.repeat(900_000), 'tool-huge')]
    const trigger = resolveAutoCompactionTrigger({
      historyMessages: history,
      provider: 'kimi-coding',
      modelId: 'kimi-for-coding',
      currentPrompt: '继续处理',
    })

    expect(trigger.shouldCompact).toBe(true)
    expect(trigger.source).toBe('estimated_payload')
    expect(trigger.estimatedInputTokens).toBeGreaterThan(216_000)
  })

  test('given many tiny messages below the budget then message count alone does not trigger compaction', () => {
    const history = Array.from({ length: 100 }, () => textMessage('ok'))
    const trigger = resolveAutoCompactionTrigger({
      historyMessages: history,
      provider: 'kimi-coding',
      modelId: 'kimi-for-coding',
      currentPrompt: '继续',
    })

    expect(trigger.shouldCompact).toBe(false)
    expect(trigger.source).toBe('estimated_payload')
  })

  test('old successful tool results are pruned from the model view while recent results and source objects remain intact', () => {
    const oldContent = 'old-result-'.repeat(2_000)
    const recentContent = 'recent-result-'.repeat(2_000)
    const history = [
      toolResultMessage(oldContent, 'tool-old'),
      ...Array.from({ length: 20 }, (_, index) => textMessage(`最近消息 ${index}`)),
      toolResultMessage(recentContent, 'tool-recent'),
    ]

    const result = pruneOldToolResults(history, { keepRecentMessages: 20 })
    const serialized = JSON.stringify(result.history)

    expect(result.prunedResults).toBe(1)
    expect(serialized).toContain('tool-old')
    expect(serialized).toContain('较早工具结果已从模型视图裁剪')
    expect(serialized).toContain(recentContent)
    expect(JSON.stringify(history)).toContain(oldContent)
  })

  test('outgoing estimate includes history, prompt, system instructions and tool schemas', () => {
    const base = estimateOutgoingContextTokens({ historyMessages: [textMessage('history')] })
    const full = estimateOutgoingContextTokens({
      historyMessages: [textMessage('history')],
      currentPrompt: 'prompt'.repeat(100),
      systemPrompt: 'system'.repeat(100),
      tools: [{ name: 'Read', description: 'read'.repeat(100), parameters: { type: 'object' } }],
    })

    expect(full).toBeGreaterThan(base)
  })

  test('a single oversized recent item is summarized instead of being kept past the low-water budget', () => {
    const history = [toolResultMessage('x'.repeat(900_000), 'tool-huge')]
    expect(resolveAdaptiveKeepRecent({
      historyMessages: history,
      inputBudgetTokens: 216_000,
      desiredKeepRecent: 20,
      currentPrompt: '继续',
    })).toBe(0)
  })
})
