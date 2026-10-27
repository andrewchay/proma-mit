import { createHash } from 'node:crypto'
import type { PermissionRequest } from '@gravitas/shared'
import { requestOwnerManagementChanged } from './project-owner-management-events'
import { getProjectDb } from './project-sqlite-store'

export interface OwnerActionApprovalIdentity {
  commandId: string
  executionId: string
  sessionId: string
}

interface LiveOwnerActionRow {
  project_id: string
  command_id: string
  execution_id: string
  session_id: string
  command_state: string
  execution_status: string
  grant_state: string
  expires_at: number
}

function readLiveOwnerAction(identity: OwnerActionApprovalIdentity, database = getProjectDb()): LiveOwnerActionRow | undefined {
  return database.prepare(`
    SELECT c.project_id, c.id AS command_id, c.execution_id, e.session_id,
      c.state AS command_state, e.status AS execution_status, g.state AS grant_state, g.expires_at
    FROM project_owner_execution_commands c
    JOIN agent_executions e ON e.id=c.execution_id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE c.id=? AND c.execution_id=? AND e.session_id=?
  `).get(identity.commandId, identity.executionId, identity.sessionId) as LiveOwnerActionRow | undefined
}

export function assertLiveOwnerAction(identity: OwnerActionApprovalIdentity, database = getProjectDb()): LiveOwnerActionRow {
  const row = readLiveOwnerAction(identity, database)
  if (!row || row.command_state !== 'running' || row.execution_status !== 'running'
    || row.grant_state !== 'active' || row.expires_at <= Date.now()) {
    throw new Error('Owner动作审批来源已失效')
  }
  return row
}

/** 不返回工具参数，不恢复丢失的Promise；前端必须再与实时权限队列按请求身份相交。 */
export function listOwnerPendingActionRequests(projectId: string): Array<{ requestId: string; sessionId: string; taskId: string }> {
  return getProjectDb().prepare(`SELECT a.request_id AS requestId, a.session_id AS sessionId, e.entity_id AS taskId
    FROM project_owner_action_approvals a
    JOIN project_owner_execution_commands c ON c.id=a.command_id AND c.project_id=a.project_id AND c.execution_id=a.execution_id
    JOIN agent_executions e ON e.id=a.execution_id AND e.project_id=a.project_id AND e.session_id=a.session_id AND e.owner_command_id=c.id
    JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id
    WHERE a.project_id=? AND a.status='pending' AND c.state='running' AND e.status='running'
      AND g.state='active' AND g.expires_at>? ORDER BY a.requested_at, a.request_id`).all(projectId, Date.now()) as Array<{ requestId: string; sessionId: string; taskId: string }>
}

function fingerprint(request: Pick<PermissionRequest, 'toolName' | 'toolInput'>): string {
  const canonical = JSON.stringify({ toolName: request.toolName, toolInput: request.toolInput })
  if (canonical.length > 2_000_000) throw new Error('Owner动作参数超过审批审计上限')
  return createHash('sha256').update(canonical).digest('hex')
}

/** 持久化用户看到的精确Owner动作摘要指纹；动作参数正文不落库。 */
export function recordOwnerActionApprovalRequest(identity: OwnerActionApprovalIdentity, request: PermissionRequest): void {
  const database = getProjectDb()
  const projectId = assertLiveOwnerAction(identity, database).project_id
  database.transaction(() => {
    const live = assertLiveOwnerAction(identity, database)
    database.prepare(`INSERT INTO project_owner_action_approvals
      (request_id, project_id, command_id, execution_id, session_id, tool_name, action_fingerprint, status, requested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(request.requestId, live.project_id, identity.commandId, identity.executionId, identity.sessionId,
        request.toolName, fingerprint(request), Date.now())
  })()
  requestOwnerManagementChanged({ projectId }, () => listOwnerPendingActionRequests(projectId).some(item => item.requestId === request.requestId))
}

/** 裁决仅接受未决请求且仍有效的同一Owner执行；拒绝不调用工具。 */
export function decideOwnerActionApproval(request: PermissionRequest, behavior: 'allow' | 'deny', identity: OwnerActionApprovalIdentity): void {
  const database = getProjectDb()
  let sourceIsValid = false
  database.transaction(() => {
    const current = database.prepare('SELECT * FROM project_owner_action_approvals WHERE request_id=?').get(request.requestId) as { status: string; action_fingerprint: string; command_id: string; execution_id: string; session_id: string } | undefined
    if (!current || current.status !== 'pending' || current.command_id !== identity.commandId
      || current.execution_id !== identity.executionId || current.session_id !== identity.sessionId
      || current.action_fingerprint !== fingerprint(request)) throw new Error('Owner动作审批记录不匹配或已处理')

    const live = readLiveOwnerAction(identity, database)
    const isValid = live?.command_state === 'running' && live.execution_status === 'running'
      && live.grant_state === 'active' && live.expires_at > Date.now()
    sourceIsValid = isValid
    const nextStatus = isValid ? (behavior === 'allow' ? 'allowed' : 'denied') : 'invalidated'
    const reason = isValid ? (behavior === 'deny' ? 'user_rejected' : null) : 'source_changed'
    const changed = database.prepare(`UPDATE project_owner_action_approvals
      SET status=?, decided_at=?, decided_by='local-user', decision_reason=?
      WHERE request_id=? AND status='pending' AND action_fingerprint=?`)
      .run(nextStatus, Date.now(), reason, request.requestId, current.action_fingerprint)
    if (changed.changes !== 1) throw new Error('Owner动作审批状态已变化')
  })()
  if (!sourceIsValid) throw new Error('Owner动作审批来源已失效，操作未执行')
}

export function invalidateOwnerActionApproval(requestId: string): void {
  getProjectDb().prepare(`UPDATE project_owner_action_approvals
    SET status='invalidated', decided_at=?, decision_reason='request_ended'
    WHERE request_id=? AND status='pending'`).run(Date.now(), requestId)
}

/** 工具执行前按会话、工具名和完整参数匹配已批准动作；审批记录失效或参数变化时拒绝。 */
export function hasApprovedOwnerAction(sessionId: string, request: Pick<PermissionRequest, 'toolName' | 'toolInput'>): boolean {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT request_id, command_id, execution_id, session_id, action_fingerprint
    FROM project_owner_action_approvals
    WHERE session_id=? AND tool_name=? AND status='allowed' AND decided_at IS NOT NULL
    ORDER BY decided_at DESC LIMIT 32`).all(sessionId, request.toolName) as Array<{
      request_id: string; command_id: string; execution_id: string; session_id: string; action_fingerprint: string
    }>
  const expectedFingerprint = fingerprint(request)
  return rows.some(row => {
    if (row.action_fingerprint !== expectedFingerprint) return false
    try {
      assertLiveOwnerAction({ commandId: row.command_id, executionId: row.execution_id, sessionId: row.session_id }, database)
      return true
    } catch {
      return false
    }
  })
}
