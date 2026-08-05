import { join } from 'node:path'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ProviderType } from '@gravitas/shared'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { getConfigDir } from '../config-paths'
import { getEffectiveProxyUrl } from '../proxy-settings-service'
import { loadPiCodingAgent } from './pi-sdk-loader'

export interface PiModelRegistrationInput {
  sessionId: string
  provider: ProviderType
  apiKey: string
  baseUrl: string
  modelId: string
}

export interface PiModelRegistration {
  modelRuntime: ModelRuntime
  providerId: string
  model: Model<Api>
  agentDir: string
}

interface PiProviderConfigInput {
  name?: string
  baseUrl?: string
  apiKey?: string
  api?: Api
  authHeader?: boolean
  headers?: Record<string, string>
  compat?: Model<Api>['compat']
  models?: Array<{
    id: string
    name: string
    api?: Api
    baseUrl?: string
    reasoning: boolean
    thinkingLevelMap?: Model<Api>['thinkingLevelMap']
    input: ('text' | 'image')[]
    cost: Model<Api>['cost']
    contextWindow: number
    maxTokens: number
    headers?: Record<string, string>
    compat?: Model<Api>['compat']
  }>
}

export function resolvePiApi(provider: ProviderType): Api {
  if (provider === 'google') return 'google-generative-ai'
  if (
    provider === 'openai' ||
    provider === 'deepseek-openai' ||
    provider === 'zhipu' ||
    provider === 'doubao' ||
    provider === 'qwen' ||
    provider === 'custom'
  ) {
    return 'openai-completions'
  }
  return 'anthropic-messages'
}

export function resolvePiBaseUrl(provider: ProviderType, baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '')
  if (provider === 'google') {
    return /\/v\d+(beta)?$/.test(normalized) ? normalized : `${normalized}/v1beta`
  }
  if (provider === 'kimi-coding') {
    return normalized
      .replace(/\/v\d+\/messages$/, '')
      .replace(/\/v\d+$/, '')
  }
  if (
    provider === 'openai' ||
    provider === 'deepseek-openai' ||
    provider === 'zhipu' ||
    provider === 'doubao' ||
    provider === 'qwen' ||
    provider === 'custom'
  ) {
    return resolveAgentRuntimeBaseUrl(provider, 'proma', baseUrl)
  }
  return normalized
}

export function shouldUsePiAuthHeader(provider: ProviderType): boolean {
  return provider !== 'google'
}

export function resolvePiMaxTokens(provider: ProviderType): number {
  if (provider === 'qwen') return 16_384
  if (provider === 'kimi-coding') return 32_768
  return 64_000
}

/**
 * 按模型 ID 推断 contextWindow（Pi SDK 自动压缩阈值依赖此值）。
 *
 * 与渲染端 inferContextWindow 保持一致，避免 DeepSeek V4（1M）/ Claude
 * Sonnet 4.6 / Opus 4.6+（1M）被 200K 兜底值错误降级，导致上下文过早触发
 * 自动压缩（对齐官方 v0.13.x 的 1M 模型窗口修复）。
 */
export function inferPiContextWindow(modelId: string | undefined | null): number {
  if (!modelId) return 200_000
  const m = modelId.toLowerCase()
  if (m.includes('claude-haiku')) return 200_000
  if (m.includes('claude-sonnet-4-6') || m.includes('claude-opus-4-6') || m.includes('claude-opus-4-7')) return 1_000_000
  if (m.includes('deepseek-v4')) return 1_000_000
  return 200_000
}

function buildPiModelConfig(input: PiModelRegistrationInput, api: Api, baseUrl: string): NonNullable<PiProviderConfigInput['models']>[number] {
  const model: NonNullable<PiProviderConfigInput['models']>[number] = {
    id: input.modelId,
    name: input.modelId,
    api,
    baseUrl,
    reasoning: true,
    input: input.provider === 'kimi-coding' ? ['text'] : ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: inferPiContextWindow(input.modelId),
    maxTokens: resolvePiMaxTokens(input.provider),
  }

  if (input.provider === 'google') {
    model.thinkingLevelMap = { off: null }
  }

  if (input.provider === 'kimi-coding') {
    model.headers = { 'User-Agent': 'KimiCLI/1.5' }
    model.compat = { allowEmptySignature: true, forceAdaptiveThinking: true } as Model<Api>['compat']
  }

  if (input.provider === 'qwen') {
    model.reasoning = input.modelId.startsWith('qwen3')
    model.compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      ...(input.modelId.startsWith('qwen3') ? { thinkingFormat: 'qwen' } : {}),
    } as Model<Api>['compat']
  }

  return model
}

export function resolvePiProviderId(provider: ProviderType, sessionId: string): string {
  return `proma-${provider}-${sessionId}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

export async function registerPiModelFromChannel(input: PiModelRegistrationInput): Promise<PiModelRegistration> {
  const agentDir = join(getConfigDir(), 'pi-runtime')
  const providerId = resolvePiProviderId(input.provider, input.sessionId)
  const api = resolvePiApi(input.provider)
  const baseUrl = resolvePiBaseUrl(input.provider, input.baseUrl)
  const { ModelRuntime } = await loadPiCodingAgent()

  // Pi 模型请求跟随 Proma 代理设置（Pi SDK 支持通过 env 传递代理变量）
  const proxyUrl = await getEffectiveProxyUrl()
  const proxyEnv = proxyUrl?.trim()
    ? { HTTPS_PROXY: proxyUrl.trim(), HTTP_PROXY: proxyUrl.trim() }
    : undefined

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
    ...(proxyEnv ? { env: proxyEnv } : {}),
  })

  const config: PiProviderConfigInput = {
    name: `Proma ${input.provider}`,
    baseUrl,
    api,
    apiKey: input.apiKey,
    authHeader: shouldUsePiAuthHeader(input.provider),
    models: [buildPiModelConfig(input, api, baseUrl)],
  }

  modelRuntime.registerProvider(providerId, config)
  await modelRuntime.setRuntimeApiKey(providerId, input.apiKey)

  const model = modelRuntime.getModel(providerId, input.modelId)
  if (!model) {
    throw new Error(`Pi Runtime 模型注册失败：${providerId}/${input.modelId}`)
  }

  return { modelRuntime, providerId, model, agentDir }
}
