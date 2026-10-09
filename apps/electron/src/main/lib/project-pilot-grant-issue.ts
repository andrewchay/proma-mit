import { assertNoOwnerExecutionPreparation } from './project-owner-execution-preparation-evidence'
import { createHash } from 'node:crypto'
import type { PilotGrantIssuePreview, PilotRuntimeGrant } from '@gravitas/shared'
import type { PilotPolicy } from './project-pilot-policy'
import { getPilotPolicy, withPilotPolicySnapshot } from './project-pilot-policy'
import { inspectPilotReadiness, type PilotReadiness } from './project-pilot-readiness'
import { getProjectDb } from './project-sqlite-store'

type ReadinessInspector = (projectId: string, now: number) => PilotReadiness

/** 指纹覆盖活动 grant 的全部权限边界；任何草案字段变化都会使旧确认失效。 */
export function hashPilotGrantApproval(policy: PilotPolicy): string {
  return createHash('sha256').update(JSON.stringify({
    version: policy.version,
    projectId: policy.projectId,
    policyRevision: policy.revision,
    workspaceId: policy.workspaceId,
    channelId: policy.channelId,
    modelId: policy.modelId,
    executorEmployeeId: policy.executorEmployeeId,
    reviewerEmployeeId: policy.reviewerEmployeeId,
    employeeIds: [...policy.employeeIds].sort(),
    maxCostMicros: policy.maxCostMicros,
    maxRuns: policy.maxRuns,
    maxRework: policy.maxRework,
    expiresAt: policy.expiresAt,
    ...(policy.ownerExecutionPreparation === undefined ? {} : { ownerExecutionPreparation: policy.ownerExecutionPreparation }),
    ...(policy.ownerExecutionRevalidation === undefined ? {} : { ownerExecutionRevalidation: policy.ownerExecutionRevalidation }),
  })).digest('hex')
}

function previewFromPolicy(policy: PilotPolicy, readiness: PilotReadiness, now: number): PilotGrantIssuePreview {
  assertNoOwnerExecutionPreparation(policy.projectId, policy.ownerExecutionPreparation)
  if (policy.state !== 'paused') throw new Error('Pilot 策略草案状态无效')
  if (policy.expiresAt <= now) throw new Error('Pilot 策略草案已过期')
  if (!policy.executorEmployeeId || !policy.reviewerEmployeeId) throw new Error('Pilot 执行与评审职责未完整绑定')
  if (!readiness.bindingsValid || readiness.policyRevision !== policy.revision) {
    throw new Error(`Pilot 发行预检未通过：${readiness.blockers.join('；') || '策略版本不一致'}`)
  }
  return {
    projectId: policy.projectId,
    policyRevision: policy.revision,
    workspaceId: policy.workspaceId,
    channelId: policy.channelId,
    modelId: policy.modelId,
    executorEmployeeId: policy.executorEmployeeId,
    reviewerEmployeeId: policy.reviewerEmployeeId,
    maxCostMicros: policy.maxCostMicros,
    maxRuns: policy.maxRuns,
    maxRework: policy.maxRework,
    expiresAt: policy.expiresAt,
    approvalFingerprint: hashPilotGrantApproval(policy),
  }
}

/** 只读发行预览；调用方必须把确认指纹原样交回确认入口。 */
export function previewPilotGrantIssue(
  projectId: string,
  expectedPolicyRevision: number,
  now = Date.now(),
  inspectReadiness: ReadinessInspector = inspectPilotReadiness,
): PilotGrantIssuePreview {
  const policy = getPilotPolicy(projectId)
  if (!policy || policy.revision !== expectedPolicyRevision) throw new Error('Pilot 授权版本已变化')
  return previewFromPolicy(policy, inspectReadiness(projectId, now), now)
}

function rowToGrant(row: {
  id: string; project_id: string; policy_revision: number; state: 'active' | 'paused'; workspace_id: string;
  channel_id: string; model_id: string; executor_employee_id: string; reviewer_employee_id: string;
  max_cost_micros: number; max_runs: number; max_rework: number; expires_at: number;
  approval_fingerprint: string | null; created_at: number;
}): PilotRuntimeGrant {
  return {
    grantId: row.id, projectId: row.project_id, policyRevision: row.policy_revision, state: row.state,
    workspaceId: row.workspace_id, channelId: row.channel_id, modelId: row.model_id,
    executorEmployeeId: row.executor_employee_id, reviewerEmployeeId: row.reviewer_employee_id,
    maxCostMicros: row.max_cost_micros, maxRuns: row.max_runs, maxRework: row.max_rework,
    expiresAt: row.expires_at, approvalFingerprint: row.approval_fingerprint, createdAt: row.created_at,
  }
}

/** 只读返回项目当前活动授权；损坏记录会在后续预览/确认中拒绝。 */
export function getActivePilotGrant(projectId: string): PilotRuntimeGrant | null {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('缺少项目 ID')
  const row = getProjectDb().prepare("SELECT * FROM pilot_runtime_grants WHERE project_id = ? AND state = 'active'")
    .get(projectId) as Parameters<typeof rowToGrant>[0] | undefined
  return row ? rowToGrant(row) : null
}

function grantMatchesPreview(grant: PilotRuntimeGrant, preview: PilotGrantIssuePreview): boolean {
  return grant.projectId === preview.projectId && grant.policyRevision === preview.policyRevision
    && grant.workspaceId === preview.workspaceId && grant.channelId === preview.channelId
    && grant.modelId === preview.modelId && grant.executorEmployeeId === preview.executorEmployeeId
    && grant.reviewerEmployeeId === preview.reviewerEmployeeId
    && grant.maxCostMicros === preview.maxCostMicros && grant.maxRuns === preview.maxRuns
    && grant.maxRework === preview.maxRework && grant.expiresAt === preview.expiresAt
    && grant.approvalFingerprint === preview.approvalFingerprint
}

export function pilotGrantMatchesPolicy(grant: PilotRuntimeGrant, policy: PilotPolicy): boolean {
  if (policy.ownerExecutionPreparation !== undefined) return false
  try { assertNoOwnerExecutionPreparation(policy.projectId) } catch { return false }
  if (!policy.executorEmployeeId || !policy.reviewerEmployeeId) return false
  return grantMatchesPreview(grant, {
    projectId: policy.projectId,
    policyRevision: policy.revision,
    workspaceId: policy.workspaceId,
    channelId: policy.channelId,
    modelId: policy.modelId,
    executorEmployeeId: policy.executorEmployeeId,
    reviewerEmployeeId: policy.reviewerEmployeeId,
    maxCostMicros: policy.maxCostMicros,
    maxRuns: policy.maxRuns,
    maxRework: policy.maxRework,
    expiresAt: policy.expiresAt,
    approvalFingerprint: hashPilotGrantApproval(policy),
  })
}

/** 确认后仅发行活动授权记录；不会创建命令、执行或调用模型。 */
export function confirmPilotGrantIssue(
  preview: PilotGrantIssuePreview,
  confirmedFingerprint: string,
  now = Date.now(),
  inspectReadiness: ReadinessInspector = inspectPilotReadiness,
): PilotRuntimeGrant {
  if (!/^[a-f0-9]{64}$/.test(confirmedFingerprint) || preview.approvalFingerprint !== confirmedFingerprint) {
    throw new Error('Pilot 发行确认指纹无效')
  }
  return withPilotPolicySnapshot(preview.projectId, preview.policyRevision, (policy) => {
    const current = previewFromPolicy(policy, inspectReadiness(preview.projectId, now), now)
    if (current.approvalFingerprint !== confirmedFingerprint
      || JSON.stringify(current) !== JSON.stringify(preview)) throw new Error('Pilot 发行影响面已变化，请重新确认')
    const database = getProjectDb()
    let result: PilotRuntimeGrant | undefined
    database.transaction(() => {
      const unresolvedStop = database.prepare(`SELECT 1 FROM pilot_stop_escalations
        WHERE project_id = ? AND resolved_at IS NULL LIMIT 1`).get(preview.projectId)
      if (unresolvedStop) throw new Error('Pilot 停止升级待人工对账，拒绝发行新授权')
      const active = database.prepare("SELECT * FROM pilot_runtime_grants WHERE project_id = ? AND state = 'active'")
        .get(preview.projectId) as Parameters<typeof rowToGrant>[0] | undefined
      if (active) {
        const existing = rowToGrant(active)
        if (!grantMatchesPreview(existing, preview)) throw new Error('项目活动 Pilot 授权与确认内容不一致，须先对账并暂停')
        result = existing
        return
      }
      const grantId = `pilot-grant-${confirmedFingerprint.slice(0, 32)}`
      database.prepare(`INSERT INTO pilot_runtime_grants
        (id, project_id, policy_revision, state, workspace_id, channel_id, model_id,
         executor_employee_id, reviewer_employee_id, max_cost_micros, max_runs, max_rework,
         expires_at, approval_fingerprint, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        grantId, preview.projectId, preview.policyRevision, preview.workspaceId, preview.channelId,
        preview.modelId, preview.executorEmployeeId, preview.reviewerEmployeeId, preview.maxCostMicros,
        preview.maxRuns, preview.maxRework, preview.expiresAt, confirmedFingerprint, now,
      )
      const row = database.prepare('SELECT * FROM pilot_runtime_grants WHERE id = ?').get(grantId) as Parameters<typeof rowToGrant>[0]
      result = rowToGrant(row)
    })()
    if (!result) throw new Error('Pilot 活动授权发行未完成')
    return result
  })
}
