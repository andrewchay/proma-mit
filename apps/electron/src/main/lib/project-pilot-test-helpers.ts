import { hashPilotGrantApproval } from './project-pilot-grant-issue'
import { getPilotPolicy, savePilotPolicyDraft } from './project-pilot-policy'
import { getProjectDb } from './project-sqlite-store'

interface PilotGrantFixtureInput {
  grantId: string
  projectId: string
  state?: 'active' | 'paused'
  workspaceId: string
  channelId: string
  modelId: string
  executorEmployeeId?: string
  reviewerEmployeeId?: string
  maxCostMicros: number
  maxRuns: number
  maxRework: number
  expiresAt: number
  createdAt: number
}

/** 测试专用：构造与 paused 策略草案完全一致的 grant，不绕过生产账本校验。 */
export function insertPilotGrantFixture(input: PilotGrantFixtureInput): void {
  const executorEmployeeId = input.executorEmployeeId ?? 'executor'
  const reviewerEmployeeId = input.reviewerEmployeeId ?? 'reviewer'
  const previous = getPilotPolicy(input.projectId)
  const policy = previous ?? savePilotPolicyDraft(input.projectId, {
    workspaceId: input.workspaceId,
    employeeIds: [executorEmployeeId, reviewerEmployeeId],
    executorEmployeeId,
    reviewerEmployeeId,
    channelId: input.channelId,
    modelId: input.modelId,
    maxCostMicros: input.maxCostMicros,
    maxRuns: input.maxRuns,
    maxRework: input.maxRework,
    expiresAt: input.expiresAt,
  }, null)
  if (policy.workspaceId !== input.workspaceId || policy.channelId !== input.channelId
    || policy.modelId !== input.modelId || policy.executorEmployeeId !== executorEmployeeId
    || policy.reviewerEmployeeId !== reviewerEmployeeId || policy.maxCostMicros !== input.maxCostMicros
    || policy.maxRuns !== input.maxRuns || policy.maxRework !== input.maxRework
    || policy.expiresAt !== input.expiresAt) throw new Error('Pilot 测试 grant 与现有策略不一致')
  getProjectDb().prepare(`INSERT INTO pilot_runtime_grants
    (id, project_id, policy_revision, state, workspace_id, channel_id, model_id,
     executor_employee_id, reviewer_employee_id, max_cost_micros, max_runs, max_rework,
     expires_at, approval_fingerprint, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    input.grantId, input.projectId, policy.revision, input.state ?? 'active', input.workspaceId,
    input.channelId, input.modelId, executorEmployeeId, reviewerEmployeeId, input.maxCostMicros,
    input.maxRuns, input.maxRework, input.expiresAt, hashPilotGrantApproval(policy), input.createdAt,
  )
}
