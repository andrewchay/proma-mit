/**
 * ExploreContext 工具 — Context Hub / Work Graph（PH2-D）
 *
 * 让 Agent 从任意上下文起点（运行/会话/任务/文件事件/Todo/日程/成员）沿 Work Graph
 * 发现关联上下文（谁执行的、改了什么文件、哪个成员、相关运行/待办），
 * 在对话中给用户跨上下文的理解与协作建议。
 */

import type { ToolResult } from '@gravitas/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'

export const EXPLORE_CONTEXT_TOOL_NAME = 'ExploreContext'

const TYPE_LABEL: Record<string, string> = {
  run: '运行', session: '会话', task: '待办', file_event: '文件事件', todo_event: '待办事件', calendar: '日程', member: '成员',
}

export function createExploreContextToolDefinition(): Omit<RuntimeToolDefinition, 'execute'> {
  return {
    name: EXPLORE_CONTEXT_TOOL_NAME,
    description:
      '从某个上下文起点（run 运行/session 会话/task 待办/member 成员/file_event 文件事件/todo_event 待办事件/calendar 日程）' +
      '沿 Work Graph 查询关联上下文：谁执行了这一运行、改了什么文件、该成员还做过什么、相关运行/待办。' +
      '当用户问「这个会话/任务/成员还和什么相关」「谁改了这些文件」「这个待办背后是什么上下文」时使用。',
    parameters: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          enum: ['run', 'session', 'task', 'member', 'file_event', 'todo_event', 'calendar'],
          description: '起点实体类型',
        },
        entityId: { type: 'string', description: '起点实体 ID（如 sessionId / memberId=agent-<id>；member 类型可直接传成员展示名如 “Andrew”，会自动解析）' },
      },
      required: ['entityType', 'entityId'],
    },
  }
}

export async function executeExploreContextTool(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
  const params = input as { entityType: string; entityId: string }
  if (!params.entityId || !params.entityType) {
    return { toolCallId: '', content: '参数错误：需要 entityType + entityId', isError: true }
  }
  try {
    const { getEntityGraph, graphToText } = await import('../../context-hub-service')
    const graph = getEntityGraph(params.entityType as never, params.entityId)
    if (!graph) {
      return { toolCallId: '', content: '未找到该上下文或其关联（可能项目库未初始化）', isError: true }
    }
    return { toolCallId: '', content: graphToText(graph) }
  } catch (error) {
    return { toolCallId: '', content: `查询上下文失败: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}
