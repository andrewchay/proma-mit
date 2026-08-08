/**
 * Todo 解压缩工具 — Todo Context Tool（PH2-A）
 *
 * 给 Agent 一个「解压缩队友 Todo」的能力：
 * - Agent 调用 InspectTodo(todoId/关键字)，获取该 Todo 的完整上下文
 *   （标题、描述、状态、负责人、截止、所属项目），以及同项目的相关进行中 Todo。
 * - Agent 基于此 + 项目上下文，把压缩的 Todo 解释成普通人能懂的话，
 *   并发现关联、给出预警/建议——即官方思考里的「解压缩别人的 Todo」。
 */

import type { ToolResult } from '@gravitas/core'
import type { RuntimeToolDefinition, ToolContext } from '../types.ts'
import { getTask, listTasks } from '../../project-service'

export const TODO_CONTEXT_TOOL_NAME = 'InspectTodo'

export interface InspectTodoInput {
  /** Todo/任务 ID；为空则按关键字在项目内查找 */
  todoId?: string
  /** 配合 todoId 使用的项目 ID；空则用 todoId 查 */
  projectId?: string
}

export function createTodoContextToolDefinition(): Omit<RuntimeToolDefinition, 'execute'> {
  return {
    name: TODO_CONTEXT_TOOL_NAME,
    description:
      '解压缩一个待办(Todo/任务)：返回它的标题、描述、状态、负责人、截止时间、所属项目，以及同项目的相关进行中待办。' +
      '当被问及或需要理解队友/他人的某个待办在做什么、存在什么关联或风险时，**务必优先调用本工具查真实任务数据**（而不是靠猜测或泛泛解释机制）；' +
      '如果不知道确切的 todoId，先用 listTasks 或询问用户该任务标题所属的项目，再定位 todoId 查询。' +
      '拿到上下文后请用通俗语言向用户解释清楚（做了什么、为什么、卡在哪、是否延期、谁负责、与其他待办的关联）。',
    parameters: {
      type: 'object',
      properties: {
        todoId: { type: 'string', description: 'Todo/任务 ID' },
        projectId: { type: 'string', description: '项目 ID（可选，配合查找）' },
      },
    },
  }
}

function renderTodo(task: { id: string; title: string; description?: string; status: string; assignee?: { displayName?: string; userId?: string }; dueDate?: number; projectId: string; createdAt: number; updatedAt: number }): string {
  const lines = [
    `[${task.id}] ${task.title}`,
    `状态: ${task.status}`,
    `负责人: ${task.assignee?.displayName ?? task.assignee?.userId ?? '未指派'}`,
  ]
  if (task.dueDate) lines.push(`截止: ${new Date(task.dueDate).toLocaleDateString('zh-CN')}`)
  if (task.description) lines.push(`描述: ${task.description}`)
  return lines.join('\n')
}

export async function executeTodoContextTool(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const params = input as InspectTodoInput
  const todoId = params.todoId?.trim()
  if (!todoId) {
    return { toolCallId: '', content: '参数错误：需要 todoId（或 projectId + todoId）', isError: true }
  }

  try {
    // 1) 取目标 Todo
    const task = await getTask(todoId)
    if (!task) {
      return { toolCallId: '', content: `未找到待办: ${todoId}`, isError: true }
    }

    // 2) 取同项目进行中的相关 Todo（供发现关联/预警）
    let related: string[] = []
    try {
      const all = await listTasks(task.projectId, { includeSubTasks: true, includeDrafts: false })
      related = all
        .filter((t) => t.id !== task.id && !['completed', 'cancelled'].includes(t.status))
        .slice(0, 8)
        .map((t) => renderTodo(t))
    } catch {
      related = []
    }

    const head = `【目标待办】\n${renderTodo(task)}`
    const body = related.length > 0 ? `\n\n【同项目相关进行中待办】\n${related.join('\n---\n')}` : '\n\n（同项目暂无其他进行中待办）'
    const tip = '\n\n请用通俗语言向用户解释这个待办：在做什么、为什么、卡在哪/风险、是否临近截止、与其他待办的关联、可协作点。'
    return { toolCallId: '', content: `${head}${body}${tip}` }
  } catch (error) {
    return { toolCallId: '', content: `读取待办失败: ${error instanceof Error ? error.message : String(error)}`, isError: true }
  }
}
