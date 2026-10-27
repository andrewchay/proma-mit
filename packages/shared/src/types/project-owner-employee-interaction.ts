import type { AskUserQuestion } from './agent'

/** 员工交互记录不是权限凭据；决定必须经原请求入口重新核验后投递。 */
export interface OwnerEmployeeInteraction {
  schemaVersion: 1
  id: string
  projectId: string
  taskId: string
  employeeId: string
  executionId: string
  sessionId: string
  commandId: string
  requestId: string
  kind: 'question' | 'permission'
  requestHash: string
  questions: AskUserQuestion[]
  summary: string
  revision: number
  state: 'pending_owner' | 'discussing_user' | 'decided' | 'delivering' | 'resolved' | 'cancelled' | 'stale' | 'delivery_failed'
  decision?: OwnerEmployeeInteractionDecision
  createdAt: number
  /** 等待截止；缺失的旧记录按 createdAt 推算，不允许无限等待。 */
  expiresAt?: number
  updatedAt: number
}

export interface OwnerEmployeeInteractionDecision {
  source: 'owner' | 'user'
  sourceMessageId: string
  action: 'answer' | 'deny'
  answers?: Record<string, string>
  reason: string
}
