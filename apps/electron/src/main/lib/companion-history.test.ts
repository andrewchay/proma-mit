import { describe, expect, test } from 'bun:test'
import { extractCompanionHistory } from './companion-history'

/**
 * Companion 历史提取测试：从 SDK 消息流中提取手机端可读的会话历史。
 * SDKMessage 为宽松类型（含 [key: string]: unknown），提取必须容错。
 */

describe('extractCompanionHistory', () => {
  test('提取 user/assistant 文本与工具活动，跳过 result/system 等元消息', () => {
    const messages = [
      { type: 'system', subtype: 'init' },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: '看一下现在有哪些文件' }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来看一下目录。' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'total 0' }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '目录里有 3 个文件。' }] },
      },
      { type: 'result', subtype: 'success' },
    ]

    const entries = extractCompanionHistory(messages)
    expect(entries.map((e) => `${e.role}:${e.text}`)).toEqual([
      'user:看一下现在有哪些文件',
      'assistant:我来看一下目录。',
      'tool:Bash',
      'assistant:目录里有 3 个文件。',
    ])
  })

  test('content 为纯字符串、缺块与畸形消息均不抛错', () => {
    const messages = [
      { type: 'user', message: { role: 'user', content: '字符串内容' } },
      { type: 'assistant' },
      null,
      'not-an-object',
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text' }, { type: 'text', text: 'ok' }] } },
    ]
    const entries = extractCompanionHistory(messages as never)
    expect(entries.map((e) => `${e.role}:${e.text}`)).toEqual(['user:字符串内容', 'assistant:ok'])
  })

  test('maxEntries 只保留最后 N 条', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: `msg-${i}` }] },
    }))
    const entries = extractCompanionHistory(messages, 3)
    expect(entries.map((e) => e.text)).toEqual(['msg-7', 'msg-8', 'msg-9'])
  })

  test('空数组与非数组输入返回空', () => {
    expect(extractCompanionHistory([])).toEqual([])
    expect(extractCompanionHistory(undefined as never)).toEqual([])
  })
})
