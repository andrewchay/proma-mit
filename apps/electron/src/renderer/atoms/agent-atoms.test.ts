import { describe, expect, test } from 'bun:test'
import { mergeLiveMessage } from './agent-atoms'
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'

function assistantMessage(uuid: string, text: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: 's1',
    uuid,
    ...extra,
  } as unknown as SDKMessage
}

function userMessage(uuid: string): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'text', text: 'optimistic' }] },
    parent_tool_use_id: null,
    session_id: 's1',
    uuid,
  } as unknown as SDKMessage
}

describe('mergeLiveMessage 流式消息合并', () => {
  test('assistant partial 快照带同一 uuid 时替换旧快照（累积文本保留最新）', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, assistantMessage('a1', '我需要'))
    list = mergeLiveMessage(list, assistantMessage('a1', '我需要...现在'))
    list = mergeLiveMessage(list, assistantMessage('a1', '我需要...现在完成'))

    expect(list).toHaveLength(1)
    const content = (list[0] as SDKAssistantMessage).message.content
    expect(content).toHaveLength(1)
    expect((content[0] as { text: string }).text).toBe('我需要...现在完成')
  })

  test('assistant final 消息同 uuid 覆盖 partial 快照', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, assistantMessage('b1', '部分文本'))
    list = mergeLiveMessage(list, assistantMessage('b1', '完整最终文本'))

    expect(list).toHaveLength(1)
    const content = (list[0] as SDKAssistantMessage).message.content
    expect((content[0] as { text: string }).text).toBe('完整最终文本')
  })

  test('不同 uuid 的 assistant 消息按顺序追加', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, assistantMessage('c1', '第一条'))
    list = mergeLiveMessage(list, assistantMessage('c2', '第二条'))

    expect(list).toHaveLength(2)
    expect((list[1] as SDKAssistantMessage).message.content[0] as { text: string }).toMatchObject({ text: '第二条' })
  })

  test('assistant 替换不改变消息顺序（后续消息保持位置）', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, assistantMessage('d1', '快照1'))
    list = mergeLiveMessage(list, assistantMessage('d2', '另一条'))
    list = mergeLiveMessage(list, assistantMessage('d1', '快照1最终'))

    expect(list).toHaveLength(2)
    const first = list[0] as SDKAssistantMessage
    const second = list[1] as SDKAssistantMessage
    expect((first.message.content[0] as { text: string }).text).toBe('快照1最终')
    expect((second.message.content[0] as { text: string }).text).toBe('另一条')
  })

  test('非 assistant 消息带 uuid 时同 uuid 跳过（乐观注入去重）', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, userMessage('u1'))
    const result = mergeLiveMessage(list, userMessage('u1'))

    expect(result).toHaveLength(1)
  })

  test('无 uuid 消息直接追加', () => {
    let list: SDKMessage[] = []
    list = mergeLiveMessage(list, { type: 'system', subtype: 'status', session_id: 's1', message: 'x' } as unknown as SDKMessage)
    list = mergeLiveMessage(list, assistantMessage('', '无 uuid 文本'))

    expect(list).toHaveLength(2)
  })
})
