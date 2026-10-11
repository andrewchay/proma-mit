import { describe, expect, test } from 'bun:test'
import { resolveEditRewindAnchor, stripAttachmentBlocks } from './edit-user-message'
import type { SDKMessage } from '@gravitas/shared'

/** 构造最小可用的顶层消息 */
function makeMessage(type: 'user' | 'assistant', uuid: string): SDKMessage {
  return { type, uuid } as unknown as SDKMessage
}

describe('编辑用户消息重发 —— 回退锚点定位', () => {
  test('目标消息之前最近一条顶层 assistant 消息作为锚点', () => {
    const messages = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
      makeMessage('user', 'u3'),
    ]
    expect(resolveEditRewindAnchor(messages, 'u3')).toEqual({
      anchorAssistantUuid: 'a2',
      keptCount: 4,
    })
  })

  test('编辑倒数第二条用户消息：忽略其后所有内容', () => {
    const messages = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      makeMessage('assistant', 'a2'),
    ]
    const plan = resolveEditRewindAnchor(messages, 'u2')
    expect(plan?.anchorAssistantUuid).toBe('a1')
    expect(plan?.keptCount).toBe(2)
  })

  test('首条用户消息没有回退锚点，返回 null', () => {
    const messages = [makeMessage('user', 'u1'), makeMessage('assistant', 'a1')]
    expect(resolveEditRewindAnchor(messages, 'u1')).toBeNull()
  })

  test('目标消息不存在时返回 null', () => {
    const messages = [makeMessage('user', 'u1'), makeMessage('assistant', 'a1')]
    expect(resolveEditRewindAnchor(messages, 'missing')).toBeNull()
  })

  test('锚点消息缺少 uuid 时继续向前查找', () => {
    const messages = [
      makeMessage('user', 'u1'),
      makeMessage('assistant', 'a1'),
      makeMessage('user', 'u2'),
      { type: 'assistant' } as unknown as SDKMessage, // 无 uuid，不可作锚点
      makeMessage('user', 'u3'),
    ]
    expect(resolveEditRewindAnchor(messages, 'u3')?.anchorAssistantUuid).toBe('a1')
  })
})

describe('编辑用户消息重发 —— 回填文本剥离', () => {
  test('剥离 attached_files 块并保留正文', () => {
    const raw = '<attached_files>\n- a.png: /tmp/a.png\n</attached_files>\n\n帮我看看这张图'
    expect(stripAttachmentBlocks(raw)).toBe('帮我看看这张图')
  })

  test('剥离 quoted_file 块', () => {
    const raw = '<quoted_file path="/tmp/a.ts">\nconst a = 1\n</quoted_file>\n\n修改这个变量'
    expect(stripAttachmentBlocks(raw)).toBe('修改这个变量')
  })

  test('普通文本原样返回（仅去首尾空白）', () => {
    expect(stripAttachmentBlocks('  直接编辑我  ')).toBe('直接编辑我')
  })
})
