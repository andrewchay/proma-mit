import type { PilotControlSnapshot } from '@gravitas/shared'
import { getPilotGrantBudgetUsageView } from './project-pilot-budget-ledger'
import { getActivePilotGrant, pilotGrantMatchesPolicy } from './project-pilot-grant-issue'
import { getPilotPolicy } from './project-pilot-policy'
import { inspectPilotReadiness } from './project-pilot-readiness'

/** 项目经理控制面只读快照；不发行授权、不修改策略，也不触发模型。 */
export function getPilotControlSnapshot(projectId: string, now = Date.now()): PilotControlSnapshot {
  const policy = getPilotPolicy(projectId)
  const readiness = inspectPilotReadiness(projectId, now)
  const activeGrant = getActivePilotGrant(projectId)
  const grantStatus = !activeGrant ? 'none'
    : activeGrant.expiresAt <= now ? 'expired'
      : !policy || !readiness.bindingsValid || !pilotGrantMatchesPolicy(activeGrant, policy) ? 'needs_reconcile'
        : 'active'
  // 消耗合计与活动授权绑定；无授权时为 null，口径与账本预算核验一致。
  const budgetUsage = activeGrant ? getPilotGrantBudgetUsageView(projectId, activeGrant.grantId) : null
  return {
    projectId,
    policy: policy ? {
      revision: policy.revision,
      state: policy.state,
      workspaceId: policy.workspaceId,
      employeeIds: [...policy.employeeIds],
      executorEmployeeId: policy.executorEmployeeId,
      reviewerEmployeeId: policy.reviewerEmployeeId,
      channelId: policy.channelId,
      modelId: policy.modelId,
      maxCostMicros: policy.maxCostMicros,
      maxRuns: policy.maxRuns,
      maxRework: policy.maxRework,
      expiresAt: policy.expiresAt,
    } : null,
    readiness: {
      policyRevision: readiness.policyRevision,
      bindingsValid: readiness.bindingsValid,
      blockers: [...readiness.blockers],
    },
    activeGrant,
    grantStatus,
    budgetUsage,
  }
}
