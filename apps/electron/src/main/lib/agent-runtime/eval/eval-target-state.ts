/**
 * 统一评测目标状态守卫工厂。
 *
 * 根据 EvalTarget 类型（agent / toolset）自动选择对应的 StateGuard 实现。
 */

import type { EvalTarget, EvalTargetType } from './types'
import type { StateGuard } from './self-evolver'
import { buildBuiltinStateGuard } from './builtin-agent-state'
import { buildToolsetStateGuard } from './toolset-state'

/** 统一 StateGuard + 内容读取接口 */
export interface UnifiedStateGuard extends StateGuard {
  /** 读取当前生效的内容（prompt 或 toolsMd） */
  currentContent: () => string | undefined
}

/**
 * 构建统一评测目标状态守卫。
 *
 * @param target 评测目标（agent: code-reviewer / toolset: marketing）
 * @returns UnifiedStateGuard（支持 snapshot/apply/restore/version + currentContent）
 */
export function buildEvalTargetStateGuard(target: EvalTarget): UnifiedStateGuard {
  if (target.type === 'agent') {
    const guard = buildBuiltinStateGuard(target.id)
    return {
      ...guard,
      currentContent: guard.currentPrompt,
    }
  }

  if (target.type === 'toolset') {
    const guard = buildToolsetStateGuard(target.id)
    return {
      ...guard,
      currentContent: guard.currentContent,
    }
  }

  throw new Error(`未知评测目标类型: ${(target as { type: string }).type}`)
}

/**
 * 判断是否为有效的评测目标 ID。
 * 支持内置 agent 和已目录化的 toolset。
 */
export function isEvalTargetId(type: EvalTargetType, id: string): boolean {
  if (type === 'agent') {
    // 复用现有内置 agent 校验
    const { isBuiltinAgentId } = require('./builtin-agent-overrides')
    return isBuiltinAgentId(id)
  }
  if (type === 'toolset') {
    // 检查是否存在对应的工具集目录
    const { readPluginToolsDirState } = require('../../tool-definition-store')
    return readPluginToolsDirState(id) !== null
  }
  return false
}
