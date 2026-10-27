interface PendingAgentRequest {
  requestId: string
  sessionId: string
}

/** 合并主进程快照与已收到的实时事件，避免重复请求或复活已解决请求。 */
export function mergePendingAgentRequestSnapshot<T extends PendingAgentRequest>(
  current: ReadonlyMap<string, readonly T[]>,
  snapshot: readonly T[],
  resolvedRequestIds: ReadonlySet<string>,
): Map<string, readonly T[]> {
  const snapshotBySession = new Map<string, T[]>()
  for (const request of snapshot) {
    if (resolvedRequestIds.has(request.requestId)) continue
    const requests = snapshotBySession.get(request.sessionId) ?? []
    if (!requests.some((item) => item.requestId === request.requestId)) {
      requests.push(request)
      snapshotBySession.set(request.sessionId, requests)
    }
  }

  const next = new Map<string, readonly T[]>()
  for (const [sessionId, liveRequests] of current) {
    const restoredRequests = snapshotBySession.get(sessionId) ?? []
    const restoredIds = new Set(restoredRequests.map((request) => request.requestId))
    next.set(sessionId, [
      ...restoredRequests,
      ...liveRequests.filter((request) => !restoredIds.has(request.requestId)),
    ])
    snapshotBySession.delete(sessionId)
  }
  for (const [sessionId, requests] of snapshotBySession) next.set(sessionId, requests)
  return next
}
