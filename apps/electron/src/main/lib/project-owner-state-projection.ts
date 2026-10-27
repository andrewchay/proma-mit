/**
 * Owner项目状态投影（阶段A/B最小切片）。
 *
 * 投影是从权威事实派生的可重建摘要，只用于判断“是否出现需要Owner重新判断的变化”。
 * 它不授予权限、不替代账本，也不据此跳过任何校验；阶段C才用它做增量语义调用。
 */
import { createHash } from 'node:crypto'
import { getProjectDb } from './project-sqlite-store'

export type OwnerStateDomain = 'goal' | 'plan' | 'authorization' | 'execution' | 'employee_interaction' | 'conversation'

export interface OwnerStateVector {
  goalRevision: number
  planRevision: number
  planState: string
  authorizationRevision: number
  authorizationState: string
  interactionRevision: number
  interactionPending: number
  conversationRevision: number
  pendingEvents: number
  executionSettled: number
}

export interface OwnerStateProjectionView {
  stateHash: string
  vector: OwnerStateVector
  dirtyDomains: OwnerStateDomain[]
  lastReconciledAt: number
}

interface ProjectionRow {
  state_hash: string
  vector_json: string
  dirty_domains_json: string
  last_reconciled_at: number
}
const domains: OwnerStateDomain[] = ['goal', 'plan', 'authorization', 'execution', 'employee_interaction', 'conversation']

function number(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 只读派生；任何查询失败都向上抛出，不静默当作“没有变化”。 */
export function buildOwnerStateVector(projectId: string): OwnerStateVector {
  const database = getProjectDb()
  const revision = database.prepare('SELECT MAX(revision) AS value FROM project_owner_revisions WHERE project_id = ?').get(projectId) as { value: number | null } | undefined
  const plan = database.prepare(`SELECT (SELECT MAX(revision) FROM project_owner_plan_revisions WHERE project_id = ?) AS revision,
      (SELECT json_extract(payload, '$.state') FROM project_owner_plan_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1) AS state`).get(projectId, projectId) as { revision: number | null; state: string | null } | undefined
  const delegation = database.prepare('SELECT COUNT(*) AS total, MAX(rowid) AS latest FROM project_owner_management_delegations WHERE project_id = ?').get(projectId) as { total: number; latest: number | null }
  const delegationRow = delegation.latest === null ? undefined : database.prepare('SELECT payload, revoked_at FROM project_owner_management_delegations WHERE rowid = ?').get(delegation.latest) as { payload: string; revoked_at: number | null }
  const authorizationState = delegationRow ? (delegationRow.revoked_at !== null ? 'revoked' : text((JSON.parse(delegationRow.payload) as { state?: unknown }).state)) : 'none'
  const interaction = database.prepare(`SELECT COUNT(*) AS total, MAX(revision) AS revision,
      SUM(CASE WHEN json_extract(payload, '$.state') IN ('pending_owner','discussing_user') THEN 1 ELSE 0 END) AS pending
    FROM project_owner_employee_interactions WHERE project_id = ?`).get(projectId) as { total: number; revision: number | null; pending: number | null }
  const conversation = database.prepare("SELECT COUNT(*) AS total FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.role') = 'user'").get(projectId) as { total: number }
  const pendingEvents = database.prepare('SELECT COUNT(*) AS total FROM project_owner_management_events WHERE project_id = ? AND consumed_at IS NULL').get(projectId) as { total: number }
  const settled = database.prepare("SELECT COUNT(*) AS total FROM agent_executions WHERE project_id = ? AND status IN ('completed','failed','cancelled','stale')").get(projectId) as { total: number }
  return {
    goalRevision: number(revision?.value), planRevision: number(plan?.revision), planState: text(plan?.state),
    authorizationRevision: number(delegation.total), authorizationState,
    interactionRevision: number(interaction.revision), interactionPending: number(interaction.pending),
    conversationRevision: number(conversation.total), pendingEvents: number(pendingEvents.total), executionSettled: number(settled.total),
  }
}

export function ownerStateHash(vector: OwnerStateVector): string {
  return createHash('sha256').update(JSON.stringify(vector)).digest('hex')
}

export function readOwnerStateProjection(projectId: string): OwnerStateProjectionView | null {
  const row = getProjectDb().prepare('SELECT state_hash, vector_json, dirty_domains_json, last_reconciled_at FROM project_owner_state_projections WHERE project_id = ?').get(projectId) as ProjectionRow | undefined
  if (!row) return null
  const vector = JSON.parse(row.vector_json) as OwnerStateVector
  if (ownerStateHash(vector) !== row.state_hash) throw new Error('Owner状态投影摘要不一致，请重建')
  const dirty = JSON.parse(row.dirty_domains_json) as unknown
  return { stateHash: row.state_hash, vector, dirtyDomains: Array.isArray(dirty) ? dirty.filter((item): item is OwnerStateDomain => domains.includes(item as OwnerStateDomain)) : [], lastReconciledAt: row.last_reconciled_at }
}

/** 按状态域比较向量，得出本次新增的脏域；无变化时不产生脏域。 */
export function diffOwnerStateDomains(previous: OwnerStateVector | null, current: OwnerStateVector): OwnerStateDomain[] {
  if (!previous) return []
  const changed = new Set<OwnerStateDomain>()
  if (previous.goalRevision !== current.goalRevision) changed.add('goal')
  if (previous.planRevision !== current.planRevision || previous.planState !== current.planState) changed.add('plan')
  if (previous.authorizationRevision !== current.authorizationRevision || previous.authorizationState !== current.authorizationState) changed.add('authorization')
  if (previous.executionSettled !== current.executionSettled) changed.add('execution')
  if (previous.interactionRevision !== current.interactionRevision || previous.interactionPending !== current.interactionPending) changed.add('employee_interaction')
  if (previous.conversationRevision !== current.conversationRevision || previous.pendingEvents !== current.pendingEvents) changed.add('conversation')
  return domains.filter(domain => changed.has(domain))
}

export interface OwnerStateReconcileResult { changed: boolean; dirtyDomains: OwnerStateDomain[]; stateHash: string }

/** 记录本次核对；只写投影，不改动任何权威事实或授权。 */
export function reconcileOwnerStateProjection(projectId: string, now = Date.now()): OwnerStateReconcileResult {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Owner状态投影时钟无效')
  const vector = buildOwnerStateVector(projectId)
  const stateHash = ownerStateHash(vector)
  const previous = readOwnerStateProjection(projectId)
  const dirtyDomains = previous?.stateHash === stateHash ? [] : diffOwnerStateDomains(previous?.vector ?? null, vector)
  const changed = previous?.stateHash !== stateHash
  getProjectDb().prepare(`INSERT INTO project_owner_state_projections(project_id, state_hash, vector_json, dirty_domains_json, last_reconciled_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET state_hash=excluded.state_hash, vector_json=excluded.vector_json,
      dirty_domains_json=excluded.dirty_domains_json, last_reconciled_at=excluded.last_reconciled_at, updated_at=excluded.updated_at`)
    .run(projectId, stateHash, JSON.stringify(vector), JSON.stringify(dirtyDomains), now, now)
  return { changed, dirtyDomains, stateHash }
}
