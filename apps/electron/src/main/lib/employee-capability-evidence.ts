import { createHash } from 'node:crypto'
import type { AgentEmployeeLearningSample } from './project-types'

/** 冻结候选依赖的样本与最新人工判断；只持久化摘要，不复制证据正文。 */
export function fingerprintCapabilityEvidence(samples: readonly AgentEmployeeLearningSample[]): string {
  const frozen = [...samples].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((sample) => ({
    id: sample.id, agentId: sample.agentId, executionId: sample.executionId, projectId: sample.projectId, taskId: sample.taskId,
    workspaceId: sample.workspaceId ?? null, capabilityVersionIds: [...sample.capabilityVersionIds].sort(), outcome: sample.outcome,
    privacyStatus: sample.privacyStatus, evidenceSummary: sample.evidenceSummary, createdAt: sample.createdAt,
    judgment: sample.ownerJudgment ? { eventId: sample.ownerJudgment.eventId, outcome: sample.ownerJudgment.outcome, deliveryId: sample.ownerJudgment.deliveryId, deliveryVersion: sample.ownerJudgment.deliveryVersion, reasonCode: sample.ownerJudgment.reasonCode ?? null, actor: sample.ownerJudgment.actor, at: sample.ownerJudgment.at } : null,
  }))
  return createHash('sha256').update(JSON.stringify(frozen)).digest('hex')
}
