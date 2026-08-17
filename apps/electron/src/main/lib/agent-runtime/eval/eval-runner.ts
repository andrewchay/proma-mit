/**
 * 评测运行器：把评测闭环接到真实渠道与真实模型。
 *
 * 提供三样生产接入件：
 * 1. `resolveEvalChannel(benchmark)` —— 解析评测用的渠道与凭据（benchmark.runtime.channelId 优先，
 *    否则用应用默认 Agent 渠道）。
 * 2. `buildEvalDelegate(channelInfo)` —— 生成一个真实 SubAgentDelegate：内部用
 *    `ProviderAgnosticAgentAdapter.query` 在隔离沙箱 cwd 里跑被测子代理，返回其文本输出。
 * 3. `buildBuiltinStateGuard(targetAgentId)` —— 对内置 sub-agent（buildBuiltinAgents）做
 *    版本化快照/候选应用/回滚的 StateGuard。
 *
 * 与现有主路径解耦：评测完全旁路，不写入用户真实 session；只在评测沙箱运行。
 */

import { getChannelById, decryptApiKey } from '../../channel-manager'
import { getSettings } from '../../settings-service'
import { ProviderAgnosticAgentAdapter } from '../../adapters/provider-agnostic-agent-adapter'
import { resolveAgentRuntimeBaseUrl } from '@gravitas/shared'
import { buildBuiltinAgents } from '../../agent-prompt-builder'
import type { ProviderType } from '@gravitas/shared'
import type { SubAgentDelegate } from './evaluator'
import type { BenchmarkConfig } from './types'

// 内置 sub-agent 状态快照/回滚（纯逻辑）
import { readBuiltinPrompt } from './builtin-agent-state'
export { buildBuiltinStateGuard, readBuiltinPrompt } from './builtin-agent-state'

/** 评测渠道依赖（由 resolveEvalChannel 组装，注入 delegate）。 */
export interface EvalChannelInfo {
  channelId: string
  provider: ProviderType
  apiKey: string
  baseUrl: string
  modelId: string
}

/** 解析评测渠道。 */
export function resolveEvalChannel(benchmark: BenchmarkConfig): EvalChannelInfo {
  const channelId = benchmark.runtime.channelId ?? getSettings().agentChannelId
  if (!channelId) {
    throw new Error('没有可用 Agent 渠道：请在设置中选择默认 Agent 渠道，或在 benchmark.runtime.channelId 指定')
  }
  const channel = getChannelById(channelId)
  if (!channel) throw new Error(`评测渠道不存在: ${channelId}`)
  const modelId = benchmark.runtime.modelId || channel.models.find((m) => m.enabled)?.id
  if (!modelId) throw new Error(`评测渠道 ${channel.name} 未配置可用模型`)
  return {
    channelId,
    provider: channel.provider,
    apiKey: decryptApiKey(channelId),
    baseUrl: resolveAgentRuntimeBaseUrl(channel.provider, 'proma', channel.baseUrl),
    modelId,
  }
}

/**
 * 生成真实 SubAgentDelegate：在隔离沙箱里运行被测子代理。
 * 系统提示 = 内置子代理 prompt + 评测任务（协议返回在 prompt 内已要求）。
 */
export function buildEvalDelegate(channel: EvalChannelInfo): SubAgentDelegate {
  const adapter = new ProviderAgnosticAgentAdapter()
  let running = true
  return async (input) => {
    const ctx = { provider: channel.provider, apiKey: channel.apiKey, baseUrl: channel.baseUrl, model: channel.modelId }
    const messages: import('@gravitas/shared').SDKMessage[] = []
    try {
      for await (const msg of adapter.query({
        sessionId: `eval-${Date.now()}`,
        prompt: input.task,
        model: ctx.model,
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        cwd: input.workspaceDir,
        // 系统提示 = 被测内置子代理 prompt；若非空 systemPrompt 候选则优先用候选
        systemPrompt: input.systemPrompt ?? readBuiltinPrompt(input.agentName),
        historyMessages: [],
        permissionMode: 'bypassPermissions',
        maxTurns: input.maxTurns ?? 12,
        abortSignal: input.abortSignal,
      })) {
        messages.push(msg)
      }
      // 回收集合 assistant 文本
      const texts: string[] = []
      for (const msg of messages) {
        if (msg.type === 'assistant') {
          const content = (msg as { message?: { content?: unknown } }).message?.content
          if (Array.isArray(content)) {
            for (const block of content as Array<{ type?: string; text?: string }>) {
              if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
            }
          }
        }
      }
      return { text: texts.join('\n\n') || '（评测：子代理未返回文本）' }
    } finally {
      if (running) {
        running = false
        adapter.dispose()
      }
    }
  }
}
