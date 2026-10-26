/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 核心职责：
 * - 拦截 AskUserQuestion 工具调用
 * - 解析问题列表，发送到渲染进程展示交互 UI
 * - 等待用户回答，通过 updatedInput 注入 answers 字段
 * - 管理 pending 请求生命周期
 *
 * 复用权限系统的 Promise + Map 异步等待模式。
 */

import { randomUUID } from 'node:crypto'
import type {
  AskUserRequest,
  AskUserQuestion,
  AskUserQuestionOption,
} from '@gravitas/shared'

/** canUseTool 返回的权限结果 */
type PermissionResult = {
  behavior: 'allow'
  updatedInput: Record<string, unknown>
} | {
  behavior: 'deny'
  message: string
}

/** 待处理的 AskUser 请求 */
interface PendingAskUser {
  resolve: (result: PermissionResult) => void
  request: AskUserRequest
  ownerManaged?: boolean
}

/**
 * Agent AskUserQuestion 交互式问答服务
 *
 * 单例模式，管理所有会话的 AskUser 请求。
 */
export interface AskUserRequestRouter {
  /** 返回 true 表示已由项目Owner接管，不向员工会话发问。 */
  route: (request: AskUserRequest) => boolean
  cancel: (requestId: string) => void
}

export class AgentAskUserService {
  constructor(private readonly router?: AskUserRequestRouter) {}
  /** 待处理的 AskUser 请求 Map（requestId → PendingAskUser） */
  private pendingRequests = new Map<string, PendingAskUser>()

  /**
   * 处理 AskUserQuestion 工具调用
   *
   * 解析问题列表，发送到渲染进程，阻塞等待用户回答，
   * 回答后通过 updatedInput 注入 answers 字段。
   */
  handleAskUserQuestion(
    sessionId: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    sendToRenderer: (request: AskUserRequest) => void,
  ): Promise<PermissionResult> {
    const questions = this.parseQuestions(input)

    const request: AskUserRequest = {
      requestId: randomUUID(),
      sessionId,
      kind: input.interactionType === 'computer_use_takeover' ? 'computer_use_takeover' : 'question',
      questions,
      toolInput: input,
    }

    return new Promise<PermissionResult>((resolve) => {
      const cancel = () => {
        if (!this.pendingRequests.delete(request.requestId)) return
        try { this.router?.cancel(request.requestId) } finally { finish({ behavior: 'deny', message: '操作已中止' }) }
      }
      const finish = (result: PermissionResult) => {
        signal.removeEventListener('abort', cancel)
        resolve(result)
      }
      this.pendingRequests.set(request.requestId, { resolve: finish, request })
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { cancel(); return }
      try {
        if (this.router?.route(request)) {
          const pending = this.pendingRequests.get(request.requestId)
          if (pending) pending.ownerManaged = true
        } else sendToRenderer(request)
      } catch (error) {
        try { this.router?.cancel(request.requestId) } catch { /* 路由失败仍须结束原Promise，不能绕过安全拒绝。 */ }
        this.pendingRequests.delete(request.requestId)
        finish({ behavior: 'deny', message: error instanceof Error ? error.message : '问题转交失败，未放行员工' })
      }
    })
  }

  /**
   * 响应 AskUser 请求（由 IPC handler 调用）
   *
   * @returns 对应的 sessionId，用于向渲染进程发送 resolved 事件；未找到返回 null
   */
  respondToAskUser(requestId: string, answers: Record<string, string>): string | null {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || pending.ownerManaged) return null

    const sessionId = pending.request.sessionId

    // 构建 updatedInput：保留原始输入 + 注入 answers
    const updatedInput: Record<string, unknown> = {
      ...pending.request.toolInput,
      answers,
    }

    pending.resolve({
      behavior: 'allow' as const,
      updatedInput,
    })
    this.pendingRequests.delete(requestId)
    return sessionId
  }

  /** 只检查原内存等待是否仍在；不恢复或创建新的员工会话。 */
  hasOwnerPendingRequest(requestId: string, sessionId: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    return pending?.ownerManaged === true && pending.request.sessionId === sessionId
  }

  /** 仅供Owner权威回流入口使用；普通IPC不可声明自己是Owner。 */
  respondToOwnerAskUser(requestId: string, sessionId: string, answers: Record<string, string> | null, reason: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || !pending.ownerManaged || pending.request.sessionId !== sessionId) return false
    this.pendingRequests.delete(requestId)
    pending.resolve(answers ? { behavior: 'allow', updatedInput: { ...pending.request.toolInput, answers } } : { behavior: 'deny', message: reason })
    return true
  }

  /** 等待到期：明确拒绝原员工等待，不放行工具，也不代表Provider已停止。 */
  expireOwnerAskUser(requestId: string, sessionId: string, reason: string): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (!pending || !pending.ownerManaged || pending.request.sessionId !== sessionId) return false
    this.pendingRequests.delete(requestId)
    pending.resolve({ behavior: 'deny', message: reason })
    return true
  }

  /**
   * 获取当前所有待处理的 AskUser 请求（用于渲染进程重载后恢复状态）
   */
  getPendingRequests(): AskUserRequest[] {
    return [...this.pendingRequests.values()].filter(p => !p.ownerManaged).map((p) => p.request)
  }

  /**
   * 清除指定会话的所有待处理 AskUser 请求
   */
  clearSessionPending(sessionId: string): void {
    for (const [requestId, pending] of this.pendingRequests) {
      if (pending.request.sessionId === sessionId) {
        this.router?.cancel(requestId)
        pending.resolve({ behavior: 'deny', message: '会话已结束' })
        this.pendingRequests.delete(requestId)
      }
    }
  }

  /**
   * 从工具输入中解析问题列表
   *
   * SDK AskUserQuestion 工具输入格式：
   * { questions: [{ question, header, options: [{ label, description, preview }], multiSelect }] }
   */
  private parseQuestions(input: Record<string, unknown>): AskUserQuestion[] {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions)) return []

    return rawQuestions.map((q: unknown): AskUserQuestion => {
      const raw = q as Record<string, unknown>
      const options = Array.isArray(raw.options)
        ? (raw.options as Array<Record<string, unknown>>).map((o): AskUserQuestionOption => ({
            label: typeof o.label === 'string' ? o.label : '',
            description: typeof o.description === 'string' ? o.description : undefined,
            preview: typeof o.preview === 'string' ? o.preview.slice(0, 10_000) : undefined,
          }))
        : []

      return {
        question: typeof raw.question === 'string' ? raw.question : '',
        header: typeof raw.header === 'string' ? raw.header : undefined,
        options,
        multiSelect: raw.multiSelect === true,
      }
    })
  }
}

/** 全局 AskUser 服务实例 */
export const askUserService = new AgentAskUserService({
  route: request => (require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).routeOwnerEmployeeAskUser({ sessionId: request.sessionId, requestId: request.requestId, kind: request.kind === 'question' ? 'question' : 'permission', toolInput: request.toolInput, questions: request.questions }),
  cancel: requestId => (require('./project-owner-employee-interactions') as typeof import('./project-owner-employee-interactions')).cancelOwnerEmployeeInteraction(requestId),
})
