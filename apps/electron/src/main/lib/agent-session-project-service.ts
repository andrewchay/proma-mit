/**
 * Agent 会话当前 Project 上下文服务
 *
 * 会话的 projectId 决定项目记忆与项目知识库的读取范围；写入前必须验证：
 * - Project 真实存在；
 * - 会话有 workspaceId；
 * - 当前 workspace ↔ project 存在正式绑定。
 *
 * 绑定只是授权，不自动共享资料；解绑后新工具调用会按空范围处理。
 */

import type { AgentSessionMeta } from '@gravitas/shared'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { getProject } from './project-sqlite-store'
import { hasProjectWorkspaceBinding } from './project-workspace-bindings'

export interface UpdateSessionProjectContextOptions {
  /** 由调用方注入活动会话判断，避免本服务反向依赖 agent-orchestrator */
  isSessionActive?: (sessionId: string) => boolean
}

export function updateAgentSessionProjectContext(
  sessionId: string,
  projectId: string | null | undefined,
  options: UpdateSessionProjectContextOptions = {},
): AgentSessionMeta {
  const current = getAgentSessionMeta(sessionId)
  if (!current) throw new Error(`Agent 会话不存在: ${sessionId}`)
  if (options.isSessionActive?.(sessionId)) throw new Error('会话正在运行中，请停止后再切换项目')

  const normalizedProjectId = projectId?.trim() || undefined
  if (normalizedProjectId) {
    if (!getProject(normalizedProjectId)) throw new Error(`Project 不存在: ${normalizedProjectId}`)
    if (!current.workspaceId) throw new Error('当前会话没有工作空间，不能绑定项目上下文')
    if (!hasProjectWorkspaceBinding(normalizedProjectId, current.workspaceId)) {
      throw new Error('当前工作空间未与该项目绑定，请先在项目「工作空间」页完成授权')
    }
  }

  return updateAgentSessionMeta(sessionId, {
    projectId: normalizedProjectId,
    knowledgeScopeMode: normalizedProjectId ? 'project' : 'none',
    explicitKnowledgeBaseIds: [],
  })
}
