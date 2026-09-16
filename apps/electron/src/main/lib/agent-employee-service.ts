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

import { createHash, randomUUID } from 'node:crypto'
import { getAgentWorkspace } from './agent-workspace-manager'
import { getAgentSessionWorkspacePath } from './config-paths'
import { getChannelById } from './channel-manager'
import { buildDevelopmentInstructions, validateDevelopmentTarget } from './agent-development-context'
import { createDevelopmentWorktree, resolveDevelopmentWorktree, captureDevelopmentEvidence } from './agent-development-worktree'
import { getProjectChain } from './project-chain-service'
import { normalizeExecutionMessages, currentExecutionMessages } from './agent-execution-messages'
import { resolveStateGroup } from './task-status-logic'

import * as store from './project-sqlite-store'
import type {
  AgentEmployee,
  AgentExecution,
  CreateAgentEmployeeInput,
  UpdateAgentEmployeeInput,
  Task,
} from './project-types'
import { registerTodoProvider } from './project-sync-service'
import { createAgentSession, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionMessages } from './agent-session-manager'
import { runRegisteredHeadlessAgent, stopRegisteredAgent } from './agent-headless-runner-registry'
import { isAgentSessionActive } from './agent-service'
import { updateTask, getTask, updateExecutionSubTask } from './project-service'
import { getSettings } from './settings-service'
import { createWorkflowRun, getWorkflowRun, cancelWorkflowRun } from './workflow-service'
import { executeWorkflowRun } from './workflow-run-executor'
import type { AgentMessage } from '@gravitas/shared'
import { PROJECT_IPC_CHANNELS } from '@gravitas/shared'

/**
 * Agent 护栏外推通知（飞书/钉钉找人）：卡点待决策、配额超限等需要人介入的场景，
 * 经钉钉群机器人推送（未配置则静默跳过——通知失败不影响护栏主流程）。
 */
async function notifyAgentGuardrail(projectId: string, taskId: string, title: string, detail: string): Promise<void> {
  try {
    const task = store.getTask(taskId)
    if (!task) return
    const { sendDingTalkRobotMessage } = await import('./dingtalk-todo-provider')
    await sendDingTalkRobotMessage({
      title: `【AI 员工】${title}`,
      text: `**${title}**\n\n任务：${task.title}\n项目：${projectId}\n\n${detail}\n\n> 请打开 Gravitas 项目看板处理。`,
    })
  } catch (error) {
    console.debug('[AgentEmployee] 护栏通知发送失败（静默）:', error instanceof Error ? error.message : error)
  }
}

/** 任务级 token 配额：按执行会话聚合 token 消耗（token-usage 按会话记录，execution.sessionId 即会话 id） */
function getTaskTokenUsage(sessionId: string): number {
  try {
    void import('./token-usage-service')
    // 同步场景下用 require 保证心跳内可用；失败按 0 处理（不因统计缺失而误刹车）
    const mod = require('./token-usage-service') as { getCostMiniLedger: (q: { sessionId: string }) => { totalTokens: number } }
    return mod.getCostMiniLedger({ sessionId })?.totalTokens ?? 0
  } catch {
    return 0
  }
}

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
  validateEmployeeConfiguration(input)
  return store.createAgentEmployee(input)
}

export function updateAgentEmployee(id: string, patch: UpdateAgentEmployeeInput): AgentEmployee | null {
  const current = store.getAgentEmployee(id)
  if (!current) return null
  // 兼容旧单工作区编辑语义：显式清空 workspaceId 同时清空由旧字段迁移出的集合。
  const normalizedPatch = patch.workspaceId === undefined && Object.prototype.hasOwnProperty.call(patch, 'workspaceId') && patch.workspaceIds === undefined
    ? { ...patch, workspaceIds: [] }
    : patch
  validateEmployeeConfiguration({ ...current, ...normalizedPatch })
  return store.updateAgentEmployee(id, normalizedPatch)
}

function validateEmployeeConfiguration(input: CreateAgentEmployeeInput): void {
  if (input.executionProfile && !['general', 'development'].includes(input.executionProfile)) throw new Error('未知员工执行配置')
  if (input.permissionMode && !['safe', 'auto'].includes(input.permissionMode)) throw new Error('不支持的员工权限模式')
  const workspaceIds = [...new Set((input.workspaceIds ?? (input.workspaceId ? [input.workspaceId] : [])).filter(Boolean))]
  if (input.workspaceIds && workspaceIds.length !== input.workspaceIds.length) throw new Error('可用工作区不能包含重复或空值')
  if (input.executionProfile === 'development') {
    if (workspaceIds.length === 0) throw new Error('研发员工至少需要选择一个本地 Git 工作区')
    for (const workspaceId of workspaceIds) {
      if (!getAgentWorkspace(workspaceId)?.rootPath) throw new Error('研发员工只能选择绑定本地 Git 仓库的工作区')
    }
    validateDevelopmentTarget({ ...input, workspaceIds, workspaceId: workspaceIds.length === 1 ? workspaceIds[0] : undefined, runtime: input.runtime ?? 'proma' }, undefined, {
      getChannel: getChannelById, getWorkspace: getAgentWorkspace,
    })
  }
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

export function listAgentEmployeeCapabilityVersions(agentId: string) {
  return store.listAgentEmployeeCapabilityVersions(agentId)
}

export function listAgentEmployeeLearningSamples(agentId: string) {
  return store.listAgentEmployeeLearningSamples(agentId)
}

export function reviewAgentEmployeeLearningSample(id: string, evidenceSummary: string) {
  return store.reviewAgentEmployeeLearningSample(id, evidenceSummary)
}

export function excludeAgentEmployeeLearningSample(id: string) {
  return store.excludeAgentEmployeeLearningSample(id)
}

/**
 * 显式停止项目中的一条 AI 员工执行。
 *
 * 只处理 queued/running 记录：queued 不会启动，running 会先中止 Runtime/Workflow，随后
 * 回写 execution 与任务为可人工处理的 paused。不会删除 worktree、会话或已有证据。
 */
function recordLearningSample(execution: AgentExecution, outcome: 'accepted' | 'changes_requested' | 'failed' | 'cancelled', evidenceSummary: string): void {
  if (!execution.entityType || execution.entityType !== 'task') return
  store.createAgentEmployeeLearningSample({
    agentId: execution.agentId,
    executionId: execution.id,
    projectId: execution.projectId,
    taskId: execution.entityId,
    capabilityVersionIds: execution.capabilityVersionIds ?? [],
    outcome,
    evidenceSummary: evidenceSummary.slice(0, 4000),
    privacyStatus: 'pending',
    labeledAt: Date.now(),
  })
}

export function cancelAgentExecution(executionId: string): { id: string; status: 'cancelled' } {
  const execution = store.getAgentExecution(executionId)
  if (!execution) throw new Error('未找到 Agent 执行记录')
  if (execution.status !== 'queued' && execution.status !== 'running') {
    throw new Error(`仅能停止排队或运行中的执行，当前状态：${execution.status}`)
  }

  if (execution.status === 'running' && execution.sessionId) {
    const workflowRun = /^workflow:(.+)$/.exec(execution.sessionId)
    if (workflowRun) {
      const workflowId = store.getAgentEmployee(execution.agentId)?.workflowId
      if (workflowId) cancelWorkflowRun(workflowId, workflowRun[1]!)
    } else {
      try {
        stopRegisteredAgent(execution.sessionId)
      } catch (error) {
        console.warn(`[AgentEmployee] 停止 Runtime 失败 session=${execution.sessionId}:`, error)
      }
    }
  }

  const stoppedAt = Date.now()
  store.updateAgentExecution(execution.id, {
    status: 'cancelled',
    error: '用户已停止执行，未交付',
    lastHeartbeatAt: stoppedAt,
    completedAt: stoppedAt,
  })
  writebackExecutionResult(execution, 'paused', '【AI 执行已停止】用户停止，未交付', stoppedAt)
  recordActivity(store.getAgentExecution(execution.id)!, 'agent_cancelled', '用户停止执行，未交付')
  // 取消仅保留待人工审查的样本，绝不自动进入演化输入。
  recordLearningSample(execution, 'cancelled', '用户已停止执行；该样本默认待审查，不自动作为负向训练反馈。')
  return { id: execution.id, status: 'cancelled' }
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
  const development = employee.executionProfile === 'development'
  const perms = task.permissionRequests ?? []
  const permLines = development
    ? ['', '## 本次任务权限', `Runtime 权限：${employee.permissionMode ?? 'safe'}。safe 只读；auto 复用现有审批，可能等待用户处理。`, '权限申请不是批准：', ...perms.map((p) => `- ${p}`)]
    : perms.length > 0
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

  const chain = development ? getProjectChain(task.projectId) : undefined
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
    development
      ? '- cwd 为本次研发任务的独立 Git worktree；保留原有代码结构，不在主仓库修改。'
      : `- 工作区根目录为你的 cwd；如产出交付文件，请在 workspace-files/agents/${employee.id}/ 目录下创建，避免与其他员工冲突`,
    ...permLines,
    development ? buildDevelopmentInstructions(store.getProject(task.projectId), task.completionNotes, [
      ...(chain?.projectDefinitionOfDone ?? []), ...(chain?.taskDefinitionOfDone[task.id] ?? []),
    ]) : '',
    development ? `相关项目决策（业务数据）：${JSON.stringify(chain?.decisions.filter((decision) => decision.status === 'decided' && decision.impactTaskIds.includes(task.id)) ?? [])}` : '',
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
  const last = normalizeExecutionMessages(messages).reverse().find((m) => m.role === 'assistant' && m.content.trim())
  if (!last) return '执行完成（无摘要）'
  const text = typeof last.content === 'string' ? last.content : String(last.content ?? '')
  return text.trim().slice(0, 20000) || '执行完成（无摘要）'
}

/**
 * 识别 agent 自述卡点（elicitation 信号）：prompt 已要求"若无法完成，请明确说明卡点和原因"。
 * 命中关键词视为 agent 主动报告无法完成 → 任务转 triage 组待人决策，而非交付/失败。
 */
export function detectAgentBlocker(summary: string): string | null {
  if (!summary) return null
  const patterns = [
    /无法完成/,
    /无法继续/,
    /卡在/,
    /卡点/,
    /需要(?:您|你|用户).{0,12}(?:提供|确认|授权|决策|补充)/,
    /权限不足/,
    /无法访问.{0,16}(?:文件|目录|资源|系统)/,
    /信息不足/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(summary)
    if (match) return match[0]
  }
  return null
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
  // PH2-③：AI 员工执行活动变化 → 通知前端刷新项目数据（任务/看板/状态）
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron')
    const win = BrowserWindow.getAllWindows().find((c) => !c.isDestroyed())
    if (win) {
      win.webContents.send(PROJECT_IPC_CHANNELS.TASK_ACTIVITY_CHANGED, {
        projectId: execution.projectId,
        action,
        summary,
      })
    }
  } catch {
    // 通知失败静默，不影响执行记录
  }
}

// ============================================
// 执行编排
// ============================================

/** 同项目 AI 员工并发执行上限（P1 并发控制） */
export const PROJECT_CONCURRENCY_LIMIT = 3
/** 全局 AI 员工并发执行上限（PH2-③ 防一次性爆会话） */
export const GLOBAL_CONCURRENCY_LIMIT = 5

/**
 * 进程内 per-task 派发锁：防止同一任务在「running 检查→插入 execution」之间被并发
 * （多个 onTaskChange('updated') / 手动入口）重复派发。锁在 dispatchTaskToAgent 的
 * 检查-创建关键段持有，执行完释放，避免同任务产生两条 queued/running execution。
 */
const dispatchInFlight = new Set<string>()

/** 任务指派给 AI 员工：入队（异步，立即返回 executionId）；并发有额度时立即启动，否则排队等待心跳调度 */
export async function dispatchTaskToAgent(task: Task): Promise<{ taskId: string } | null> {
  const agentId = parseAgentId(task.assignee?.userId)
  if (!agentId) return null

  // 幂等派发锁：同一任务同时在派发中则跳过（防止并发 updated 双派发）
  if (dispatchInFlight.has(task.id)) return null
  dispatchInFlight.add(task.id)
  try {
    return await dispatchTaskToAgentLocked(task, agentId)
  } finally {
    dispatchInFlight.delete(task.id)
  }
}

/** 改派时释放旧员工尚未启动的排队项，避免新负责人被幂等检查永久挡住。 */
function cancelReassignedQueue(task: Task): void {
  for (const run of store.listAgentExecutionsByEntity('task', task.id)) {
    if (run.status === 'queued' && run.agentId !== parseAgentId(task.assignee?.userId)) {
      store.updateAgentExecution(run.id, { status: 'cancelled', completedAt: Date.now(), error: '任务已改派，取消旧排队项' })
      recordActivity(store.getAgentExecution(run.id)!, 'agent_cancelled', '任务已改派，取消旧排队项')
    }
  }
}

function isExecutableAgentTask(task: Task): boolean {
  if (task.status === 'draft' || task.status === 'paused') return false
  const group = resolveStateGroup(task.status, store.listTaskStatuses(task.projectId))
  return group === 'unstarted' || group === 'started'
}

async function dispatchTaskToAgentLocked(task: Task, agentId: string): Promise<{ taskId: string } | null> {
  // PH2-③ 统一只派发可执行态（pending / in_progress），completed/draft/paused 一律不派发：
  //   - completed/draft：防“完成任务→回写→onTaskChange→再派发”死循环（每轮写一个新工作日志/100字文件）
  //   - paused：任务处于人工暂停/失败回退态，不应自动重跑（否则失败回写置 paused 后又会被重派，形成类死循环变体）
  if (!isExecutableAgentTask(task)) {
    if (task.status === 'completed') console.log(`[Diag][agent-employee] 跳过已完成任务 dispatch: task=${task.id} status=${task.status}`)
    return null
  }

  const employee = store.getAgentEmployee(agentId)
  if (!employee) {
    console.error(`[AgentEmployee] 员工不存在: ${agentId}`)
    return null
  }
  if (!employee.enabled) {
    console.error(`[AgentEmployee] 员工已停用: ${employee.name}`)
    return null
  }

  cancelReassignedQueue(task)
  if (store.listAgentExecutionsByEntity('task', task.id).some((run) => run.status === 'queued' || run.status === 'running')) return null
  const executionId = randomUUID()
  const capabilityVersions = store.getActiveAgentEmployeeCapabilityVersions(employee.id, task.workspaceId)
  const capabilityContent = capabilityVersions.map((version) => version.content).filter(Boolean).join('\n\n')
  const capabilityHash = createHash('sha256').update(capabilityContent).digest('hex')
  const prompt = `${buildAgentTaskPrompt(task, employee)}${capabilityContent ? `\n\n## 已冻结员工能力版本\n${capabilityContent}` : ''}`
  const usesWorkflow = Boolean(employee.workflowId)

  // 1. 记录执行（queued，等并发调度；executor 标记 headless / workflow）
  store.createAgentExecution({
    id: executionId,
    projectId: task.projectId,
    entityType: 'task',
    entityId: task.id,
    agentId,
    sessionId: '',
    executor: usesWorkflow ? 'workflow' : 'headless',
    prompt,
    status: 'queued',
    requestedPermissions: task.permissionRequests ?? [],
    capabilityVersionIds: capabilityVersions.map((version) => version.id),
    capabilityContentHash: capabilityHash,
    startedAt: Date.now(),
  })
  const execution = store.getAgentExecution(executionId)
  if (execution) recordActivity(execution, 'agent_queued', `AI 员工 ${employee.name} 已接收任务「${task.title}」，等待调度`)

  // 2. 尝试启动（并发有额度才真正建会话执行）
  void tryStartExecution(executionId).catch((error: unknown) => handleExecutionError(executionId, error instanceof Error ? error.message : '启动失败', Date.now()))

  return { taskId: executionId }
}

/**
 * 幂等派发：仅当任务当前没有进行中（queued/running）的 AI 执行时才 dispatch。
 * 供“任务改派给 AI 员工”/“任务重新指派”场景使用，避免每次 updated 都重复创建执行。
 */
export async function dispatchTaskToAgentIfIdle(task: Task): Promise<{ taskId: string } | null> {
  if (!isAgentAssignee(task)) return null
  // 只有可执行态（pending / in_progress）才允许派发；completed/draft/paused 均拒绝：
  // - completed/draft：防完成回写→onTaskChange→再派发的死循环
  // - paused：任务处于人工暂停/失败回退态，不应自动重跑（否则失败回写置 paused 后又会被重派，形成类死循环变体）
  if (!isExecutableAgentTask(task)) return null
  cancelReassignedQueue(task)
  const running = store.listAgentExecutionsByEntity('task', task.id)
    .some((e) => e.status === 'queued' || e.status === 'running')
  if (running) return null
  return dispatchTaskToAgent(task)
}

/** 尝试启动一个 queued 执行：同项目并发未超限时才启动 */
export async function tryStartExecution(executionId: string): Promise<boolean> {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'queued') return false
  if (execution.entityType === 'task') {
    const current = store.getTask(execution.entityId)
    if (!current || !isExecutableAgentTask(current) || parseAgentId(current.assignee?.userId) !== execution.agentId) {
      store.updateAgentExecution(executionId, { status: 'cancelled', completedAt: Date.now(), error: '任务已删除、暂停或改派，取消排队' })
      if (current && isExecutableAgentTask(current) && isAgentAssignee(current)) {
        await dispatchTaskToAgentIfIdle(current)
      }
      return false
    }
  }
  const employee = store.getAgentEmployee(execution.agentId)
  if (!employee || !employee.enabled) return false

  // 并发控制：同项目运行中数量上限（仅统计真正 running，排队中的不占用额度，避免同项目多个排队互相死锁）
  const runningCount = store.listRunningAgentExecutions().filter((e) => e.projectId === execution.projectId && e.status === 'running').length
  if (runningCount >= PROJECT_CONCURRENCY_LIMIT) {
    console.log(`[AgentEmployee] 项目 ${execution.projectId} 并发已达上限（${PROJECT_CONCURRENCY_LIMIT}），任务 ${executionId} 保持排队`)
    return false
  }
  // PH2-③：全局并发上限，防一次性爆开大量子会话
  const globalRunning = store.listRunningAgentExecutions().filter((e) => e.status === 'running').length
  if (globalRunning >= GLOBAL_CONCURRENCY_LIMIT) {
    console.log(`[AgentEmployee] 全局并发已达上限（${GLOBAL_CONCURRENCY_LIMIT}），任务 ${executionId} 保持排队`)
    return false
  }

  // P3：员工绑定 Workflow SOP → 走 Workflow 执行；否则 headless
  if (employee.workflowId) {
    return startAgentWorkflow(executionId, employee)
  }  return startAgentHeadless(executionId, employee)
}

/** 真正启动 headless Agent 执行（创建会话 + 启动） */
async function startAgentHeadless(executionId: string, employee: AgentEmployee): Promise<boolean> {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'queued') return false

  // PH2-③：执行工作区优先级 = 任务指定的 workspaceId → 员工档案 → 全局默认
  const task = execution.entityType === 'task' ? store.getTask(execution.entityId) : null
  const development = employee.executionProfile === 'development'
  let workspaceId = task?.workspaceId ?? employee.workspaceId ?? getSettings().agentWorkspaceId
  let modelId = employee.modelId
  let permissionModeOverride: 'safe' | 'auto' | 'bypassPermissions' = 'bypassPermissions'
  if (development) {
    try {
      if (!task || !isExecutableAgentTask(task) || parseAgentId(task.assignee?.userId) !== employee.id) throw new Error('任务已删除、暂停或改派，请重新确认')
      if (store.listTaskBlockers(task.projectId).some((blocker) => blocker.taskId === task.id)) throw new Error('任务依赖尚未解除，不能开始研发执行')
      const target = validateDevelopmentTarget(employee, task.workspaceId, { getChannel: getChannelById, getWorkspace: getAgentWorkspace })
      workspaceId = target.workspaceId
      modelId = target.modelId
      permissionModeOverride = target.permissionMode
    } catch (error) {
      handleExecutionError(executionId, error instanceof Error ? error.message : '研发配置无效', execution.startedAt)
      return false
    }
  }
  console.log(`[Diag][agent-employee] 执行 ${execution.id} task=${execution.entityId} 工作区=${
    task?.workspaceId ? `任务指定:${task.workspaceId}` : (employee.workspaceId ? `员工:${employee.workspaceId}` : `全局:${workspaceId}`)
  } 最终=${workspaceId}`)

  // 1. 创建独立 Agent 会话
  let sessionId: string
  try {
    const task = store.getTask(execution.entityId)
    const previous = development ? store.listAgentExecutionsByEntity('task', execution.entityId)
      .find((run) => run.id !== executionId && run.agentId === employee.id && run.outputFiles?.length && run.sessionId) : undefined
    const previousSession = previous ? getAgentSessionMeta(previous.sessionId) : undefined
    if (previous && (!previousSession || previousSession.workspaceId !== workspaceId || previousSession.agentRuntime !== employee.runtime || previousSession.channelId !== employee.channelId)) {
      throw new Error('上次研发会话与当前工作区、渠道或 Runtime 不一致；请恢复原配置继续返工，或新建任务')
    }
    if (previous && isAgentSessionActive(previous.sessionId)) throw new Error('上次研发会话仍在运行，请先停止或等待完成')
    const session = previousSession ?? createAgentSession(
      `[AI员工] ${employee.name} · ${task?.title.slice(0, 30) ?? execution.entityId}`,
      employee.channelId,
      workspaceId,
      modelId,
      employee.runtime,
    )
    sessionId = session.id
    // PH2-③ 追根因：AI 员工是无人值守执行，强制 delegationDepth=1 使其不能自我委派（
    //   协作子会话工具会因 delegationDepth>0 拒绝创建），从根上杜绝"创建100字文件却爆60+子会话"。
    updateAgentSessionMeta(sessionId, {
      delegationDepth: 1,
      stoppedByUser: false,
      ...(development ? { projectId: execution.projectId, knowledgeScopeMode: 'project' as const, permissionMode: permissionModeOverride, modelId } : {}),
    })
    // 尽早保留会话定位，创建 worktree 失败也能找到失败记录。
    store.updateAgentExecution(executionId, { sessionId })
    if (development) {
      const workspace = getAgentWorkspace(workspaceId!)!
      const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, sessionId)
      const previousPath = previous ? resolveDevelopmentWorktree(workspace.rootPath!, sessionDirectory) : undefined
      if (previous && !previousPath) throw new Error('上次研发 worktree 绑定缺失，不能在主仓库或新基线上静默返工')
      const worktree = previousPath ? { path: previousPath, continuedFromExecutionId: previous!.id } : createDevelopmentWorktree(workspace.rootPath!, sessionDirectory, executionId)
      const prompt = `${buildAgentTaskPrompt(task!, employee)}\n\n本次执行基线：${JSON.stringify(worktree)}`
      store.updateAgentExecution(executionId, { prompt, outputFiles: [worktree.path] })
    }
  } catch (error) {
    console.error('[AgentEmployee] 创建会话失败:', error)
    handleExecutionError(executionId, error instanceof Error ? error.message : '创建 Agent 会话失败', execution.startedAt)
    return false
  }

  // 2. 更新执行：sessionId + running
  store.updateAgentExecution(executionId, { sessionId, status: 'running', lastHeartbeatAt: Date.now() })
  const updated = store.getAgentExecution(executionId)!
  recordActivity(updated, 'agent_started', `AI 员工 ${employee.name} 开始执行任务`)

  // 研发员工不再绕过审批；普通员工暂保留旧路径，避免无关迁移。
  const startedAt = Date.now()
  const previousMessageIds = new Set(normalizeExecutionMessages(getAgentSessionMessages(sessionId)).map((message) => message.id).filter(Boolean))
  runRegisteredHeadlessAgent(
    {
      sessionId,
      userMessage: updated.prompt,
      channelId: employee.channelId,
      modelId,
      mentionedSkills: employee.skills,
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
        if (getAgentSessionMeta(sessionId)?.stoppedByUser) handleExecutionComplete(executionId, [], startedAt, true)
        else handleExecutionError(executionId, error, startedAt)
      },
      onComplete: (messages, result) => {
        handleExecutionComplete(executionId, currentExecutionMessages(messages, previousMessageIds), startedAt, result?.stoppedByUser || getAgentSessionMeta(sessionId)?.stoppedByUser)
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

/** 通过 Workflow SOP 执行（P3）：createWorkflowRun + executeWorkflowRun，完成后回写 */
async function startAgentWorkflow(executionId: string, employee: AgentEmployee): Promise<boolean> {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'queued' || !employee.workflowId) return false

  const startedAt = Date.now()
  store.updateAgentExecution(executionId, { status: 'running', lastHeartbeatAt: startedAt })
  const updated = store.getAgentExecution(executionId)!
  recordActivity(updated, 'agent_started', `AI 员工 ${employee.name} 开始执行任务（Workflow SOP）`)

  try {
    // run.input 注入任务上下文（agent 节点 prompt 可用 <workflow_input> 引用）
    const task = store.getTask(execution.entityId)
    const run = createWorkflowRun(employee.workflowId, {
      taskId: execution.entityId,
      taskTitle: task?.title ?? execution.entityId,
      taskDescription: task?.description ?? '',
      agentId: execution.agentId,
      agentName: employee.name,
      projectId: execution.projectId,
    }, 'event')

    // sessionId 标记 workflow:<runId>，供心跳与诊断
    store.updateAgentExecution(executionId, { sessionId: `workflow:${run.id}` })

    // 串行执行到无 ready 节点（可能遇到审批/失败）
    const finalRun = await executeWorkflowRun(
      employee.workflowId,
      run.id,
      employee.channelId,
      employee.modelId,
    )

    const completedAt = Date.now()
    // 防覆盖：await 期间用户可能已手动改任务状态（updateTodoStatus 会把 execution 置 cancelled），
    // 此时应放弃 workflow 回写，避免把用户的取消/完成覆盖回”进行中→completed”
    const live = store.getAgentExecution(executionId)
    if (live?.status === 'cancelled') return true

    if (finalRun.status === 'completed') {
      const summary = extractWorkflowSummary(finalRun)
      store.updateAgentExecution(executionId, {
        status: 'completed',
        resultSummary: summary,
        lastHeartbeatAt: completedAt,
        completedAt,
      })
      try {
        // 执行完成后暂停主任务待验收，不绕过完成/DoD 校验。
        writebackExecutionResult(store.getAgentExecution(executionId)!, 'completed', summary, completedAt)
      } catch { /* 任务可能已删除 */ }
      store.bumpAgentEmployeeStats(execution.agentId, { completed: true, durationMs: completedAt - startedAt })
      recordActivity(store.getAgentExecution(executionId)!, 'agent_completed', `AI 员工完成任务待确认（Workflow）：${summary.slice(0, 80)}`)
    } else if (finalRun.status === 'waiting_approval') {
      // SOP 含人工审批：任务回退 paused，等待审批后重试
      store.updateAgentExecution(executionId, {
        status: 'stale',
        error: 'Workflow 等待人工审批',
        lastHeartbeatAt: completedAt,
        completedAt,
      })
      try {
        updateTask(execution.entityId, { status: 'paused', completionNotes: '【AI 执行】Workflow 等待人工审批' })
      } catch { /* ignore */ }
      recordActivity(store.getAgentExecution(executionId)!, 'agent_stale', 'AI 员工执行：Workflow 等待人工审批')
    } else {
      // failed / cancelled / blocked
      const errMsg = finalRun.status === 'failed' ? 'Workflow 执行失败' : `Workflow ${finalRun.status}`
      store.updateAgentExecution(executionId, {
        status: 'failed',
        error: errMsg,
        lastHeartbeatAt: completedAt,
        completedAt,
      })
      try {
        updateTask(execution.entityId, { status: 'paused', completionNotes: `【AI 执行失败】${errMsg}` })
      } catch { /* ignore */ }
      store.bumpAgentEmployeeStats(execution.agentId, { failed: true, durationMs: completedAt - startedAt })
      recordActivity(store.getAgentExecution(executionId)!, 'agent_failed', `AI 员工执行失败：${errMsg}`)
    }
  } catch (error) {
    handleExecutionError(executionId, error instanceof Error ? error.message : 'Workflow 执行异常', startedAt)
  }

  return true
}

/** 从 Workflow Run 提取结果摘要（聚合各节点 output） */
function extractWorkflowSummary(run: { nodeRuns: Record<string, { output?: Record<string, unknown> }> }): string {
  const outputs = Object.values(run.nodeRuns)
    .map((n) => n.output)
    .filter((o): o is Record<string, unknown> => Boolean(o && Object.keys(o).length > 0))
  if (outputs.length === 0) return 'Workflow SOP 执行完成'
  const parts = outputs.map((o) => {
    const text = Object.values(o).find((v) => typeof v === 'string' && v.length > 0)
    return typeof text === 'string' ? text : JSON.stringify(o).slice(0, 200)
  })
  return parts.filter(Boolean).join('\n').slice(0, 2000) || 'Workflow SOP 执行完成'
}

/**
 * 按执行实体类型回写结果状态：entityType='task' → 更新 Task；'subTask' → 更新执行子任务。
 * 修复：AI 员工执行子任务完成后 subTask 卡在 running（此前无条件 updateTask）。
 *
 * 主任务暂停待人工验收，不使用需求草稿 draft，也不绕过完成/DoD 校验。
 */
function writebackExecutionResult(
  execution: import('./project-types').AgentExecution,
  status: 'completed' | 'paused',
  summary: string,
  ts: number,
): void {
  if (execution.entityType === 'subTask') {
    return void updateExecutionSubTask(execution.entityId, {
      status: status as 'completed' | 'paused',
      completionNotes: summary,
      ...(status === 'completed' ? { completedAt: ts } : {}),
    }).catch(() => {
      console.warn(`[AgentEmployee] 回写子任务状态失败: ${execution.entityId}`)
    })
  }
  const current = store.getTask(execution.entityId)
  if (!current || parseAgentId(current.assignee?.userId) !== execution.agentId || !isExecutableAgentTask(current)) return
  // 任务 draft 是需求确认态，不是交付物草稿；暂停待验收，沿用现有完成/DoD 闸门。
  void updateTask(execution.entityId, {
    status: 'paused',
    completionNotes: status === 'completed' ? `【AI 交付待确认】${summary}` : summary,
  }, { source: 'system' }).catch((error: unknown) => {
    store.updateAgentExecution(execution.id, { error: `任务回写失败：${error instanceof Error ? error.message : String(error)}` })
  })
}

/** 执行完成回写 */
function handleExecutionComplete(executionId: string, messages: AgentMessage[] | undefined, startedAt: number, stoppedByUser = false): void {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status !== 'running') return
  if (stoppedByUser) {
    store.updateAgentExecution(executionId, { status: 'cancelled', completedAt: Date.now(), error: '用户已停止执行，未交付' })
    writebackExecutionResult(execution, 'paused', '【AI 执行已停止】用户停止，未交付', Date.now())
    recordActivity(store.getAgentExecution(executionId)!, 'agent_cancelled', '用户停止执行，未交付')
    recordLearningSample(execution, 'cancelled', '用户已停止执行；该样本默认待审查，不自动作为负向训练反馈。')
    return
  }
  if (!messages?.some((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim())) {
    handleExecutionError(executionId, '执行没有返回有效结果，不能标记为完成', startedAt)
    return
  }

  let summary = extractExecutionSummary(messages)
  const completedAt = Date.now()

  // elicitation 挂任务：agent 自述卡点 → 任务转 triage 组待人决策（仅主任务；子任务保持原语义）
  const blocker = execution.entityType === 'task' ? detectAgentBlocker(summary) : null
  if (blocker) {
    store.updateAgentExecution(executionId, {
      status: 'stale',
      resultSummary: summary,
      error: `Agent 报告卡点：${blocker}`,
      lastHeartbeatAt: completedAt,
      completedAt,
    })
    writebackExecutionResult(execution, 'paused', `【AI 卡点待决策】${blocker}——${summary.slice(0, 400)}`, completedAt)
    recordActivity(store.getAgentExecution(executionId)!, 'agent_blocked', `AI 员工报告卡点需人工决策：${blocker}`)
    void notifyAgentGuardrail(execution.projectId, execution.entityId, 'AI 执行卡点待决策', `卡点：${blocker}。说明：${summary.slice(0, 200)}`)
    return
  }

  if (store.getAgentEmployee(execution.agentId)?.executionProfile === 'development') {
    try {
      const meta = getAgentSessionMeta(execution.sessionId)
      const workspace = meta?.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
      if (!workspace?.rootPath) throw new Error('研发工作区已失效，不能确认交付目录')
      const evidence = captureDevelopmentEvidence(workspace.rootPath, getAgentSessionWorkspacePath(workspace.slug, execution.sessionId), executionId)
      summary = `${summary}\n\n${evidence.summary}`
      store.updateAgentExecution(executionId, { outputFiles: [...(execution.outputFiles ?? []), evidence.path] })
    } catch (error) {
      store.updateAgentExecution(executionId, { resultSummary: summary })
      handleExecutionError(executionId, error instanceof Error ? error.message : 'Git 证据采集失败', startedAt)
      return
    }
  }

  store.updateAgentExecution(executionId, {
    status: 'completed',
    resultSummary: summary,
    lastHeartbeatAt: completedAt,
    completedAt,
  })

  // 回写任务/子任务（按 entityType 区分，否则 subTask 会卡在 running）
  try {
    writebackExecutionResult(execution as import('./project-types').AgentExecution, 'completed', summary, completedAt)
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
  // 完成只产生待脱敏样本；业务验收仍以 project chain 的人工结果为准。
  recordLearningSample(execution, 'accepted', summary)
}

/** 执行失败回写（幂等：终态 failed/cancelled/stale 均拒绝重入，避免 onError 与 .catch 双路径重复回写） */
function handleExecutionError(executionId: string, error: string, startedAt: number): void {
  const execution = store.getAgentExecution(executionId)
  if (!execution || execution.status === 'completed' || execution.status === 'cancelled' || execution.status === 'failed' || execution.status === 'stale') return

  const failedAt = Date.now()
  store.updateAgentExecution(executionId, {
    status: 'failed',
    error: error.slice(0, 500),
    lastHeartbeatAt: failedAt,
    completedAt: failedAt,
  })

  // 任务/子任务回退 paused，保留上下文可重试
  try {
    writebackExecutionResult(execution as import('./project-types').AgentExecution, 'paused', `【AI 执行失败】${error.slice(0, 200)}`, failedAt)
  } catch (error_) {
    console.error('[AgentEmployee] 回写任务失败状态失败:', error_)
  }

  store.bumpAgentEmployeeStats(execution.agentId, { failed: true, durationMs: failedAt - startedAt })

  recordActivity(
    store.getAgentExecution(executionId)!,
    'agent_failed',
    `AI 员工执行任务失败：${error.slice(0, 120)}`,
  )
  recordLearningSample(execution, 'failed', `执行失败：${error.slice(0, 500)}`)
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
    void tryStartExecution(execution.id).catch((error: unknown) => handleExecutionError(execution.id, error instanceof Error ? error.message : '调度失败', now))
  }

  // 2. 探测 running 执行
  for (const execution of running.filter((e) => e.status === 'running')) {
    // Workflow 执行（sessionId=workflow:runId）不是 Agent 会话：不做 isActive 探测，仅超时检查
    if (execution.executor === 'workflow') {
      const duration = now - execution.startedAt
      if (duration > maxDurationMs) {
        store.updateAgentExecution(execution.id, {
          status: 'failed',
          error: `Workflow 执行超时（${Math.round(duration / 60_000)}min > ${Math.round(maxDurationMs / 60_000)}min）`,
          lastHeartbeatAt: now,
          completedAt: now,
        })
        writebackExecutionResult(execution, 'paused', '【AI 执行超时】Workflow 超时，请检查对应运行', now)
        recordActivity(store.getAgentExecution(execution.id)!, 'agent_timed_out', 'AI 员工 Workflow 执行超时')
      }
      continue
    }

    // 0. 任务级 token 配额：累计消耗超限即刹车（人 + agent 混跑时的成本护栏）
    const task = store.getTask(execution.entityId)
    if (task?.tokenBudget && task.tokenBudget > 0) {
      const used = getTaskTokenUsage(execution.sessionId)
      if (used > task.tokenBudget) {
        try { stopRegisteredAgent(execution.sessionId) } catch { /* 可能已结束 */ }
        store.updateAgentExecution(execution.id, {
          status: 'failed',
          error: `任务 token 配额超限（已用 ${used} > 预算 ${task.tokenBudget}）`,
          lastHeartbeatAt: now,
          completedAt: now,
        })
        writebackExecutionResult(execution, 'paused', `【AI 配额超限】已消耗 ${used} tokens（预算 ${task.tokenBudget}），执行已中止；可调高预算后重试`, now)
        recordActivity(store.getAgentExecution(execution.id)!, 'agent_budget_exceeded', `AI 员工 token 配额超限中止：${task.title}`)
        void notifyAgentGuardrail(execution.projectId, execution.entityId, 'AI 执行 token 配额超限', `已消耗 ${used} tokens（预算 ${task.tokenBudget}），执行已中止；可调高预算后重试。`)
        continue
      }
    }

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
    writebackExecutionResult(execution, 'paused', `【AI 执行${timedOut ? '超时' : '失联'}】请重试或人工介入`, now)
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
    async updateTodoStatus(taskId, _isCompleted) {
      // 任务被手动改状态 → 中止对应执行。
      // 注意：getAgentExecution 按执行记录主键 id(executionId) 查询，而这里的 taskId 是任务 id；
      // execution 通过 entityId=taskId 关联。按 entityId 取最近一条非终态执行，并回退兼容 executionId。
      const execution = getTaskExecutionByTaskId(taskId)
      if (execution && (execution.status === 'queued' || execution.status === 'running')) {
        // Workflow 执行（sessionId=workflow:<runId>）：真正取消背后的 Workflow Run；
        // stopRegisteredAgent 只能中止真实 Agent 会话，对 workflow 无效。
        const runMatch = /^workflow:(.+)$/.exec(execution.sessionId ?? '')
        if (runMatch) {
          const runId = runMatch[1]!
          const workflowId = store.getAgentEmployee(execution.agentId)?.workflowId
          if (workflowId) {
            try {
              cancelWorkflowRun(workflowId, runId)
            } catch (err) {
              console.warn('[AgentEmployee] 取消 Workflow Run 失败:', err)
            }
          }
        } else {
          try {
            stopRegisteredAgent(execution.sessionId)
          } catch {
            // 会话可能已结束
          }
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
      const execution = getTaskExecutionByTaskId(taskId)
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

/**
 * 按任务 id 取关联的最近一条执行记录（用于 updateTodoStatus/queryTodoStatus）。
 *
 * execution 通过 entityId=taskId 与任务关联，而其主键 id 是独立的 executionId；
 * 这里优先按 entityId 取最近一条（started_at DESC），并回退兼容按 executionId 查询
 * （兼容某些上层直接传入 executionId 的容错语义）。取最近一条非终态执行以反映任务当前真实进度的执行。
 */
function getTaskExecutionByTaskId(taskId: string): AgentExecution | null {
  const byEntity = store.listAgentExecutionsByEntity('task', taskId)
  if (byEntity.length > 0) {
    // 优先返回最近一条仍活跃（queued/running）的执行，否则返回最新一条
    return byEntity.find((e) => e.status === 'queued' || e.status === 'running') ?? byEntity[0]!
  }
  // 兼容按 executionId 直查
  return store.getAgentExecution(taskId)
}

/**
 * 审批通过/拒绝后的回写联动：Workflow 在等待审批时把 execution 置为 stale、task 置为 paused，
 * 之后审批在 Workflow 侧被 resolver，run 会推进到 completed/failed，但没有 hook 回写对应的
 * agent_execution 与 Task，导致任务永远悬挂在 paused/stale。
 * 此函数供 Workflow 审批/终态变化处调用，幂等：execution 非 stale（已被用户处理）则跳过。
 */
export function reconcileWorkflowApprovalRun(workflowId: string, runId: string): void {
  try {
    const run = getWorkflowRun(workflowId, runId)
    if (!run) return
    if (run.status !== 'completed' && run.status !== 'failed') return

    const execution = store.getAgentExecutionBySessionId(`workflow:${runId}`)
    // 只推进“等待审批”的 execution；已被取消/完成/其它状态的不打扰
    if (!execution || execution.status !== 'stale') return

    const now = Date.now()
    if (run.status === 'completed') {
      const summary = extractWorkflowSummary(run)
      store.updateAgentExecution(execution.id, {
        status: 'completed',
        resultSummary: summary,
        lastHeartbeatAt: now,
        completedAt: now,
      })
      try {
        // Workflow 执行通过后同样暂停主任务待验收
        writebackExecutionResult(execution, 'completed', summary, now)
      } catch { /* ignore */ }
      store.bumpAgentEmployeeStats(execution.agentId, { completed: true })
      recordActivity(store.getAgentExecution(execution.id)!, 'agent_completed', `AI 员工任务交付待确认（审批后）：${summary.slice(0, 80)}`)
    } else {
      const errMsg = '审批后 Workflow 执行失败'
      store.updateAgentExecution(execution.id, {
        status: 'failed',
        error: errMsg,
        lastHeartbeatAt: now,
        completedAt: now,
      })
      try {
        updateTask(execution.entityId, { status: 'paused', completionNotes: `【AI 执行失败】${errMsg}` })
      } catch { /* ignore */ }
      store.bumpAgentEmployeeStats(execution.agentId, { failed: true })
      recordActivity(store.getAgentExecution(execution.id)!, 'agent_failed', `AI 员工任务审批后失败：${errMsg}`)
    }
  } catch (err) {
    console.warn('[AgentEmployee] 审批后回写失败:', err)
  }
}
