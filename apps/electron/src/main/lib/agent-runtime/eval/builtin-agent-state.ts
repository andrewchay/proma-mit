/**
 * 内置 sub-agent 状态快照/回滚（纯逻辑，不依赖 Electron/渠道，便于单测）。
 *
 * 被测对象 = `buildBuiltinAgents()` 里的内置子代理定义（code-reviewer / explorer / researcher）。
 * 版本快照粒度 = AgentDefinition.prompt；候选 afterState 可以是字符串（新 prompt）或
 * `{ prompt }` 对象。
 */

import { buildBuiltinAgents } from '../../agent-prompt-builder'
import type { StateGuard } from './self-evolver'
import type { SelfEvolveChange } from './types'

/** 读取内置子代理的当前（原始）prompt；未定义返回兜底描述。 */
export function readBuiltinPrompt(targetAgentId: string): string {
  const builtin = buildBuiltinAgents(false)
  return builtin[targetAgentId]?.prompt ?? `（${targetAgentId} 未定义 prompt）`
}

/**
 * 内置 sub-agent 的 StateGuard：版本化快照其 prompt，支持候选应用与回滚。
 * 不改动 `buildBuiltinAgents()` 的代码常量，只在内存里维护当前生效的 prompt 版本，
 * 评测时通过 `currentPrompt` 取用。
 */
export function buildBuiltinStateGuard(targetAgentId: string): StateGuard & { currentPrompt: () => string | undefined } {
  const builtin = buildBuiltinAgents(false)
  const original = builtin[targetAgentId]
  if (!original) throw new Error(`内置子代理不存在: ${targetAgentId}`)
  let currentPrompt: string | undefined = original.prompt
  let version = 1
  const stack: Array<{ prompt: string | undefined; version: number }> = []

  return {
    currentPrompt: () => currentPrompt,
    async snapshot() {
      stack.push({ prompt: currentPrompt, version })
    },
    async apply(change: SelfEvolveChange) {
      const after = change.afterState as unknown
      if (typeof after === 'string') {
        currentPrompt = after
      } else if (after && typeof after === 'object' && 'prompt' in (after as Record<string, unknown>)) {
        currentPrompt = (after as Record<string, unknown>).prompt as string | undefined
      }
      version++
    },
    async restore() {
      const top = stack.pop()
      if (top) {
        currentPrompt = top.prompt
        version = top.version
      }
    },
    version: () => version,
  }
}
