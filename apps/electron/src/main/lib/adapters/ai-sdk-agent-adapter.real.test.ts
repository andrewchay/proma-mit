/**
 * AI SDK Runtime 真实 API smoke 测试。
 *
 * 默认不请求外网；只有设置对应 provider 的 API Key 环境变量时才会运行该 provider。
 * 2026-07-20 已手动验证通过：DeepSeek、Google、Kimi Coding Plan、Zhipu、Qwen。
 * 用法示例：
 *   PROMA_AI_SDK_REAL_API=1 PROMA_AI_SDK_OPENAI_API_KEY=... bun test apps/electron/src/main/lib/adapters/ai-sdk-agent-adapter.real.test.ts
 */

import { describe, expect, mock, test } from 'bun:test'
import type { AgentEvent, ProviderType, SDKMessage, SDKResultMessage } from '@proma/shared'
import { getAgentCompatibleProviders, PROVIDER_DEFAULT_URLS } from '@proma/shared'

mock.module('electron', () => ({
  BrowserWindow: class MockBrowserWindow {},
  session: { fromPartition: () => ({ setPermissionRequestHandler: () => {} }) },
  app: { isReady: () => true },
  desktopCapturer: { getSources: async () => [] },
  screen: { getPrimaryDisplay: () => ({ bounds: { width: 0, height: 0 } }) },
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
    showSaveDialog: () => Promise.resolve({ canceled: true, filePath: '' }),
  },
  shell: { openExternal: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}))

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  readAttachmentAsBase64: (localPath: string) => `base64:${localPath}`,
}))

mock.module('../document-parser', () => ({
  isDocumentAttachment: (mediaType: string) => mediaType === 'text/plain',
  extractTextFromAttachment: async (localPath: string) => `文档内容：${localPath}`,
}))

const { AISDKAgentAdapter } = await import('./ai-sdk-agent-adapter')

interface AISDKSmokeProviderCase {
  provider: ProviderType
  apiKeyEnv: string
  fallbackApiKeyEnv?: string
  modelEnv: string
  defaultModel: string
  baseUrlEnv: string
  defaultBaseUrl: string
}

interface ActiveAISDKSmokeProviderCase extends AISDKSmokeProviderCase {
  apiKey: string
  model: string
  baseUrl: string
}

const AI_SDK_SMOKE_MATRIX: readonly AISDKSmokeProviderCase[] = [
  {
    provider: 'anthropic',
    apiKeyEnv: 'PROMA_AI_SDK_ANTHROPIC_API_KEY',
    fallbackApiKeyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'PROMA_AI_SDK_ANTHROPIC_MODEL',
    defaultModel: 'claude-3-5-haiku-latest',
    baseUrlEnv: 'PROMA_AI_SDK_ANTHROPIC_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.anthropic,
  },
  {
    provider: 'google',
    apiKeyEnv: 'PROMA_AI_SDK_GOOGLE_API_KEY',
    fallbackApiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    modelEnv: 'PROMA_AI_SDK_GOOGLE_MODEL',
    defaultModel: 'gemini-3.5-flash',
    baseUrlEnv: 'PROMA_AI_SDK_GOOGLE_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.google,
  },
  {
    provider: 'openai',
    apiKeyEnv: 'PROMA_AI_SDK_OPENAI_API_KEY',
    fallbackApiKeyEnv: 'OPENAI_API_KEY',
    modelEnv: 'PROMA_AI_SDK_OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    baseUrlEnv: 'PROMA_AI_SDK_OPENAI_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.openai,
  },
  {
    provider: 'deepseek',
    apiKeyEnv: 'PROMA_AI_SDK_DEEPSEEK_API_KEY',
    fallbackApiKeyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'PROMA_AI_SDK_DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    baseUrlEnv: 'PROMA_AI_SDK_DEEPSEEK_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.deepseek,
  },
  {
    provider: 'kimi-api',
    apiKeyEnv: 'PROMA_AI_SDK_KIMI_API_KEY',
    fallbackApiKeyEnv: 'MOONSHOT_API_KEY',
    modelEnv: 'PROMA_AI_SDK_KIMI_API_MODEL',
    defaultModel: 'kimi-k2-0711-preview',
    baseUrlEnv: 'PROMA_AI_SDK_KIMI_API_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS['kimi-api'],
  },
  {
    provider: 'kimi-coding',
    apiKeyEnv: 'PROMA_AI_SDK_KIMI_CODING_API_KEY',
    modelEnv: 'PROMA_AI_SDK_KIMI_CODING_MODEL',
    defaultModel: 'kimi-for-coding',
    baseUrlEnv: 'PROMA_AI_SDK_KIMI_CODING_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS['kimi-coding'],
  },
  {
    provider: 'zhipu',
    apiKeyEnv: 'PROMA_AI_SDK_ZHIPU_API_KEY',
    modelEnv: 'PROMA_AI_SDK_ZHIPU_MODEL',
    defaultModel: 'glm-4-flash',
    baseUrlEnv: 'PROMA_AI_SDK_ZHIPU_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.zhipu,
  },
  {
    provider: 'doubao',
    apiKeyEnv: 'PROMA_AI_SDK_DOUBAO_API_KEY',
    modelEnv: 'PROMA_AI_SDK_DOUBAO_MODEL',
    defaultModel: 'doubao-seed-1-6-flash-250615',
    baseUrlEnv: 'PROMA_AI_SDK_DOUBAO_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.doubao,
  },
  {
    provider: 'qwen',
    apiKeyEnv: 'PROMA_AI_SDK_QWEN_API_KEY',
    fallbackApiKeyEnv: 'DASHSCOPE_API_KEY',
    modelEnv: 'PROMA_AI_SDK_QWEN_MODEL',
    defaultModel: 'qwen-turbo',
    baseUrlEnv: 'PROMA_AI_SDK_QWEN_BASE_URL',
    defaultBaseUrl: PROVIDER_DEFAULT_URLS.qwen,
  },
  {
    provider: 'custom',
    apiKeyEnv: 'PROMA_AI_SDK_CUSTOM_API_KEY',
    modelEnv: 'PROMA_AI_SDK_CUSTOM_MODEL',
    defaultModel: '',
    baseUrlEnv: 'PROMA_AI_SDK_CUSTOM_BASE_URL',
    defaultBaseUrl: '',
  },
]

function getEnvValue(primary: string, fallback?: string): string | undefined {
  return process.env[primary] ?? (fallback ? process.env[fallback] : undefined)
}

function resolveActiveCase(entry: AISDKSmokeProviderCase): ActiveAISDKSmokeProviderCase | undefined {
  const apiKey = getEnvValue(entry.apiKeyEnv, entry.fallbackApiKeyEnv)
  if (!apiKey) return undefined

  const model = process.env[entry.modelEnv] ?? entry.defaultModel
  const baseUrl = process.env[entry.baseUrlEnv] ?? entry.defaultBaseUrl
  if (!model || !baseUrl) return undefined

  return { ...entry, apiKey, model, baseUrl }
}

function extractAssistantText(messages: SDKMessage[]): string {
  return messages
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => {
      const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content ?? []
      return content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text ?? '')
    })
    .join('\n')
}

const shouldRunRealAISDKSmoke = process.env.PROMA_AI_SDK_REAL_API === '1'
const activeCases = shouldRunRealAISDKSmoke
  ? AI_SDK_SMOKE_MATRIX
    .map(resolveActiveCase)
    .filter((entry): entry is ActiveAISDKSmokeProviderCase => entry !== undefined)
  : []

describe('AI SDK Runtime smoke matrix 配置', () => {
  test('matrix 覆盖所有声明支持 AI SDK runtime 的 provider', () => {
    expect(AI_SDK_SMOKE_MATRIX.map((entry) => entry.provider).sort()).toEqual(
      getAgentCompatibleProviders('ai-sdk').sort(),
    )
  })

  test('非 custom provider 默认 baseURL 与渠道默认值保持一致', () => {
    for (const entry of AI_SDK_SMOKE_MATRIX) {
      if (entry.provider === 'custom') continue
      expect(entry.defaultBaseUrl).toBe(PROVIDER_DEFAULT_URLS[entry.provider])
    }
  })
})

;(activeCases.length > 0 ? describe : describe.skip)('AI SDK Runtime 真实 API smoke', () => {
  for (const entry of activeCases) {
    test(`${entry.provider} 可以完成最小文本响应并上报实时事件`, async () => {
      const adapter = new AISDKAgentAdapter()
      const messages: SDKMessage[] = []
      const events: AgentEvent[] = []

      for await (const message of adapter.query({
        sessionId: `ai-sdk-smoke-${entry.provider}-${Date.now()}`,
        prompt: '请只回复 OK 两个字母，不要解释。',
        agentRuntime: 'ai-sdk',
        provider: entry.provider,
        apiKey: entry.apiKey,
        baseUrl: entry.baseUrl,
        model: entry.model,
        cwd: process.cwd(),
        permissionMode: 'safe',
        maxTurns: 2,
        onAgentEvent: (event) => events.push(event),
      })) {
        messages.push(message)
      }

      const result = messages.find((message) => message.type === 'result') as SDKResultMessage | undefined
      expect(result?.subtype).toBe('success')
      expect(extractAssistantText(messages).length > 0).toBe(true)
      expect(events.some((event) => event.type === 'text_delta')).toBe(true)
    }, 60_000)
  }
})
