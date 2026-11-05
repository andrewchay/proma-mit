import { assertLocalActorEnabled } from './project-owner-plan-service'
import { requestOwnerAutonomousScheduleWake } from './project-owner-autonomous-scheduler-events'
import * as store from './project-sqlite-store'
import type { OwnerDispatchControl, OwnerDispatchControlEvent, ProjectOwnerGoalSubject } from '@gravitas/shared'

export function getOwnerDispatchControl(projectId: string, grantId: string): OwnerDispatchControl {
  assertLocalActorEnabled()
  const grant = store.getProjectDb().prepare("SELECT id FROM project_owner_execution_grants WHERE id=? AND project_id=? AND dispatch_mode='autonomous'").get(grantId, projectId)
  if (!grant) throw new Error('自主执行授权不存在或主体不匹配')
  return readOwnerDispatchControl(projectId, grantId)
}

export function listOwnerDispatchControlEvents(subject: ProjectOwnerGoalSubject): OwnerDispatchControlEvent[] {
  assertLocalActorEnabled()
  const rows = store.getProjectDb().prepare(`SELECT d.project_id,d.grant_id,d.paused,d.revision,d.created_at FROM project_owner_dispatch_control_events d
    JOIN project_owner_execution_grants g ON g.id=d.grant_id AND g.project_id=d.project_id
    WHERE d.project_id=? AND g.task_id IS ? AND d.actor='local-user' ORDER BY d.created_at,d.revision`).all(subject.projectId, subject.taskId ?? null) as Array<{ project_id: string; grant_id: string; paused: number; revision: number; created_at: number }>
  return rows.map(row => ({ projectId: row.project_id, grantId: row.grant_id, paused: row.paused === 1, revision: row.revision, createdAt: row.created_at }))
}

/** 授权保持不变；暂停仅阻止尚未认领的自主派工。 */
export function readOwnerDispatchControl(projectId: string, grantId: string): OwnerDispatchControl {
  const row = store.getProjectDb().prepare(`SELECT c.paused,c.revision,c.updated_at FROM project_owner_execution_grants g
    LEFT JOIN project_owner_dispatch_controls c ON c.project_id=g.project_id AND c.subject_key=COALESCE(g.task_id,'')
    WHERE g.project_id=? AND g.id=?`).get(projectId, grantId) as { paused: number | null; revision: number | null; updated_at: number | null } | undefined
  return { projectId, grantId, paused: row?.paused === 1, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null }
}

export function assertOwnerDispatchNotPaused(projectId: string, grantId: string): void {
  if (readOwnerDispatchControl(projectId, grantId).paused) throw new Error('用户已暂停后续自主派工；已运行的执行不会因此停止')
}

/** 已预留命令也必须受原项目管理授权约束，不能继承新授权。 */
export function assertOwnerDispatchManagementCurrent(projectId: string, grantId: string): void {
  const grant = store.getProjectDb().prepare('SELECT task_id, owner_management_delegation_id FROM project_owner_execution_grants WHERE project_id=? AND id=?').get(projectId, grantId) as { task_id: string | null; owner_management_delegation_id: string | null } | undefined
  if (!grant?.owner_management_delegation_id) throw new Error('自主执行未绑定可核验的项目管理授权')
  const management = (require('./project-owner-management-delegation') as typeof import('./project-owner-management-delegation')).getOwnerManagementDelegation(projectId, grant.task_id ?? undefined)
  if (management.delegation?.id !== grant.owner_management_delegation_id || !['active', 'exhausted'].includes(management.state)) throw new Error('原项目管理授权已变化或失效，不能继续派工')
}

export function setOwnerDispatchPaused(input: { projectId: string; grantId: string; expectedRevision: number; paused: boolean }): OwnerDispatchControl {
  assertLocalActorEnabled()
  if (!input || typeof input.projectId !== 'string' || !input.projectId.trim() || typeof input.grantId !== 'string' || !input.grantId.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.paused !== 'boolean') throw new Error('派工暂停请求无效')
  const db = store.getProjectDb()
  if (db.isTransactionActive()) throw new Error('派工控制不得嵌套未提交事务')
  let result: OwnerDispatchControl | undefined
  db.transaction(() => {
    const grant = db.prepare('SELECT state, dispatch_mode, expires_at, task_id FROM project_owner_execution_grants WHERE id=? AND project_id=?').get(input.grantId, input.projectId) as { state: string; dispatch_mode: string; expires_at: number; task_id: string | null } | undefined
    if (!grant || grant.dispatch_mode !== 'autonomous') throw new Error('自主执行授权不存在或主体不匹配')
    const latest = db.prepare('SELECT id FROM project_owner_execution_grants WHERE project_id=? AND task_id IS ? ORDER BY issued_at DESC, rowid DESC LIMIT 1').get(input.projectId, grant.task_id) as { id: string } | undefined
    if (latest?.id !== input.grantId) throw new Error('执行授权已更新，请重新读取')
    if (!input.paused && (grant.state !== 'active' || grant.expires_at <= Date.now())) throw new Error('执行授权已失效，不能恢复派工')
    if (!input.paused) assertOwnerDispatchManagementCurrent(input.projectId, input.grantId)
    const current = readOwnerDispatchControl(input.projectId, input.grantId)
    if (current.revision !== input.expectedRevision) throw new Error('派工控制状态已变化，请重新读取')
    if (current.paused === input.paused) { result = current; return }
    const updatedAt = Date.now(), revision = current.revision + 1
    const subjectKey = grant.task_id ?? ''
    db.prepare('INSERT INTO project_owner_dispatch_controls(project_id,subject_key,paused,revision,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,subject_key) DO UPDATE SET paused=excluded.paused,revision=excluded.revision,updated_at=excluded.updated_at').run(input.projectId, subjectKey, input.paused ? 1 : 0, revision, updatedAt)
    db.prepare('INSERT INTO project_owner_dispatch_control_events(project_id,subject_key,grant_id,revision,paused,actor,created_at) VALUES(?,?,?,?,?,?,?)').run(input.projectId, subjectKey, input.grantId, revision, input.paused ? 1 : 0, 'local-user', updatedAt)
    result = { projectId: input.projectId, grantId: input.grantId, paused: input.paused, revision, updatedAt }
  })()
  if (!result) throw new Error('派工控制未保存')
  if (!result.paused) requestOwnerAutonomousScheduleWake(input.projectId)
  return result
}
