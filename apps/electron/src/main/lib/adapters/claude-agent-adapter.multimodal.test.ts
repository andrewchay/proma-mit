import { describe, expect, mock, test } from 'bun:test'
import type { SDKMessage } from '@gravitas/shared'
import type { ClaudeAgentQueryOptions } from './claude-agent-adapter'
import Anthropic from '@anthropic-ai/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'

interface CapturedClaudeUserMessage {
  type: 'user'
  message: {
    role: 'user'
    content: unknown
  }
}

let capturedInitialMessage: CapturedClaudeUserMessage | undefined

function getCapturedInitialMessage(): CapturedClaudeUserMessage | undefined {
  return capturedInitialMessage
}

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: () => 'AQID',
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async () => '',
}))

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (input: { prompt: AsyncGenerator<CapturedClaudeUserMessage> }) => {
    const iterator = (async function* (): AsyncGenerator<SDKMessage> {
      capturedInitialMessage = (await input.prompt.next()).value
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sdk-session',
        terminal_reason: 'completed',
      } as unknown as SDKMessage
    })()
    return Object.assign(iterator, {
      close: () => {},
      interrupt: async () => {},
      setPermissionMode: async () => {},
    })
  },
}))

const { ClaudeAgentAdapter } = await import('./claude-agent-adapter')

describe('ClaudeAgentAdapter multimodal input', () => {
  test('given a user uploads a JPEG when Claude sends the turn then the SDK receives the real image block', async () => {
    capturedInitialMessage = undefined
    const adapter = new ClaudeAgentAdapter()

    const input: ClaudeAgentQueryOptions = {
      sessionId: 's-claude-jpeg',
      prompt: '理解这幅图',
      agentRuntime: 'claude',
      model: 'claude-test',
      cwd: '/tmp',
      sdkCliPath: '/tmp/claude',
      env: {},
      sdkPermissionMode: 'auto',
      allowDangerouslySkipPermissions: false,
      systemPrompt: '',
      attachments: [{
        id: 'jpeg-1',
        filename: 'photo.jpg',
        mediaType: 'image/jpeg',
        size: 3,
        localPath: '/tmp/photo.jpg',
      }],
    }

    for await (const _message of adapter.query(input)) {
      // 消费完整迭代器，让 mock SDK 读取初始 prompt。
    }

    expect(getCapturedInitialMessage()?.message.content).toEqual([
      { type: 'text', text: '理解这幅图' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: 'AQID',
        },
      },
    ])

    const sdkMessage = getCapturedInitialMessage()
    if (!sdkMessage) throw new Error('Claude SDK 未收到初始消息')
    let finalRequestBody: Record<string, unknown> | undefined
    const anthropic = new Anthropic({
      apiKey: 'test-key',
      fetch: (async (_input, init) => {
        finalRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof globalThis.fetch,
    })
    await anthropic.messages.create({
      model: 'claude-test',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: sdkMessage.message.content,
      } as MessageParam],
    })

    const apiMessages = finalRequestBody?.messages as Array<Record<string, unknown>> | undefined
    expect(apiMessages?.[0]?.content).toEqual([
      { type: 'text', text: '理解这幅图' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' },
      },
    ])
  })
})
