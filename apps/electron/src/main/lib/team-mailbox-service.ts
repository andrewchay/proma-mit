/**
 * 团队收件箱服务 — Team Mailbox Service（PH2-C）
 *
 * 把「需要人类确认 / 需要被处理」的事项聚合为统一收件箱（mailbox），
 * 每条带成员归属，可打开会话处理。
 *
 * 来源（主进程各 pending 队列）：
 * - 权限请求（agent-permission-service.permissionService.getPendingRequests）
 * - 提问（agent-ask-user-service）
 * - 计划审批（agent-exit-plan-service）
 *
 * 设计：面向消费者收起散落的 pending 请求为一个 inbox，供 UI 统一展示/处理/流转。
 * 成员归属复用 PH1-C 的 resolveMemberForSession（agent 会话 → memberId）。
 */

import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { exitPlanService } from './agent-exit-plan-service'
import type { PermissionRequest, AskUserRequest } from '@gravitas/shared'

/** 收件箱条目 */
export interface MailboxItem {
  id: string
  kind: 'permission' | 'ask' | 'plan_review'
  sessionId: string
  memberId?: string
  /** 人类可读标题 */
  title: string
  /** 简要说明 */
  summary: string
  /** 原始请求 ID（处理时回传） */
  requestId: string
  at: number
}

/** 收件箱来源缓存（单例化查询，供 UI 轮询） */
let mailboxCache: MailboxItem[] = []
let mailboxCacheAt = 0

function resolveMember(sessionId: string): string | undefined {
  try {
    const { resolveMemberForSession } = require('./app-event-bus') as { resolveMemberForSession: (s: string) => string | undefined }
    return resolveMemberForSession(sessionId)
  } catch {
    return undefined
  }
}

/** 聚合所有待处理事项为统一收件箱。 */
export function listMailboxItems(): MailboxItem[] {
  const items: MailboxItem[] = []
  const at = Date.now()

  // 1) 权限请求
  for (const req of permissionService.getPendingRequests() as PermissionRequest[]) {
    items.push({
      id: `perm-${req.requestId}`,
      kind: 'permission',
      sessionId: req.sessionId,
      memberId: resolveMember(req.sessionId),
      title: '权限请求',
      summary: req.description || `${req.toolName} 需要授权`,
      requestId: req.requestId,
      at,
    })
  }

  // 2) AskUser 提问
  for (const req of askUserService.getPendingRequests() as AskUserRequest[]) {
    const q = req.questions?.[0]
    items.push({
      id: `ask-${req.requestId}`,
      kind: 'ask',
      sessionId: req.sessionId,
      memberId: resolveMember(req.sessionId),
      title: '需要回答',
      summary: q?.question ?? q?.header ?? '等待你的回答',
      requestId: req.requestId,
      at,
    })
  }

  // 3) 计划审批
  for (const req of exitPlanService.getPendingRequests() as ExitPlanModeRequestLoose[]) {
    items.push({
      id: `plan-${req.requestId}`,
      kind: 'plan_review',
      sessionId: req.sessionId,
      memberId: resolveMember(req.sessionId),
      title: '计划审批',
      summary: 'Agent 请求批准执行计划',
      requestId: req.requestId,
      at,
    })
  }

  mailboxCache = items
  mailboxCacheAt = at
  return items
}

type ExitPlanModeRequestLoose = { requestId: string; sessionId: string; planSummary?: string }

/** 读取缓存收件箱（避免高频重算；短 TTL）。 */
export function getMailboxCache(maxAgeMs = 1000): MailboxItem[] {
  if (Date.now() - mailboxCacheAt < maxAgeMs && mailboxCache.length > 0) return mailboxCache
  return listMailboxItems()
}

/** 统计待处理数量（收件箱徽标用）。 */
export function countMailboxPending(): number {
  return listMailboxItems().length
}
