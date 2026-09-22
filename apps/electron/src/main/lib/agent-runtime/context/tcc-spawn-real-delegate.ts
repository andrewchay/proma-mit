import type { PromaPermissionMode, ProviderType } from '@gravitas/shared'
import { ProviderAgnosticAgentAdapter } from '../../adapters/provider-agnostic-agent-adapter'
import type { ContextCacheStatus } from './context-metrics'
import type { TccExperimentDelegate, TccExperimentModelResult } from './tcc-experiment-runner'

/** 评测渠道依赖；凭据只在主进程内解密，绝不写入 trace 或日志。 */
export interface TccEvalChannel {
  channelId: string
  provider: ProviderType
  apiKey: string
  baseUrl: string
  modelId: string
}

export interface TccEvalIsolation {
  /** 隔离的只读 cwd；评测绝不触碰用户真实项目目录。 */
  workspaceDir: string
  /** 固定为 safe：禁止 Bash / Write / Edit 等有副作用工具。 */
  permissionMode?: PromaPermissionMode
}

/**
 * 真实评测 delegate。相对既有 eval 路径的差异：
 * - `runtimeTools: []`：评测只允许“读上下文并产出 typed-v1 结论”，不产生任何文件或网络副作用；
 * - `permissionMode: 'safe'`：即使误注册工具也会被拒绝执行；
 * - `maxTurns: 1`：一次请求一次回答，避免工具循环污染 token 统计。
 */
export function buildTccExperimentDelegate(channel: TccEvalChannel, isolation: TccEvalIsolation): TccExperimentDelegate {
  return async (input): Promise<TccExperimentModelResult> => {
    const adapter = new ProviderAgnosticAgentAdapter()
    try {
      const texts: string[] = []
      let inputTokens = 0
      let outputTokens = 0
      let cacheReadTokens = 0
      let sawUsage = false
      for await (const message of adapter.query({
        sessionId: `tcc-eval-${input.caseId}-${input.variant}`,
        prompt: input.task,
        model: channel.modelId,
        provider: channel.provider,
        apiKey: channel.apiKey,
        baseUrl: channel.baseUrl,
        cwd: isolation.workspaceDir,
        systemPrompt: input.systemPrompt,
        historyMessages: [],
        runtimeTools: [],
        permissionMode: isolation.permissionMode ?? 'safe',
        maxTurns: 1,
      })) {
        const record = message as unknown as { type?: string; message?: { content?: unknown }; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }
        if (record.type === 'assistant') {
          const content = record.message?.content
          if (Array.isArray(content)) {
            for (const block of content as Array<{ type?: string; text?: string }>) {
              if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
            }
          }
        }
        if (record.type === 'result' && record.usage) {
          sawUsage = true
          inputTokens += record.usage.input_tokens ?? 0
          outputTokens += record.usage.output_tokens ?? 0
          cacheReadTokens += record.usage.cache_read_input_tokens ?? 0
        }
      }
      // provider 未返回 usage 时保持 unknown，交由门禁按全量 input token 计费，绝不假装命中缓存。
      return {
        text: texts.join('\n\n'),
        inputTokens,
        outputTokens,
        cacheStatus: sawUsage ? (cacheReadTokens > 0 ? 'hit' : 'miss') : 'unknown',
        retryCount: 0,
      }
    } finally {
      adapter.dispose()
    }
  }
}

export type { ContextCacheStatus }
