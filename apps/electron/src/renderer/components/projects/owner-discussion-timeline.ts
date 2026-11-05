import type { OwnerDispatchControlEvent, OwnerExecutionGrant, OwnerManagementMessage, ProjectOwnerPlanDraft } from '@gravitas/shared'

export type OwnerDiscussionEntry =
  | { kind: 'message'; at: number; message: OwnerManagementMessage }
  | { kind: 'plan'; at: number; plan: ProjectOwnerPlanDraft }
  | { kind: 'grant'; at: number; grant: OwnerExecutionGrant }
  | { kind: 'grant_revoked'; at: number; grant: OwnerExecutionGrant }
  | { kind: 'dispatch_control'; at: number; event: OwnerDispatchControlEvent }

/** 只投影已有账本；同一版本在当前记录和历史中出现时只展示一次。 */
export function ownerDiscussionTimeline(messages: readonly OwnerManagementMessage[], plans: readonly ProjectOwnerPlanDraft[], currentPlan: ProjectOwnerPlanDraft | null, grants: readonly OwnerExecutionGrant[], currentGrant: OwnerExecutionGrant | null, dispatchEvents: readonly OwnerDispatchControlEvent[] = []): OwnerDiscussionEntry[] {
  const planVersions = new Map(plans.map(plan => [plan.revision, plan]))
  if (currentPlan?.state === 'confirmed' && !planVersions.has(currentPlan.revision)) planVersions.set(currentPlan.revision, currentPlan)
  const grantVersions = new Map(grants.map(grant => [grant.grantId, grant]))
  if (currentGrant) grantVersions.set(currentGrant.grantId, { ...grantVersions.get(currentGrant.grantId), ...currentGrant })
  return [
    ...messages.map(message => ({ kind: 'message' as const, at: message.createdAt, message })),
    ...[...planVersions.values()].filter(plan => plan.state === 'confirmed').map(plan => ({ kind: 'plan' as const, at: plan.savedAt, plan })),
    ...[...grantVersions.values()].map(grant => ({ kind: 'grant' as const, at: grant.issuedAt, grant })),
    ...[...grantVersions.values()].flatMap(grant => grant.revokedAt === undefined ? [] : [{ kind: 'grant_revoked' as const, at: grant.revokedAt, grant }]),
    ...dispatchEvents.map(event => ({ kind: 'dispatch_control' as const, at: event.createdAt, event })),
  ].sort((a, b) => a.at - b.at)
}
