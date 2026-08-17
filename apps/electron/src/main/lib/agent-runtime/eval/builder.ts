/**
 * Builder 候选生成器：用评测渠道的 LLM 生成改进后的被测 sub-agent 系统 prompt。
 *
 * 借鉴 penguin `agent-optimization` 的 evidence→hypothesis：把 baseline 各 Case 的失分情况
 * 作为证据，让一个「Builder」LLM 审视当前 sub-agent prompt，产出修订版 prompt 作为候选。
 *
 * 纯模板在 `builder-prompts.ts`（可单测）；本模块只负责真实 LLM 调用（依赖渠道）。
 *
 * 安全边界：生成出的候选只进入评测循环（evaluate→accept/rollback），绝不自动写回内置
 * `buildBuiltinAgents()` 代码常量；只有评测分数严格高于 Reference 才会被记为 accepted，
 * 供外部决定是否采纳。
 */

import { ProviderAgnosticAgentAdapter } from '../../adapters/provider-agnostic-agent-adapter'
import type { EvalChannelInfo } from './eval-runner'
import { buildBuilderUserPrompt, builderSystemPrompt, type CandidateBuilderContext } from './builder-prompts'

/** 一次纯文本模型调用（Builder 用，非评测沙箱）。返回 assistant 文本。 */
export async function runPlainPrompt(
  channel: EvalChannelInfo,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const adapter = new ProviderAgnosticAgentAdapter()
  const messages: import('@gravitas/shared').SDKMessage[] = []
  try {
    for await (const msg of adapter.query({
      sessionId: `builder-${Date.now()}`,
      prompt: userPrompt,
      model: channel.modelId,
      provider: channel.provider,
      apiKey: channel.apiKey,
      baseUrl: channel.baseUrl,
      cwd: '/tmp',
      systemPrompt,
      historyMessages: [],
      permissionMode: 'bypassPermissions',
      maxTurns: 2,
      abortSignal: signal,
    })) {
      messages.push(msg)
    }
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
    return texts.join('\n\n').trim()
  } finally {
    adapter.dispose()
  }
}

/** 生成修订版 sub-agent 系统提示词（Builder 一次 LLM 调用）。 */
export async function generateCandidatePrompt(
  channel: EvalChannelInfo,
  ctx: CandidateBuilderContext,
  signal?: AbortSignal,
): Promise<string> {
  const user = buildBuilderUserPrompt(ctx)
  const out = await runPlainPrompt(channel, builderSystemPrompt(), user, signal)
  return out.length > 0 ? out : ctx.currentPrompt
}
