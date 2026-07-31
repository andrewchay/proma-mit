import { describe, expect, test } from 'bun:test'
import type { SDKAssistantMessage, SDKMessage } from '@proma/shared'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai'
import { convertPiMessageToSDKMessage, convertPiMessagesToSDKMessages, convertSDKMessagesToPiMessages } from './pi-message-adapter'

describe('pi-message-adapter', () => {
  test('converts Pi assistant text, thinking and tool call blocks to SDK assistant messages', () => {
    const piMessage: AssistantMessage = {
      role: 'assistant',
      api: 'openai-completions',
      provider: 'proma-openai',
      model: 'gpt-5.2',
      content: [
        { type: 'thinking', thinking: '先看文件' },
        { type: 'text', text: '可以处理' },
        { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'README.md' } },
      ],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp: 1,
    }

    const [sdkMessage] = convertPiMessagesToSDKMessages([piMessage], 's1', 'channel-model')

    expect(sdkMessage?.type).toBe('assistant')
    const assistantMessage = sdkMessage as SDKAssistantMessage
    expect(assistantMessage.message.content).toEqual([
      { type: 'thinking', thinking: '先看文件' },
      { type: 'text', text: '可以处理' },
      { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } },
    ])
    expect(assistantMessage.message.usage?.input_tokens).toBe(10)
    expect(assistantMessage._channelModelId).toBe('channel-model')
  })

  test('converts SDK text history back to Pi messages', () => {
    const history: SDKMessage[] = [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '你好' }] },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: '你好，有什么可以帮你？' }],
          model: 'gpt-5.2',
        },
        parent_tool_use_id: null,
      },
    ]

    const piMessages = convertSDKMessagesToPiMessages(history)

    expect(piMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(piMessages[0]).toMatchObject({ role: 'user', content: '你好' })
    expect(piMessages[1]).toMatchObject({ role: 'assistant', model: 'gpt-5.2' })
  })

  test('preserves screenshot image blocks when Pi tool results are persisted and restored as history', () => {
    const piToolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'screenshot-1',
      toolName: 'WebBridgeScreenshot',
      content: [
        { type: 'text', text: '截图已获取' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
      isError: false,
      timestamp: 1,
    }

    const sdkMessage = convertPiMessageToSDKMessage(piToolResult, 's1')
    if (!sdkMessage) throw new Error('Pi 工具结果未转换为 SDK 消息')
    const restored = convertSDKMessagesToPiMessages([sdkMessage])

    expect(restored).toEqual([expect.objectContaining({
      role: 'toolResult',
      toolCallId: 'screenshot-1',
      content: [
        { type: 'text', text: '截图已获取' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })])
  })
})
