import { describe, expect, test, mock } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'

mock.module('electron', () => buildElectronMock())
const { codexChatHistory, codexChatTools, codexToolResults } = await import('./codex-chat')

describe('Codex Chat transcript', () => {
  test('保留历史和工具调用的文本上下文', () => {
    const messages = codexChatHistory([
      { id: 'u', role: 'user', content: '你好', createdAt: 1 },
      { id: 'a', role: 'assistant', content: '世界', createdAt: 2 },
    ])
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]).toMatchObject({ content: '你好' })
    expect(messages[1]).toMatchObject({ provider: 'openai-codex', api: 'openai-codex-responses' })
  })

  test('工具定义和返回符合 Pi transcript 形状', () => {
    const tools = codexChatTools([{ name: 'look_up', description: '查询', parameters: { type: 'object', properties: {} } }])
    expect(tools?.[0]).toMatchObject({ name: 'look_up', parameters: { type: 'object' } })
    expect(codexToolResults([{ toolCallId: 'call-1', toolName: 'look_up', content: '完成' }])[0])
      .toMatchObject({ role: 'toolResult', toolCallId: 'call-1', toolName: 'look_up', content: [{ type: 'text', text: '完成' }] })
  })
})
