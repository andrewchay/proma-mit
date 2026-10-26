export function canLocalUserDraftDeliverable(taskOwnerId: string | undefined): boolean {
  return taskOwnerId === 'local-user'
}

export function canGuideDeliverableDraft(decisionStatus: string): boolean {
  return decisionStatus === 'decided'
}
