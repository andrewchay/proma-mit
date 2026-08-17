/**
 * 内置 sub-agent 的持久化 prompt 覆盖（「采纳写回」的存储层）。
 *
 * 被「采纳」的改进（benchmark 评测 accepted 且用户确认）会持久化到这里：
 *   <config>/eval/builtin-overrides.json
 *   { "code-reviewer": { "prompt": "…" } }
 *
 * 读取时机：`buildBuiltinAgents()` 返回前合并，使**所有**内置 sub-agent 调用点（runSubAgent、
 * SDK agents 注册）自动拿到覆盖后的 prompt，而非代码里的默认值。优先本地文件、无数据库。
 */

import { existsSync } from 'node:fs'
import { getEvalDir } from '../../config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from '../../safe-file'
import { join } from 'node:path'

interface BuiltinOverride {
  prompt?: string
}
export type BuiltinOverridesMap = Record<string, BuiltinOverride>

/** 覆盖文件路径。 */
export function builtinOverridesPath(): string {
  return join(getEvalDir(), 'builtin-overrides.json')
}

/** 读取全部内置 sub-agent 覆盖；无文件返回空表。 */
export function readBuiltinOverrides(): BuiltinOverridesMap {
  const data = readJsonFileSafe<Partial<BuiltinOverridesMap>>(builtinOverridesPath())
  if (!data || typeof data !== 'object') return {}
  const out: BuiltinOverridesMap = {}
  for (const [id, value] of Object.entries(data)) {
    const override = value as BuiltinOverride | undefined
    if (override && typeof override.prompt === 'string' && override.prompt.trim()) {
      out[id] = { prompt: override.prompt }
    }
  }
  return out
}

/** 保存/更新某个内置 sub-agent 的 prompt 覆盖（采纳写回）。 */
export function saveBuiltinOverride(agentId: string, prompt: string): BuiltinOverridesMap {
  const current = readBuiltinOverrides()
  current[agentId] = { prompt }
  writeJsonFileAtomic(builtinOverridesPath(), current)
  return current
}

/** 清除某个内置 sub-agent 的覆盖（恢复代码默认）。 */
export function clearBuiltinOverride(agentId: string): BuiltinOverridesMap {
  const current = readBuiltinOverrides()
  if (!(agentId in current)) return current
  delete current[agentId]
  writeJsonFileAtomic(builtinOverridesPath(), current)
  return current
}

/**
 * 是否为「内置子代理 id」。用于采纳前校验，避免误写非内置 id。
 */
export function isBuiltinAgentId(agentId: string): boolean {
  return agentId === 'code-reviewer' || agentId === 'explorer' || agentId === 'researcher'
}

/** 占位导出避免未使用 existsSync 警告（实际用于路径存在判断，保留供调用方）。 */
export function hasBuiltinOverrides(): boolean {
  return existsSync(builtinOverridesPath())
}
