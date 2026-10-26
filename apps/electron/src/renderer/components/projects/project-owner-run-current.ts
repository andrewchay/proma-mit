import type { OwnerPlanningLink, ProjectOwnerPlanDraft, ProjectOwnerRunView } from '@gravitas/shared'

interface LatestOwnerRunCurrentInput {
  link: Pick<OwnerPlanningLink, 'goalRevision' | 'planRevision' | 'bindingRevision' | 'contextFingerprint'>
  executionId?: string
  outcome?: Pick<ProjectOwnerRunView['outcomes'][number], 'state' | 'receiptId' | 'planRevision'>
  goalRevision?: number
  plan?: Pick<ProjectOwnerPlanDraft, 'revision' | 'state' | 'origin' | 'sourceRun' | 'contextFingerprint' | 'goalRevision'> | null
  bindingRevision?: number
  contextFingerprint?: string
}

export function isLatestOwnerRunCurrent(input: LatestOwnerRunCurrentInput): boolean {
  const { link, executionId, outcome, goalRevision, plan, bindingRevision, contextFingerprint } = input
  if (goalRevision !== link.goalRevision || bindingRevision !== link.bindingRevision || contextFingerprint !== link.contextFingerprint) return false
  const proposalFromThisRun = outcome?.state === 'proposed'
    && executionId !== undefined
    && outcome.planRevision !== undefined
    && plan?.origin === 'generated'
    && plan.state !== 'stale'
    && plan.sourceRun?.executionId === executionId
    && plan.sourceRun.receiptId === outcome.receiptId
    && plan.goalRevision === link.goalRevision
    && plan.contextFingerprint === link.contextFingerprint
    && plan.revision >= outcome.planRevision
  return (plan?.revision ?? 0) === link.planRevision || proposalFromThisRun
}
