/**
 * 项目看板 MCP 工具注入（Agent 交付闭环第一批）
 *
 * 让 AI 员工在执行中能直接操作所属项目的看板（Linear Agents / GitHub Agent HQ 模式）：
 * - project_list_tasks：看板列视图（只读）
 * - project_move_task：移动任务到指定状态列（受 draft 进出规则/DoD 校验约束）
 * - project_complete_task：带证据交付——落 draft 等人确认（不能直接 completed）
 *
 * 授权范围：当前会话绑定的任务所属项目（单写者模型下与人工写入同一条 updateTask 路径，
 * draft 规则/DoD/活动流自动生效）。复用 SDK createSdkMcpServer 注入模式（同 goal-mcp）。
 */

import { listTasks, getTask, updateTask, reorderTask } from '../project-service'
import { listTaskStatuses } from '../task-status-store-bridge'
import { getAgentExecutionBySessionId } from '../project-sqlite-store'

/**
 * 会话授权项目解析：AI 员工 headless 执行时 sessionId 即 agent_execution.sessionId，
 * 经 execution.entityId（任务）反查所属项目。非执行会话（人开的会话）无 execution → null（工具不可用）。
 */
async function resolveBoundProjectId(sessionId?: string): Promise<string | null> {
  if (!sessionId) return null
  const execution = getAgentExecutionBySessionId(sessionId)
  if (!execution || execution.entityType !== 'task') return null
  return (await getTask(execution.entityId))?.projectId ?? null
}

/** 项目拒绝文案 */
function projectDenied(boundProjectId: string | null, projectId: string): string {
  if (!boundProjectId) {
    return '当前会话未绑定任何项目任务，无法操作项目看板。请先在项目任务中指派 AI 员工。'
  }
  if (boundProjectId !== projectId) {
    return `会话仅授权项目 ${boundProjectId}，无权操作项目 ${projectId}。`
  }
  return ''
}

/** 任务列表 → 看板文本（按状态列分组） */
async function boardToText(projectId: string): Promise<string> {
  const statuses = listTaskStatuses(projectId)
  const tasks = await listTasks(projectId, { includeDrafts: true })
  const lines: string[] = ['看板列（按 position 排序）:']
  for (const status of statuses) {
    const inColumn = tasks.filter((t) => t.status === status.id)
    const wip = status.wipLimit !== undefined ? ` (WIP ${inColumn.length}/${status.wipLimit})` : ` (${inColumn.length})`
    lines.push(`- [${status.id}] ${status.name} [组:${status.stateGroup}]${wip}`)
    for (const task of inColumn) {
      const assignee = task.assignee?.displayName ?? '未指派'
      lines.push(`    · ${task.id} ${task.title}（负责: ${assignee}${task.dueDate ? `，截止 ${new Date(task.dueDate).toLocaleDateString('zh-CN')}` : ''}，版本:${task.updatedAt}）`)
    }
  }
  return lines.join('\n')
}

export async function injectProjectBoardMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  sessionId?: string,
): Promise<void> {
  try {
    const { z } = await import('zod')
    const boundProjectId = await resolveBoundProjectId(sessionId)
    const server = sdk.createSdkMcpServer({
      name: 'proma_project_board',
      version: '1.0.0',
      tools: [
        // 只读：看板全貌
        sdk.tool(
          'project_board_view',
          '查看当前项目看板的全部分列与任务（含状态组、WIP 计数、负责人、截止日期）。执行任务前后各看一次，了解上下文与下游依赖。',
          { projectId: z.string().describe('项目 ID') },
          async (args) => {
            const denied = projectDenied(boundProjectId, args.projectId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            return { content: [{ type: 'text' as const, text: await boardToText(args.projectId) }] }
          },
          { annotations: { readOnlyHint: true } },
        ),
        // 写：移动任务（走 reorderTask，draft 规则/DoD 自动生效）
        sdk.tool(
          'project_move_task',
          '移动看板上的任务到指定状态列（如 pending → in_progress 开始工作）。受项目状态流转规则约束：草稿任务不能直接改状态（需人工确认）、完成校验不通过会被拒绝——被拒绝时请阅读错误原因，不要重试同一操作。',
          {
            taskId: z.string().describe('任务 ID'),
            newStatusId: z.string().describe('目标状态 ID（见 project_board_view 输出的列 id）'),
            afterTaskId: z.string().optional().describe('放置到该任务之后（可选，用于列内排序）'),
            expectedUpdatedAt: z.number().optional().describe('任务版本号（project_board_view 输出的"版本:"值）。传入后若任务已被他人更新将拒绝，请重新查看看板再试'),
          },
          async (args) => {
            const task = await getTask(args.taskId)
            if (!task) return { content: [{ type: 'text' as const, text: `任务不存在: ${args.taskId}` }] }
            const denied = projectDenied(boundProjectId, task.projectId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            try {
              // 乐观锁：agent 传入版本号时先校验（人拖卡片与 agent 并发写的收敛点）
              if (args.expectedUpdatedAt !== undefined) {
                const current = await getTask(args.taskId)
                if (current && current.updatedAt !== args.expectedUpdatedAt) {
                  return {
                    content: [{ type: 'text' as const, text: `任务已被其他操作更新（当前版本 ${current.updatedAt}，你基于版本 ${args.expectedUpdatedAt} 操作）。请重新调用 project_board_view 查看最新看板后再操作。` }],
                  }
                }
              }
              const result = await reorderTask(args.taskId, {
                newStatusId: args.newStatusId,
                ...(args.afterTaskId ? { afterTaskId: args.afterTaskId } : {}),
              })
              return { content: [{ type: 'text' as const, text: `已移动「${result.task.title}」到 [${result.task.status}]` }] }
            } catch (error) {
              return { content: [{ type: 'text' as const, text: `移动被拒绝: ${error instanceof Error ? error.message : String(error)}` }] }
            }
          },
        ),
        // 写：带证据交付（落 draft 等人确认）
        sdk.tool(
          'project_deliver_task',
          '交付当前任务：写入完成说明（做了什么/交付物清单/遗留风险）并把任务转入草稿态等待人工确认。注意：AI 交付不会直接标记完成——人工确认后才进入工作流，这是项目的验收闸门。交付前请确保完成说明完整。',
          {
            taskId: z.string().describe('任务 ID'),
            summary: z.string().min(10).describe('完成说明：做了什么（关键步骤与结论）、交付物/产出文件清单、遗留风险或未完成事项'),
          },
          async (args) => {
            const task = await getTask(args.taskId)
            if (!task) return { content: [{ type: 'text' as const, text: `任务不存在: ${args.taskId}` }] }
            const denied = projectDenied(boundProjectId, task.projectId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            try {
              // draft 进出规则：非 draft 任务禁止普通路径改入 draft——deliver 走同一约束之外的
              // 专用语义：这里直接用 updateTask 的 completionNotes + 显式 draft 转换会被规则拦截，
              // 因此交付 = 完成（writeback 闸门路径）：置 in_progress 语义的完成说明由外部编排层落 draft。
              // 面板语义：把完成说明写入 notes，状态保持由派发编排（handleExecutionComplete）落 draft。
              await updateTask(args.taskId, { completionNotes: `【AI 交付待确认】${args.summary}` })
              return {
                content: [{
                  type: 'text' as const,
                  text: '交付说明已记录。任务状态由执行编排统一切换到草稿态等待人工确认；你无需（也不能）自行把任务置为 completed。',
                }],
              }
            } catch (error) {
              return { content: [{ type: 'text' as const, text: `交付失败: ${error instanceof Error ? error.message : String(error)}` }] }
            }
          },
        ),
      ],
    })
    mcpServers.proma_project_board = server
    console.log('[Agent 编排] 已注入项目看板 MCP 工具（proma_project_board）')
  } catch (err) {
    console.error('[Agent 编排] 注入项目看板 MCP 失败:', err)
  }
}
