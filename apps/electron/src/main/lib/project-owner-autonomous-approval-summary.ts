import type {
  OwnerExecutionGrantIssuePreview,
  OwnerExecutionRevalidationView,
  ProjectOwnerGoalSubject,
  ProjectOwnerPlanDraft,
  ProjectOwnerPlanningContext,
} from '@gravitas/shared'
import { ownerExecutionHash } from './project-owner-execution-source'

export interface OwnerAutonomousApprovalSummary {
  projectTitle: string
  deliverables: string[]
  knowledgeNames: string[]
  allowedPaths: string[]
}

/** 仅从与本次授权预览完全一致的主进程冻结记录构造用户可读摘要。 */
export function buildOwnerAutonomousApprovalSummary(
  subject: ProjectOwnerGoalSubject,
  preview: OwnerExecutionGrantIssuePreview,
  view: OwnerExecutionRevalidationView,
  plan: ProjectOwnerPlanDraft | null,
  context: ProjectOwnerPlanningContext,
): OwnerAutonomousApprovalSummary {
  const record = view.revalidation
  if (
    view.status !== 'current' || !record || record.projectId !== subject.projectId || record.taskId !== subject.taskId ||
    record.id !== preview.revalidationId || record.revision !== preview.revalidationRevision ||
    record.integrityHash !== preview.revalidationIntegrityHash || ownerExecutionHash(record.source) !== preview.sourceHash ||
    !plan || plan.projectId !== subject.projectId || plan.taskId !== subject.taskId ||
    plan.state !== 'confirmed' || plan.planVersion !== record.source.planVersion ||
    plan.planFingerprint !== record.source.planFingerprint || plan.contextFingerprint !== record.source.contextFingerprint ||
    context.goal.revision !== plan.goalRevision ||
    context.fingerprint !== record.source.contextFingerprint ||
    context.sources.project.id !== subject.projectId
  ) {
    throw new Error('Owner结果或授权来源已变化，无法生成开始确认摘要')
  }

  const selected = new Set(record.source.selectedStepKeys)
  const deliverables = plan.proposal.steps
    .filter(step => selected.has(step.key))
    .map(step => `${step.title}：${step.outcome}；验收标准：${step.acceptanceCriteria.join('；')}`)
  if (!deliverables.length || deliverables.length !== selected.size) {
    throw new Error('Owner已确认结果与冻结执行范围不一致，无法开始')
  }

  return {
    projectTitle: context.sources.project.title.slice(0, 300),
    deliverables,
    knowledgeNames: [...new Set(record.source.knowledgeSources.map(source => source.name))],
    allowedPaths: [...new Set(record.source.tasks.flatMap(task => task.developmentScope?.allowedPaths ?? []))],
  }
}
