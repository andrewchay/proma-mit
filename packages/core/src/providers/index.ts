/**
 * Provider 适配器注册表
 *
 * 集中管理所有已注册的供应商适配器，
 * 通过 ProviderType 查找对应的适配器实例。
 */

import type { ProviderType } from '@gravitas/shared'
import type { ProviderAdapter } from './types.ts'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'

// 导出所有类型和工具
export * from './types.ts'
export * from './sse-reader.ts'
export * from './url-utils.ts'
export * from './thinking-capability.ts'

// 导出适配器类
export { AnthropicAdapter } from './anthropic-adapter.ts'
export { OpenAIAdapter } from './openai-adapter.ts'
export { GoogleAdapter } from './google-adapter.ts'
export { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'

/** 供应商适配器注册表 */
const adapterRegistry = new Map<ProviderType, ProviderAdapter>([
  ['anthropic', new AnthropicAdapter()],
  ['openai', new OpenAIAdapter()],
  ['openai-responses', new OpenAIResponsesAdapter()],  // OpenAI Responses API（o 系列 / GPT-5 原生接口）
  ['deepseek', new AnthropicAdapter('deepseek')],   // DeepSeek 使用 Anthropic 兼容协议
  ['deepseek-openai', new OpenAIAdapter()],         // DeepSeek OpenAI 兼容协议
  ['kimi-api', new AnthropicAdapter('kimi-api')],       // Kimi API 的 Anthropic 协议端点
  ['kimi-coding', new AnthropicAdapter('kimi-coding')], // Kimi Coding Plan 订阅制（强制 User-Agent）
  ['zhipu', new OpenAIAdapter()],                    // 智谱 AI 使用 OpenAI 兼容协议
  ['zhipu-coding', new AnthropicAdapter('zhipu-coding')],       // 智谱 Coding Plan 订阅制（Anthropic 协议端点）
  ['zhipu-coding-team', new AnthropicAdapter('zhipu-coding-team')], // 智谱 Coding Plan 团队版
  ['minimax', new AnthropicAdapter('minimax')], // MiniMax 使用 Anthropic 兼容协议
  ['doubao', new OpenAIAdapter()],        // 豆包使用 OpenAI 兼容协议
  ['ark-coding-plan', new AnthropicAdapter('ark-coding-plan')], // 火山方舟 Agent Plan 订阅制（Anthropic 协议）
  ['qwen', new OpenAIAdapter()],          // 通义千问使用 OpenAI 兼容协议
  ['qwen-anthropic', new AnthropicAdapter('qwen-anthropic')],     // 通义千问 DashScope Anthropic 兼容协议
  ['qwen-token-plan', new AnthropicAdapter('qwen-token-plan')],   // 通义千问 Token Plan 订阅制（完整 messages URL）
  ['xiaomi', new AnthropicAdapter('xiaomi')],       // 小米 MiMo API 使用 Anthropic 兼容协议
  ['xai', new OpenAIAdapter()],          // xAI (Grok) 使用 OpenAI 兼容协议
  // github-copilot：OAuth 订阅渠道，请求由 Pi runtime 承担；适配器仅作通用回退
  ['github-copilot', new OpenAIAdapter()],
  ['custom', new OpenAIAdapter()],        // 自定义也使用 OpenAI 兼容协议
  ['google', new GoogleAdapter()],
])

/**
 * 根据供应商类型获取适配器
 *
 * @param provider 供应商类型
 * @returns 对应的适配器实例
 * @throws Error 如果供应商类型不支持
 */
export function getAdapter(provider: ProviderType): ProviderAdapter {
  const adapter = adapterRegistry.get(provider)
  if (!adapter) {
    throw new Error(`不支持的供应商: ${provider}。你可能过去使用的是 Proma 商业版，请重新下载商业版覆盖安装，当前版本为开源版本。`)
  }
  return adapter
}
