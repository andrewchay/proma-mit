/**
 * 评测目标能力解析。
 *
 * 目录是能力的唯一事实来源；本模块将目录解析为评测与运行时共用的只读对象，
 * 显式保留目录/代码 fallback 来源、版本和内容 hash。
 */

import { createHash } from 'node:crypto'
import { buildBuiltinAgents } from '../../agent-prompt-builder'
import { readAgentDirState } from '../../agent-definition-store'
import { collectDirectoryToolsForPlugin, readPluginToolsDirState } from '../../tool-definition-store'
import type { RuntimeToolDefinition } from '../../agent-runtime/types'
import type { EvalTarget } from './types'

export interface ResolvedEvalTargetCapability {
  target: EvalTarget
  source: 'directory' | 'code-fallback'
  version: number
  contentHash: string
  systemPrompt: string
  runtimeTools: RuntimeToolDefinition[]
}

/** 解析评测目标；Toolset 只注册自身目录内声明的工具。 */
export function resolveEvalTargetCapability(target: EvalTarget): ResolvedEvalTargetCapability {
  if (target.type === 'agent') return resolveAgentCapability(target)
  if (target.type === 'toolset') return resolveToolsetCapability(target)
  throw new Error(`未知评测目标类型: ${(target as { type: string }).type}`)
}

function resolveAgentCapability(target: EvalTarget): ResolvedEvalTargetCapability {
  const definition = buildBuiltinAgents(false)[target.id]
  if (!definition?.prompt) throw new Error(`未知内置 sub-agent: ${target.id}`)
  const directory = readAgentDirState(target.id)
  const source = directory?.agentsMd ? 'directory' : 'code-fallback'
  const version = directory?.version ?? 0
  const systemPrompt = definition.prompt

  return {
    target,
    source,
    version,
    contentHash: hashCapability({ target, source, version, systemPrompt, tools: directory?.tools ?? definition.tools ?? [] }),
    systemPrompt,
    runtimeTools: [],
  }
}

function resolveToolsetCapability(target: EvalTarget): ResolvedEvalTargetCapability {
  const directory = readPluginToolsDirState(target.id)
  if (!directory) throw new Error(`未找到目录化工具集: ${target.id}`)
  const runtimeTools = collectDirectoryToolsForPlugin(target.id)
  if (directory.tools.length > 0 && runtimeTools.length === 0) {
    throw new Error(`工具集 ${target.id} 没有可执行工具：请提供 execute.ts 或代码 fallback`)
  }
  const systemPrompt = [
    `你正在评测工具集 “${target.id}”。`,
    '只能调用已注册工具；需要工具结果时必须真实调用，不能臆造返回值。',
    directory.toolsMd ?? '此工具集未提供 TOOLS.md，请依据工具 schema 完成任务。',
  ].join('\n\n')

  return {
    target,
    source: 'directory',
    version: directory.version,
    contentHash: hashCapability({
      target,
      version: directory.version,
      toolsMd: directory.toolsMd ?? '',
      tools: directory.tools.map((tool) => ({ id: tool.id, name: tool.name, description: tool.description, parameters: tool.parameters, executePath: tool.executePath ?? null })),
    }),
    systemPrompt,
    runtimeTools,
  }
}

function hashCapability(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
