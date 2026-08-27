/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 核心职责：
 * - 拦截 ExitPlanMode 工具调用
 * - 解析 allowedPrompts，发送到渲染进程展示审批 UI
 * - 等待用户选择（批准/拒绝/反馈），返回对应 PermissionResult
 * - 根据用户选择切换权限模式
 * - 支持 Plan → Goal 转换（新增）
 *
 * 复用 AskUserService 的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ExitPlanAllowedPrompt,
  PromaPermissionMode,
  PlanToGoalConversion,
} from '@gravitas/shared'
import { createGoal, bindSessionToGoal, upsertGoalTodo } from './goal-service'

/** ExitPlanMode 审批结果（扩展 SDK PermissionResult，附加 targetMode） */
export type ExitPlanPermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
  /** 用户选择的目标权限模式 */
  targetMode?: PromaPermissionMode
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 ExitPlanMode 请求 */
interface PendingExitPlan {
  resolve: (result: ExitPlanPermissionResult) => void
  request: ExitPlanModeRequest
  toolInput: Record<string, unknown>
}

/** ExitPlanMode 审批结果回调（通知编排层切换权限模式） */
export interface ExitPlanModeCallbacks {
  /** 切换权限模式 */
  onPermissionModeChange: (mode: PromaPermissionMode) => void
}

/**
 * Agent ExitPlanMode 计划审批服务
 *
 * 单例模式，管理所有会话的 ExitPlanMode 请求。
 */
export class AgentExitPlanService {
  /** 待处理的请求 Map（requestId → PendingExitPlan） */
  private pendingRequests = new Map<string, PendingExitPlan>()

  /**
   * 分析计划内容是否适合转换为 Goal
   *
   * 基于 allowedPrompts 和计划摘要判断：
   * - 适合：多步骤、长期性、需要跟踪的任务
   * - 不适合：单次性、即时完成的操作
   */
  analyzePlanForGoalConversion(request: ExitPlanModeRequest): PlanToGoalConversion {
    const { allowedPrompts, toolInput } = request
    const summary = (toolInput.summary as string) || ''

    // 判断标准：
    // 1. allowedPrompts 数量 >= 3（多步骤）
    // 2. 包含长期性关键词（track, monitor, implement, build, refactor）
    // 3. 不包含明显单次性关键词（quick, one-time, temporary）

    const longTermKeywords = ['track', 'monitor', 'implement', 'build', 'refactor', 'migrate', 'upgrade', 'optimize', 'setup', 'configure']
    const shortTermKeywords = ['quick', 'one-time', 'temporary', 'immediate', 'just once']

    const hasLongTerm = longTermKeywords.some(kw => summary.toLowerCase().includes(kw))
    const hasShortTerm = shortTermKeywords.some(kw => summary.toLowerCase().includes(kw))
    const isMultiStep = allowedPrompts.length >= 3

    // 如果明确是短期任务，不适合转换
    if (hasShortTerm && !hasLongTerm) {
      return {
        suitable: false,
        reason: '计划内容为短期/一次性操作，不适合作为长期 Goal 跟踪',
      }
    }

    // 多步骤或包含长期关键词，适合转换
    if (isMultiStep || hasLongTerm) {
      const suggestedObjective = summary || `执行计划：${allowedPrompts.map(p => p.prompt).join('、')}`
      const suggestedAcceptanceCriteria = allowedPrompts.map(p =>
        `完成操作：${p.tool} - ${p.prompt}`
      )

      return {
        suitable: true,
        reason: `计划包含 ${allowedPrompts.length} 个步骤，适合转换为长期跟踪的 Goal`,
        suggestedObjective,
        suggestedAcceptanceCriteria,
        suggestedStatus: 'active',
      }
    }

    // 默认：不适合
    return {
      suitable: false,
      reason: '计划步骤较少，作为单次执行更合适',
    }
  }

  /**
   * 执行 Plan → Goal 转换
   *
   * 创建 Goal，绑定会话，添加 todos
   */
  convertPlanToGoal(
    request: ExitPlanModeRequest,
    conversion: PlanToGoalConversion,
    bindSession: boolean,
  ): { goalId: string; bindSession: boolean } {
    if (!conversion.suitable || !conversion.suggestedObjective) {
      throw new Error('计划不适合转换为 Goal')
    }

    // 创建 Goal（使用 goal-service 的 createGoal）
    const goal = createGoal({
      title: conversion.suggestedObjective.slice(0, 100), // 取前100字符作为标题
      objective: conversion.suggestedObjective,
      scope: [],
    })

    // 添加 todos（从 allowedPrompts 生成）
    for (const prompt of request.allowedPrompts) {
      upsertGoalTodo(goal.id, {
        text: `${prompt.tool}: ${prompt.prompt}`,
        class: 'agent_work',
      })
    }

    // 绑定会话（如果需要）
    if (bindSession) {
      bindSessionToGoal(request.sessionId, goal.id)
    }

    return { goalId: goal.id, bindSession }
  }

  /**
   * 处理 ExitPlanMode 工具调用
   *
   * 解析 allowedPrompts，发送到渲染进程，阻塞等待用户选择。
   */
  handleExitPlanMode(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: ExitPlanModeRequest) => void,
  ): Promise<ExitPlanPermissionResult> {
    console.log(`[ExitPlanService] handleExitPlanMode 开始: sessionId=${sessionId}, signal.aborted=${signal.aborted}`)
    const allowedPrompts = this.parseAllowedPrompts(input)

    const request: ExitPlanModeRequest = {
      requestId: randomUUID(),
      sessionId,
      toolInput: input,
      allowedPrompts,
    }

    sendToRenderer(request)

    return new Promise<ExitPlanPermissionResult>((resolve) => {
      this.pendingRequests.set(request.requestId, { resolve, request, toolInput: input })

      signal.addEventListener('abort', () => {
        if (this.pendingRequests.has(request.requestId)) {
          console.warn(`[ExitPlanService] AbortSignal 触发，deny: requestId=${request.requestId}`)
          this.pendingRequests.delete(request.requestId)
          resolve({ behavior: 'deny', message: '操作已中止' })
        }
      }, { once: true })
    })
  }

  /**
   * 响应 ExitPlanMode 请求（由 IPC handler 调用）
   *
   * @returns { sessionId, targetMode } 用于通知编排层；未找到返回 null
   */
  respondToExitPlanMode(response: ExitPlanModeResponse): { sessionId: string; targetMode: PromaPermissionMode | null; goalId?: string } | null {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return null

    const sessionId = pending.request.sessionId
    this.pendingRequests.delete(response.requestId)

    switch (response.action) {
      case 'approve_auto': {
        // 批准 + 切换到完全自动模式
        pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'bypassPermissions',
        })
        return { sessionId, targetMode: 'bypassPermissions' }
      }
      case 'approve_edit': {
        // 批准 + 切换到自动审批模式
        pending.resolve({
          behavior: 'allow' as const,
          updatedInput: pending.toolInput,
          targetMode: 'auto',
        })
        return { sessionId, targetMode: 'auto' }
      }
      case 'approve_goal': {
        // 批准转换为 Goal 并执行
        try {
          const conversion = this.analyzePlanForGoalConversion(pending.request)
          if (!conversion.suitable) {
            pending.resolve({
              behavior: 'deny' as const,
              message: `计划不适合转换为 Goal：${conversion.reason}`,
            })
            return { sessionId, targetMode: null }
          }

          const result = this.convertPlanToGoal(pending.request, conversion, true)
          pending.resolve({
            behavior: 'allow' as const,
            updatedInput: pending.toolInput,
            targetMode: 'auto',
          })
          return { sessionId, targetMode: 'auto', goalId: result.goalId }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Goal 转换失败'
          pending.resolve({
            behavior: 'deny' as const,
            message,
          })
          return { sessionId, targetMode: null }
        }
      }
      case 'approve_goal_no_run': {
        // 批准转换为 Goal 但不执行
        try {
          const conversion = this.analyzePlanForGoalConversion(pending.request)
          if (!conversion.suitable) {
            pending.resolve({
              behavior: 'deny' as const,
              message: `计划不适合转换为 Goal：${conversion.reason}`,
            })
            return { sessionId, targetMode: null }
          }

          const result = this.convertPlanToGoal(pending.request, conversion, false)
          pending.resolve({
            behavior: 'deny' as const,
            message: `已创建 Goal (${result.goalId})，但不执行当前计划`,
          })
          return { sessionId, targetMode: null, goalId: result.goalId }
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Goal 转换失败'
          pending.resolve({
            behavior: 'deny' as const,
            message,
          })
          return { sessionId, targetMode: null }
        }
      }
      case 'deny': {
        // 拒绝计划
        pending.resolve({
          behavior: 'deny' as const,
          message: '用户拒绝了计划',
        })
        return { sessionId, targetMode: null }
      }
      case 'feedback': {
        // 用户提供反馈，拒绝并附带反馈内容
        pending.resolve({
          behavior: 'deny' as const,
          message: response.feedback ?? '用户要求修改计划',
        })
        return { sessionId, targetMode: null }
      }
      default: {
        pending.resolve({
          behavior: 'deny' as const,
          message: '未知操作',
        })
        return { sessionId, targetMode: null }
      }
    }
  }

  /**
   * 获取当前所有待处理的 ExitPlanMode 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): ExitPlanModeRequest[] {
    return [...this.pendingRequests.values()].map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 从工具输入中解析 allowedPrompts
   */
  private parseAllowedPrompts(input: Record<string, unknown>): ExitPlanAllowedPrompt[] {
    const raw = input.allowedPrompts
    if (!Array.isArray(raw)) return []

    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item): ExitPlanAllowedPrompt => ({
        tool: typeof item.tool === 'string' ? item.tool as 'Bash' : 'Bash',
        prompt: typeof item.prompt === 'string' ? item.prompt : '',
      }))
      .filter((item) => item.prompt.length > 0)
  }
}

/** 全局 ExitPlanMode 服务实例 */
export const exitPlanService = new AgentExitPlanService()
