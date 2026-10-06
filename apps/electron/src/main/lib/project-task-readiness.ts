/**
 * project-task-readiness — AI 任务的统一前置检查（R-P0-08）
 *
 * 职责：把散落在 development-task-service / development-delivery-service /
 * project-chain 中的工作区、范围、决策、验收人和执行状态检查，汇总为一份
 * 只读、用户可读的 readiness 结果；renderer 只做解释，主进程各门禁仍是最终权威。
 *
 * 边界：本模块不授权、不派发、不写库；phase 只描述当前事实，不预测执行结果。
 */
import type { AgentWorkspace, ProjectChain } from '@gravitas/shared'
import type { Task } from './project-types'

export type { ProjectTaskReadinessPhase, ProjectTaskReadinessBlocker, ProjectTaskReadiness } from '@gravitas/shared'
import type { ProjectTaskReadiness, ProjectTaskReadinessBlocker, ProjectTaskReadinessPhase } from '@gravitas/shared'

export interface TaskExecutionFacts {
  id: string
  status: string
  sessionId?: string
}

export interface TaskReadinessWorld {
  getWorkspace(id: string): AgentWorkspace | undefined
  getChain(projectId: string): Pick<ProjectChain, 'decisions'>
  listExecutions(taskId: string): TaskExecutionFacts[]
  /** 可选：员工启用状态；缺省视为已启用 */
  isEmployeeEnabled?(employeeId: string): boolean
}

function blocker(code: string, message: string): ProjectTaskReadinessBlocker {
  return { code, message }
}

/** 汇总单个 AI 任务的推进前置；普通任务（无 AI 负责人）返回 ready 并附带说明 */
export function inspectTaskReadiness(task: Task, world: TaskReadinessWorld): ProjectTaskReadiness {
  const blockers: ProjectTaskReadinessBlocker[] = []
  const diagnostics: string[] = []
  const isAgentTask = Boolean(task.assignee?.userId?.startsWith('agent-'))

  if (task.status === 'cancelled') {
    return { taskId: task.id, phase: 'closed', blockers: [blocker('TASK_CANCELLED', '任务已取消，不能继续推进。如需重做请新建任务。')], diagnostics: [] }
  }
  if (task.status === 'completed') {
    return { taskId: task.id, phase: 'completed', blockers: [], diagnostics: ['任务已标记完成；业务验收以交付链记录为准。'] }
  }

  const executions = world.listExecutions(task.id)
  if (executions.some((item) => item.status === 'running')) {
    diagnostics.push('存在进行中的执行。')
  }

  // 普通（非 AI）任务：只做执行状态说明
  if (!isAgentTask) {
    if (executions.some((item) => item.status === 'running')) {
      return { taskId: task.id, phase: 'running', blockers: [], diagnostics }
    }
    return { taskId: task.id, phase: 'ready', blockers: [], diagnostics: ['普通任务：由负责人直接推进，无需研发执行范围。', ...diagnostics] }
  }

  // AI 任务：必须有完整研发执行范围
  if (!task.developmentScope) {
    blockers.push(blocker(
      'MISSING_DEVELOPMENT_SCOPE',
      '该任务指派了 AI 员工，但没有配置执行范围（工作区/目标文件），完成后不会进入交付与评审。请使用「交给 AI 完成」重新创建，或为该任务补齐研发范围。',
    ))
  } else {
    const scope = task.developmentScope
    const workspace = world.getWorkspace(scope.workspaceId)
    if (!workspace?.rootPath) {
      blockers.push(blocker('WORKSPACE_INVALID', `执行工作区无效或未绑定本地 Git 仓库（${scope.workspaceId}）。请在工作区配置中修正后重试。`))
    }
    const chain = world.getChain(task.projectId)
    for (const decisionId of scope.decisionIds ?? []) {
      const decision = chain.decisions.find((item) => item.id === decisionId)
      if (!decision) {
        blockers.push(blocker('DECISION_MISSING', `关联的决策 ${decisionId} 不存在，可能已被删除；请重新选择已拍板决策。`))
      } else if (decision.status !== 'decided') {
        blockers.push(blocker('DECISION_NOT_DECIDED', `关联的决策「${decision.title}」还是待拍板状态；请先到「治理与交付详情」完成拍板，任务才能派发。`))
      }
    }
    if (!scope.reviewerId) {
      blockers.push(blocker('MISSING_REVIEWER', '缺少人工验收人；交付提交后无法进入人工验收。'))
    }
    const employeeId = task.assignee!.userId.replace(/^agent-/, '')
    if (world.isEmployeeEnabled && !world.isEmployeeEnabled(employeeId)) {
      blockers.push(blocker('EMPLOYEE_DISABLED', `研发员工 ${employeeId} 已停用；请改派或重新启用后再派发。`))
    }
    diagnostics.push(`执行范围：工作区 ${scope.workspaceId}；目标 ${JSON.stringify(scope.targetPaths)}。`)
  }

  if (executions.some((item) => item.status === 'running')) {
    return { taskId: task.id, phase: 'running', blockers, diagnostics }
  }
  if (executions.some((item) => item.status === 'completed')) {
    diagnostics.push('存在已完成的执行；请在任务详情核对交付版本。')
    if (blockers.length === 0) {
      return { taskId: task.id, phase: 'awaiting_review', blockers: [], diagnostics }
    }
  }
  if (executions.some((item) => item.status === 'failed' || item.status === 'stale')) {
    blockers.push(blocker('PRIOR_EXECUTION_FAILED', '存在失败或状态不明的历史执行；请查看任务详情的处理建议，不要盲目重试。'))
  }

  return {
    taskId: task.id,
    phase: blockers.length > 0 ? 'blocked' : 'ready',
    blockers,
    diagnostics,
  }
}
