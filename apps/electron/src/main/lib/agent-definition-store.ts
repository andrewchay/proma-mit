/**
 * Agent 即目录 —— 内置 sub-agent 定义存储。
 *
 * 内置 sub-agent（code-reviewer / explorer / researcher）从代码常量外化为目录：
 *   ~/.gravitas/default-agents/<id>/
 *     ├── system_config.json   # 稳定层：name/description/version/tools
 *     └── AGENTS.md            # 需求层：系统提示正文（agent 行为来源）
 *
 * 本模块：读取目录 → 合并成 SDK 认识的 AgentDefinition；目录缺失/字段缺失时回退代码默认；
 * 并负责把旧版 `builtin-agent-overrides.json`（M5 的 prompt 覆盖）一次性折叠进目录。
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDefinition } from '@gravitas/shared'
import { getAgentDir, getDefaultAgentsUserDir, parseAgentDirVersion } from './config-paths'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'
import { builtinOverridesPath, readBuiltinOverrides, clearBuiltinOverride } from './agent-runtime/eval/builtin-agent-overrides'

/** 内置 agent 目录状态。 */
export interface AgentDirState {
  id: string
  name?: string
  description?: string
  version: number
  tools?: string[]
  model?: string
  /** AGENTS.md 正文（需求层提示） */
  agentsMd?: string
}

/** system_config.json 的目录布局（宽松解析）。 */
interface SystemConfigFile {
  id?: string
  name?: string
  description?: string
  version?: unknown
  tools?: unknown
  model?: string
}

/** 读取某个内置 agent 目录的状态；目录或关键文件缺失返回 null。
 *  注意：只读路径不创建目录，避免纯读取产生副作用。 */
export function readAgentDirState(agentId: string): AgentDirState | null {
  const dir = join(getDefaultAgentsUserDir(), agentId)
  const configPath = join(dir, 'system_config.json')
  const agentsMdPath = join(dir, 'AGENTS.md')
  if (!existsSync(configPath) && !existsSync(agentsMdPath)) return null

  const cfg = existsSync(configPath) ? readJsonFileSafe<SystemConfigFile>(configPath) : null
  const tools = Array.isArray(cfg?.tools)
    ? (cfg!.tools as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined
  const version = parseAgentDirVersion(dir)

  let agentsMd: string | undefined
  if (existsSync(agentsMdPath)) {
    try {
      agentsMd = readFileSync(agentsMdPath, 'utf-8').trim()
    } catch {
      agentsMd = undefined
    }
  }

  return {
    id: cfg?.id || agentId,
    name: typeof cfg?.name === 'string' ? cfg.name : undefined,
    description: typeof cfg?.description === 'string' ? cfg.description : undefined,
    version,
    tools,
    model: typeof cfg?.model === 'string' ? cfg.model : undefined,
    agentsMd,
  }
}

/** 把目录状态合并成 AgentDefinition（代码默认兜底；目录字段优先）。 */
export function agentStateToDefinition(
  state: AgentDirState | null,
  codeDefault: AgentDefinition,
): AgentDefinition {
  if (!state) return codeDefault
  return {
    description: state.description ?? codeDefault.description,
    ...(state.tools && state.tools.length > 0 ? { tools: state.tools } : codeDefault.tools ? { tools: codeDefault.tools } : {}),
    ...(codeDefault.model ? { model: codeDefault.model } : {}),
    ...(state.agentsMd && state.agentsMd.length > 0 ? { prompt: state.agentsMd } : codeDefault.prompt ? { prompt: codeDefault.prompt } : {}),
  }
}

/**
 * 读取某个内置 agent 的最终 AgentDefinition：目录优先，代码默认兜底。
 * `codeDefault` 必须是 `buildBuiltinAgents` 里对应 id 的定义。
 */
export function getBuiltinAgentDefinition(agentId: string, codeDefault: AgentDefinition): AgentDefinition {
  return agentStateToDefinition(readAgentDirState(agentId), codeDefault)
}

/** bundled AGENTS.md 正文（开发/打包路径同一套逻辑，缺失返回空；任何失败返回空）。 */
function bundledAgentAgentsMd(agentId: string): string {
  try {
    const { app } = require('electron') as { app: { isPackaged: boolean } }
    const bundledDir = app && app.isPackaged
      ? join(process.resourcesPath as string, 'default-agents')
      : join(__dirname, '../default-agents') /* esbuild 打包后 __dirname=dist，../default-agents=apps/electron/default-agents */
    const p = join(bundledDir, agentId, 'AGENTS.md')
    if (!existsSync(p)) return ''
    return readFileSync(p, 'utf-8').trim()
  } catch {
    return ''
  }
}

/**
 * 一次性迁移：把旧版 `builtin-agent-overrides.json` 的 prompt 覆盖折叠进 agent 目录。
 * 仅当目录仍为捆绑 seed（AGENTS.md 与 bundled 一致）时折叠，避免覆盖用户手改。
 * 折叠后清除该覆盖条目。幂等。
 */
export function foldLegacyAgentOverridesIntoDirs(): void {
  const overrides = readBuiltinOverrides()
  const ids = Object.keys(overrides)
  if (ids.length === 0) return
  for (const agentId of ids) {
    const prompt = overrides[agentId]?.prompt
    if (!prompt) continue
    const dir = getAgentDir(agentId)
    const agentsMdPath = join(dir, 'AGENTS.md')
    const current = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf-8').trim() : ''
    if (current !== bundledAgentAgentsMd(agentId)) continue // 用户已改过 → 不覆盖
    // 用明文写 AGENTS.md（不是 JSON）
    const fs = require('node:fs') as typeof import('node:fs')
    try { fs.writeFileSync(agentsMdPath, prompt, 'utf-8') } catch { /* 忽略 */ }
    // bump system_config.version（若存在）
    bumpAgentDirVersion(agentId)
    clearBuiltinOverride(agentId)
  }
  // 若 override 文件已空则清理
  const remaining = readBuiltinOverrides()
  if (Object.keys(remaining).length === 0) {
    const p = builtinOverridesPath()
    if (existsSync(p)) { try { rmSync(p, { force: true }) } catch { /* 忽略 */ } }
  }
}

/** 增加某内置 agent 目录的 system_config.version（保持「采纳写回」版本递增契约）。 */
export function bumpAgentDirVersion(agentId: string): number {
  const dir = getAgentDir(agentId)
  const configPath = join(dir, 'system_config.json')
  const cfg = existsSync(configPath) ? readJsonFileSafe<SystemConfigFile>(configPath) : null
  const version = (cfg && typeof cfg.version === 'number' ? cfg.version : parseAgentDirVersion(dir)) + 1
  writeJsonFileAtomic(configPath, {
    ...(cfg ?? {}),
    id: cfg?.id ?? agentId,
    version,
    updatedAt: new Date().toISOString(),
  })
  return version
}

/**
 * 采纳写回：把改进后的 prompt 写入 agent 目录的 AGENTS.md 并 bump version。
 * 这是「agent 即目录」下 trust 采纳的落地——目录即源，buildBuiltinAgents 读取即生效。
 */
export function writeAgentAgentsMd(agentId: string, prompt: string): number {
  const fs = require('node:fs') as typeof import('node:fs')
  const dir = getAgentDir(agentId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, 'AGENTS.md'), prompt.trim(), 'utf-8')
  return bumpAgentDirVersion(agentId)
}
