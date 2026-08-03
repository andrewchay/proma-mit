/**
 * AI 员工（Agent Employee）服务
 *
 * P0 核心闭环：
 * - 员工档案 CRUD（委托 project-sqlite-store）
 * - AgentTodoProvider：作为第三种 TodoProvider 注册（name: 'agent'），
 *   任务指派给 AI 员工时自动触发 headless Agent 执行
 * - 执行编排：创建会话 → headless 执行（默认 safe）→ onComplete/onError 回写
 * - 心跳检查（60s）：isAgentSessionActive 探测会话存活 + 超时中止 + stale 回退可重试
 */

import { randomUUID } from 'node:crypto'
import * as store from './project-sqlite-store'
import type {
  AgentEmployee,
  AgentExecution,
  CreateAgentEmployeeInput,
  UpdateAgentEmployeeInput,
  Task,
} from './project-types'
import { registerTodoProvider } from './project-sync-service'
import { createAgentSession } from './agent-session-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from './agent-headless-runner-registry'
import { isAgentSessionActive } from './agent-service'
import { updateTask, getTask } from './project-service'
import { getSettings } from './settings-service'
import type { AgentMessage } from '@proma/shared'

// ============================================
// 员工 CRUD（服务层薄封装）
// ============================================

export function listAgentEmployees(): AgentEmployee[] {
  return store.listAgentEmployees()
}

export function getAgentEmployee(id: string): AgentEmployee | null {
  return store.getAgentEmployee(id)
}

export function createAgentEmployee(input: CreateAgentEmployeeInput): AgentEmployee {
  return store.createAgentEmployee(input)
}

export function updateAgentEmployee(id: string, patch: UpdateAgentEmployeeInput): AgentEmployee | null {
  return store.updateAgentEmployee(id, patch)
}

export function deleteAgentEmployee(id: string): boolean {
  return store.deleteAgentEmployee(id)
}

// ============================================
// 执行记录查询
// ============================================

export function listAgentExecutionsByEntity(entityType: 'task' | 'subTask', entityId: string): AgentExecution[] {
  return store.listAgentExecutionsByEntity(entityType, entityId)
}

export function listAgentExecutionsByAgent(agentId: string, limit = 50): AgentExecution[] {
  return store.listAgentExecutionsByAgent(agentId, limit)
}

// ============================================
// 指派判断与执行
// ============================================

/** AI 员工 userId 前缀 */
export const AGENT_ASSIGNEE_PREFIX = 'agent-'

/** 判断任务是否指派给 AI 员工 */
export function isAgentAssignee(task: Pick<Task, 'assignee'>): boolean {
  return task.assignee?.userId?.startsWith(AGENT_ASSIGNEE_PREFIX) ?? false
}

/** 从 assignee.userId 解析 AI 员工 ID */
export function parseAgentId(assigneeUserId: string | undefined): string | null {
  if (!assigneeUserId?.startsWith(AGENT_ASSIGNEE_PREFIX)) return null
  return assigneeUserId.slice(AGENT_ASSIGNEE_PREFIX.length) || null
}

/** 构建 AI 员工执行 prompt（角色 + 任务上下文 + 权限 + 输出要求） */
export function buildAgentTaskPrompt(task: Task, employee: AgentEmployee): string {
  const deadline = task.dueDate ? new Date(task.dueDate).toLocaleString('zh-CN') : '未设置'
  const rolePrompt = employee.systemPrompt?.trim()
    ? employee.systemPrompt.trim()
    : `你是一名「${employee.role}」AI 员工（${employee.name}）。${employee.description || '请根据角色描述完成任务。'}`

  // by-task 权限声明（P1）
  const perms = task.permissionRequests ?? []
  const permLines = perms.length > 0
    ? [
        '',
        '## 本次任务已获权限',
        ...perms.map((p) => `- ${p}`),
      ]
    : [
        '',
        '## 本次任务权限',
        '- 默认安全模式：只读操作（读文件、搜索、联网只读）可用',
        '- 如需写文件/执行命令但未获授权，请说明并停止，不要强行执行',
      ]

  return [
    rolePrompt,
    '',
    '## 本次任务',
    `- 任务：${task.title}`,
    `- 描述：${task.description || '（无）'}`,
    `- 优先级：${task.priority}  截止：${deadline}`,
    task.parentId ? `- 父任务：${store.getTask(task.parentId)?.title ?? task.parentId}` : '',
    '',
    '## 工作区约定',
    `- 工作区根目录为你的 cwd；如产出交付文件，请在 workspace-files/agents/${employee.id}/ 目录下创建，避免与其他员工冲突`,    ...permLines,
    '',
    '## 输出要求',
    '完成任务后，请最后输出一段「完成说明」：',
    '1. 你做了什么（关键步骤与结论）',
    '2. 交付物 / 产出文件清单（如在工作区产生了文件，给出路径）',
    '3. 遗留风险或未完成事项',
    '若无法完成，请明确说明卡点和原因。',
  ].filter(Boolean).join('\n')
}

/** 解析执行完成摘要：取最后一条 assistant 消息的文本 */
export function extractExecutionSummary(messages: AgentMessage[] | undefined): string {
  if (!messages?.length) return '执行完成（无摘要）'
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content)
  if (!last) return '执行完成（无摘要）'
  const text = typeof last.content === 'string' ? last.content : String(last.content ?? '')
  return text.trim().slice(0, 2000) || '执行完成（无摘要）'
}

/** 执行记录 → 活动流 */
function recordActivity(execution: AgentExecution, action: string, summary: string, extra?: Record<string, unknown>): void {
  store.recordProjectActivity({
    projectId: execution.projectId,
    entityType: execution.entityType,
    entityId: execution.entityId,
    action,
    summary,
    payload: extra ?? undefined,
    actor: `agent-${execution.agentId}`,
  })
}

// ============================================
// 执行编排
// ============================================

/** 同项目 AI 员工并发执行上限（P1 并发控制） */
export const PROJECT_CONCURRENCY_LIMIT = 3

/** 任务指派给 AI 员工：入队（异步，立即返回 executionId）；并发有额度时立即启动，否则排队等待心跳调度 */
export async function dispatchTaskToAgent(task: Task): Promise<{ taskId: string } | null> {
  const agentId = parseAgentId(task.assignee?.userId)
  if (!agentId) return null
  const employee = store.getAgentEmployee(agentId)
  if (!employee) {
    console.error(`[AgentEmployee] 员工不存在: ${agentId}`)
    return null
  }
  if (!employee.enabled) {
    console.error(`[AgentEmployee] 员工已停用: ${employee.name}`)
    return null
  }

  const executionId = randomUUID()
  const prompt = buildAgentTaskPrompt(task, employee)

  // 1. 记录执行（queued，等并发调度）
  store.createAgentExecution({
    id: executionId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    agentId,
    sessionId: '',
    prompt,
    status: 'queued',
    requestedPermissions: task.permissionRequests ?? [],
    startedAt: Date.now(),
  })
  const execution = store.getAgentExecution(executionId)
  if (execution) recordActivity(execution, 'agent_queued', `AI 员工 ${employee.name} 已接收任务「${task.title}」，等待调度`)

  // 2. 尝试启动（并发有额度才真正建会话执行）
  void tryStartExecution(executionId)

  return { taskId: executionId }
}

/** 尝试启动一个 queued 执行：同项目并发未超限时才启动 */
export async function tryStartExecution(executionId: string): Promise<boolean> {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'queued') return false
  const employee = store.getAgentEmployee(execution.agentId)
  if (!employee || !employee.enabled) return false

  // 并发控制：同项目运行中数量上限
  const runningCount = store.listRunningAgentExecutions().filter((e) => e.projectId === execution.projectId).length
  if (runningCount >= PROJECT_CONCURRENCY_LIMIT) {
    console.log(`[AgentEmployee] 项目 ${execution.projectId} 并发已达上限（${PROJECT_CONCURRENCY_LIMIT}），任务 ${executionId} 保持排队`)
    return false
  }

  return startAgentHeadless(executionId, employee)
}

/** 真正启动 headless Agent 执行（创建会话 + 启动） */
async function startAgentHeadless(executionId: string, employee: AgentEmployee): Promise<boolean> {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'queued') return false

  const workspaceId = employee.workspaceId ?? getSettings().agentWorkspaceId

  // 1. 创建独立 Agent 会话
  let sessionId: string
  try {
    const task = store.getTask(execution.entityId)
    const session = createAgentSession(
      `[AI员工] ${employee.name} · ${task?.title.slice(0, 30) ?? execution.entityId}`,
      employee.channelId,
      workspaceId,
      employee.modelId,
      employee.runtime,
    )
    sessionId = session.id
  } catch (error) {
    console.error('[AgentEmployee] 创建会话失败:', error)
    handleExecutionError(executionId, '创建 Agent 会话失败', execution.startedAt)
    return false
  }

  // 2. 更新执行：sessionId + running
  store.updateAgentExecution(executionId, { sessionId, status: 'running', lastHeartbeatAt: Date.now() })
  const updated = store.getAgentExecution(executionId)!
  recordActivity(updated, 'agent_started', `AI 员工 ${employee.name} 开始执行任务`)

  // 3. 启动 headless Agent
  // by-task 权限：任务申请了 bash/write/web/mcp → bypassPermissions（无人值守真正干活）；默认 safe（只读）
  const hasPermissions = (execution.requestedPermissions?.length ?? 0) > 0
  const permissionModeOverride = hasPermissions ? 'bypassPermissions' : 'safe'
  const startedAt = Date.now()
  runRegisteredHeadlessAgent(
    {
      sessionId,
      userMessage: execution.prompt,
      channelId: employee.channelId,
      modelId: employee.modelId,
      agentRuntime: employee.runtime,
      workspaceId,
      permissionModeOverride,
      triggeredBy: 'automation',
      startedAt,
    },
    {
      source: 'delegation',
      originSessionId: sessionId,
      onError: (error) => {
        handleExecutionError(executionId, error, startedAt)
      },
      onComplete: (messages) => {
        handleExecutionComplete(executionId, messages, startedAt)
      },
      onTitleUpdated: () => {
        // 标题已在创建会话时设定，无需额外处理
      },
    },
  ).catch((error: unknown) => {
    handleExecutionError(executionId, error instanceof Error ? error.message : '未知错误', startedAt)
  })

  return true
}

/** 执行完成回写 */
function handleExecutionComplete(executionId: string, messages: AgentMessage[] | undefined, startedAt: number): void {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status === 'completed' || execution.status === 'failed') return

  const summary = extractExecutionSummary(messages)
  const completedAt = Date.now()
  store.updateAgentExecution(executionId, {
    status: 'completed',
    resultSummary: summary,
    lastHeartbeatAt: completedAt,
    completedAt,
  })

  // 回写任务
  try {
    updateTask(execution.entityId, {
      status: 'completed',
      completionNotes: summary,
      completedAt,
    })
  } catch (error) {
    console.error('[AgentEmployee] 回写任务状态失败:', error)
  }

  // 更新员工统计
  store.bumpAgentEmployeeStats(execution.agentId, {
    completed: true,
    durationMs: completedAt - startedAt,
  })

  recordActivity(
    store.getAgentExecution(executionId)!,
    'agent_completed',
    `AI 员工完成任务「${execution.entityId}」：${summary.slice(0, 80)}`,
  )
}

/** 执行失败回写 */
function handleExecutionError(executionId: string, error: string, startedAt: number): void {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status === 'completed') return

  const failedAt = Date.now()
  store.updateAgentExecution(executionId, {
    status: 'failed',
    error: error.slice(0, 500),
    lastHeartbeatAt: failedAt,
    completedAt: failedAt,
  })

  // 任务回退 paused，保留上下文可重试
  try {
    updateTask(execution.entityId, {
      status: 'paused',
      completionNotes: `【AI 执行失败】${error.slice(0, 200)}`,
    })
  } catch (error_) {
    console.error('[AgentEmployee] 回写任务失败状态失败:', error_)
  }

  store.bumpAgentEmployeeStats(execution.agentId, { failed: true, durationMs: failedAt - startedAt })

  recordActivity(
    store.getAgentExecution(executionId)!,
    'agent_failed',
    `AI 员工执行任务失败：${error.slice(0, 120)}`,
  )
}

// ============================================
// 心跳检查（60s）
// ============================================

const HEARTBEAT_INTERVAL_MS = 60_000
const DEFAULT_MAX_DURATION_MS = 60 * 60_000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

/** 启动心跳扫描（应用启动时调用一次；幂等） */
export function startAgentEmployeeHeartbeat(maxDurationMs: number = DEFAULT_MAX_DURATION_MS): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    scanAgentEmployeeHeartbeat(maxDurationMs)
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}

/** 停止心跳扫描（应用退出时调用） */
export function stopAgentEmployeeHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

/** 心跳扫描：调度 queued 执行 + 探测 running 执行（失联/超时） */
export function scanAgentEmployeeHeartbeat(maxDurationMs: number = DEFAULT_MAX_DURATION_MS): void {
  const running = store.listRunningAgentExecutions()
  const now = Date.now()

  // 1. 先调度 queued 执行（并发额度释放后启动）
  for (const execution of running.filter((e) => e.status === 'queued')) {
    void tryStartExecution(execution.id)
  }

  // 2. 探测 running 执行
  for (const execution of running.filter((e) => e.status === 'running')) {
    // 1. 会话仍活跃 → 更新心跳
    try {
      if (isAgentSessionActive(execution.sessionId)) {
        store.updateAgentExecution(execution.id, { lastHeartbeatAt: now })
        continue
      }
    } catch (error) {
      console.error(`[AgentEmployee] 心跳探测失败 session=${execution.sessionId}:`, error)
      // 探测异常按失联处理，避免任务永久悬挂
    }

    // 2. 会话不活跃（进程已结束但回调丢失）→ 标记 stale，任务回退 paused 可重试
    const duration = now - execution.startedAt
    const timedOut = duration > maxDurationMs
    store.updateAgentExecution(execution.id, {
      status: timedOut ? 'failed' : 'stale',
      error: timedOut ? `执行超时（${Math.round(duration / 60_000)}min > ${Math.round(maxDurationMs / 60_000)}min）` : 'Agent 会话失联，结果未回写',
      lastHeartbeatAt: now,
      completedAt: now,
    })
    try {
      updateTask(execution.entityId, { status: 'paused', completionNotes: `【AI 执行${timedOut ? '超时' : '失联'}】${timedOut ? '已中止' : '请重试或人工介入'}` })
    } catch {
      // 任务可能已删除
    }
    recordActivity(
      store.getAgentExecution(execution.id)!,
      timedOut ? 'agent_timed_out' : 'agent_stale',
      `AI 员工执行${timedOut ? '超时中止' : '失联'}：任务已回退待重试`,
    )
  }
}

// ============================================
// AgentTodoProvider 注册
// ============================================

/** 注册 AI 员工 TodoProvider（name: 'agent'），并启动心跳扫描 */
export function registerAgentEmployeeProvider(): () => void {
  registerTodoProvider({
    name: 'agent',
    async createTodo(task, userId) {
      // userId 即 'agent-<id>'；若任务 assignee 已是 AI 员工则直接派发
      const result = await dispatchTaskToAgent(task)
      return { taskId: result?.taskId ?? '', status: 'in_progress' }
    },
    async updateTodoStatus(taskId, status) {
      // 任务被手动改状态 → 中止对应执行
      const execution = store.getAgentExecution(taskId)
      if (execution && (execution.status === 'queued' || execution.status === 'running')) {
        try {
          stopRegisteredAgent(execution.sessionId)
        } catch {
          // 会话可能已结束
        }
        store.updateAgentExecution(execution.id, {
          status: 'cancelled',
          error: '任务已手动改状态，执行被取消',
          completedAt: Date.now(),
        })
      }
      return true
    },
    async queryTodoStatus(taskId) {
      const execution = store.getAgentExecution(taskId)
      if (!execution) return null
      if (execution.status === 'running') return 'in_progress'
      if (execution.status === 'completed') return 'completed'
      if (execution.status === 'failed' || execution.status === 'stale') return 'failed'
      return execution.status
    },
    async getUserIdByPaaUserId(paaUserId) {
      const agentId = parseAgentId(paaUserId)
      if (!agentId) return null
      const employee = store.getAgentEmployee(agentId)
      return employee && employee.enabled ? employee.id : null
    },
  })

  startAgentEmployeeHeartbeat()

  return () => {
    stopAgentEmployeeHeartbeat()
  }
}
