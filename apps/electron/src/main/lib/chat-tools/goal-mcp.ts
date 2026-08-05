/**
 * Goal MCP 工具注入（A4）
 *
 * 让 Agent 在运行中能主动操作绑定的 Goal：
 * - 查看目标状态（只读）
 * - 列出可执行的 todo
 * - 领取（claim）某个 todo
 * - 追加 evidence（证据）
 *
 * 复用 SDK 的 createSdkMcpServer 注入模式（同 memory / nano-banana 工具）。
 */

import type { Goal } from '@gravitas/shared'
import { getGoal, updateGoalTodoStatus, appendGoalEvidence, shouldGoalRun } from '../goal-service'
import { getAgentSessionMeta } from '../agent-session-manager'

/** 生成发送给 Agent 的 Goal 状态文本 */
function goalToText(goal: Goal): string {
  const openTodos = goal.todos.filter((t) => ['open', 'claimed', 'in_progress'].includes(t.status))
  const gates = goal.gates.filter((g) => g.status === 'open')
  const lines = [
    `目标: ${goal.title}`,
    `阶段: ${goal.phase}`,
    `描述: ${goal.objective}`,
  ]
  if (openTodos.length > 0) {
    lines.push(`待办 todo: ${openTodos.map((t) => `[${t.id}] ${t.text}`).join('; ')}`)
  }
  if (gates.length > 0) {
    lines.push(`待处理用户门控: ${gates.map((g) => g.question).join('; ')}`)
  }
  return lines.join('\n')
}

/**
 * 授权校验：当前会话只能操作其绑定 Goal 的资源。
 * 返回错误文案（非空表示拒绝），无则允许。
 */
function authDenied(boundGoalId: string | undefined, goalId: string): string {
  if (!boundGoalId) {
    return '当前会话未绑定任何 Goal，无法操作 Goal 资源。请先在目标管理中绑定 Goal，或将任务明确指派到绑定了该 Goal 的会话。'
  }
  if (boundGoalId !== goalId) {
    return `会话仅绑定 Goal ${boundGoalId}，无权操作 Goal ${goalId}。`
  }
  return ''
}

export async function injectGoalMcpServer(
  sdk: typeof import('@anthropic-ai/claude-agent-sdk'),
  mcpServers: Record<string, Record<string, unknown>>,
  sessionId?: string,
): Promise<void> {
  try {
    const { z } = await import('zod')
    // 会话绑定的 Goal 是唯一授权范围；未传 sessionId 则视为未绑定（禁止写操作）
    const boundGoalId = sessionId ? getAgentSessionMeta(sessionId)?.goalId : undefined
    const server = sdk.createSdkMcpServer({
      name: 'proma_goal',
      version: '1.0.0',
      tools: [
        // 查看目标状态（只读）
        sdk.tool(
          'goal_status',
          '查看用户绑定的 Goal（长生命周期目标）的当前状态，包括阶段、待办 todo、待处理的用户门控。当收到与某个长期目标相关的任务时，先调用它了解当前上下文。',
          { goalId: z.string().describe('Goal ID') },
          async (args) => {
            const denied = authDenied(boundGoalId, args.goalId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            const goal = getGoal(args.goalId)
            if (!goal) return { content: [{ type: 'text' as const, text: `Goal 不存在: ${args.goalId}` }] }
            return { content: [{ type: 'text' as const, text: goalToText(goal) }] }
          },
          { annotations: { readOnlyHint: true } },
        ),
        // 领取 todo
        sdk.tool(
          'goal_claim_todo',
          '领取（声明）当前绑定 Goal 下的一个待办 todo。在开始执行某项目标工作前，先 claim 它，让所有权和进度对用户可见。',
          {
            goalId: z.string().describe('Goal ID'),
            todoId: z.string().describe('要领取的 todo ID'),
          },
          async (args) => {
            const denied = authDenied(boundGoalId, args.goalId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            const todo = getGoal(args.goalId)?.todos.find((t) => t.id === args.todoId)
            if (!todo) return { content: [{ type: 'text' as const, text: `未找到 todo: ${args.todoId}` }] }
            updateGoalTodoStatus(args.goalId, args.todoId, 'claimed')
            return { content: [{ type: 'text' as const, text: `已领取 todo [${args.todoId}]: ${todo.text}` }] }
          },
        ),
        // 完成 todo（E4）
        sdk.tool(
          'goal_complete_todo',
          '将当前绑定 Goal 下的一个 todo 标记为已完成。在确认某项目标工作确实交付完成、且通过验证后调用；谨慎使用，避免误标记。',
          {
            goalId: z.string().describe('Goal ID'),
            todoId: z.string().describe('要完成的 todo ID'),
            summary: z.string().optional().describe('完成摘要（可选，会被追加到 Goal 证据）'),
          },
          async (args) => {
            const denied = authDenied(boundGoalId, args.goalId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            const todo = getGoal(args.goalId)?.todos.find((t) => t.id === args.todoId)
            if (!todo) return { content: [{ type: 'text' as const, text: `未找到 todo: ${args.todoId}` }] }
            updateGoalTodoStatus(args.goalId, args.todoId, 'done')
            if (args.summary) {
              try {
                appendGoalEvidence(args.goalId, `完成 [${args.todoId}] ${todo.text}: ${args.summary}`)
              } catch (_err) { /* 证据失败不影响完成 */ }
            }
            return { content: [{ type: 'text' as const, text: `已完成 todo [${args.todoId}]: ${todo.text}` }] }
          },
        ),
        // 追加证据
        sdk.tool(
          'goal_append_evidence',
          '向当前绑定的 Goal 追加一条证据（本次工作做了什么、改了什么、结果如何）。在完成一段有意义的进展后调用，保持证据流可复盘。',
          {
            goalId: z.string().describe('Goal ID'),
            summary: z.string().describe('证据摘要（一句话）'),
          },
          async (args) => {
            const denied = authDenied(boundGoalId, args.goalId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            try {
              appendGoalEvidence(args.goalId, args.summary)
              return { content: [{ type: 'text' as const, text: '证据已记录' }] }
            } catch (err) {
              return { content: [{ type: 'text' as const, text: `记录证据失败: ${err instanceof Error ? err.message : String(err)}` }] }
            }
          },
        ),
        // 推进判断
        sdk.tool(
          'goal_should_run',
          '判断当前绑定 Goal 是否应推进（是否有未处理用户门控、是否有可执行 todo、配额是否耗尽）。自动化或长任务前可调用。',
          { goalId: z.string().describe('Goal ID') },
          async (args) => {
            const denied = authDenied(boundGoalId, args.goalId)
            if (denied) return { content: [{ type: 'text' as const, text: denied }] }
            const run = shouldGoalRun(args.goalId)
            return { content: [{ type: 'text' as const, text: run.shouldRun ? '可推进' : `不可推进: ${run.reason ?? ''}` }] }
          },
          { annotations: { readOnlyHint: true } },
        ),
      ],
    })
    mcpServers['proma_goal'] = server as unknown as Record<string, unknown>
    if (boundGoalId) {
      console.log(`[Agent 编排] 已注入 Goal 工具 (proma_goal, 绑定 ${boundGoalId})`)
    } else {
      console.log(`[Agent 编排] 已注入 Goal 工具 (proma_goal, 未绑定 Goal，仅拒绝访问)`)
    }
  } catch (err) {
    console.error(`[Agent 编排] 注入 Goal 工具失败:`, err)
  }
}
