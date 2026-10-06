import type { ContextProjection, PromaPermissionMode } from '@gravitas/shared'
import type { SubAgentInput } from '../types'
import { applyBuiltinSubAgentContextPolicy } from './builtin-subagent-context-policy'
import { resolveSubAgentContextOptions } from './subagent-context-options'
import { prepareSubAgentProjection } from './subagent-projection-adapter'
import { resolveSubAgentWorkspace } from './subagent-readonly-workspace'
import { TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT } from './subtask-result-parser'

export interface SubAgentSpawnPlanInput {
  parentSessionId: string
  /** 父会话 cwd；未启用只读边界时子任务继续使用它。 */
  parentCwd: string
  /** 父会话权限模式；只读子任务会被收紧为 safe，且不可被父会话的 bypassPermissions 覆盖。 */
  parentPermissionMode: PromaPermissionMode
  /** 已由调用方开启 TCC 开关（session 覆盖 workspace）。 */
  typedContextEnabled: boolean
  /** 工作区私有目录；缺失时无法读取投影账本。 */
  workspaceDirectory?: string
  /** 子会话私有目录；只读边界使用它。 */
  childWorkspaceDirectory: string
  subAgent: SubAgentInput
}

export interface SubAgentSpawnPlan {
  /** 应用内置 TCC policy 之后的子任务输入。 */
  subAgent: SubAgentInput
  projection?: ContextProjection
  projectionFallbackReason?: string
  /** 子代理实际使用的 cwd。 */
  childCwd: string
  /** 子代理实际使用的权限模式。 */
  permissionMode: PromaPermissionMode
  /** 已组装的子任务 prompt。 */
  prompt: string
  /** 是否以 typed-v1 解析子任务结果并生成结构化交接。 */
  typedResultEnabled: boolean
}

/**
 * spawn 边界的完整决策链：内置 policy → projection → 只读隔离 → prompt 组装。
 *
 * 抽成纯函数是为了让 M2 集成验收能在不启动 Electron 编排器的前提下覆盖真实决策；
 * 行为与原先内联在 agent-orchestrator 中的实现保持一致：
 * 只有投影成功才切入只读边界，投影故障完整回退 baseline（cwd 与权限都不变）。
 */
export function buildSubAgentSpawnPlan(input: SubAgentSpawnPlanInput): SubAgentSpawnPlan {
  const subAgent = applyBuiltinSubAgentContextPolicy({ subAgent: input.subAgent, enabled: input.typedContextEnabled })
  const preparedProjection = prepareSubAgentProjection({
    parentSessionId: input.parentSessionId,
    workspaceDirectory: input.workspaceDirectory,
    enabled: input.typedContextEnabled,
    subAgent,
  })
  const contextOptions = resolveSubAgentContextOptions(subAgent.context)
  const readOnly = preparedProjection.projection !== undefined && contextOptions.readOnly
  const childCwd = resolveSubAgentWorkspace({
    readOnly,
    parentWorkspaceDir: input.parentCwd,
    explicitWorkspaceDir: subAgent.workspaceDir,
    childWorkspaceDir: input.childWorkspaceDirectory,
  })
  const filesHint = subAgent.files?.length
    ? `\n\n重点关注以下文件：\n${subAgent.files.map((file) => `- ${file}`).join('\n')}`
    : ''
  const typedResultEnabled = preparedProjection.projection !== undefined && contextOptions.resultProtocol === 'typed-v1'
  const resultProtocolSuffix = typedResultEnabled ? `\n\n${TYPED_SUBTASK_RESULT_PROTOCOL_PROMPT}` : ''
  const prompt = `${subAgent.task}${filesHint}${preparedProjection.promptSuffix ? `\n\n${preparedProjection.promptSuffix}` : ''}${resultProtocolSuffix}`

  return {
    subAgent,
    ...(preparedProjection.projection ? { projection: preparedProjection.projection } : {}),
    ...(preparedProjection.fallbackReason ? { projectionFallbackReason: preparedProjection.fallbackReason } : {}),
    childCwd,
    permissionMode: readOnly ? 'safe' : input.parentPermissionMode,
    prompt,
    typedResultEnabled,
  }
}
