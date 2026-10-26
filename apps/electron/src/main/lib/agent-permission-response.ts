import type { AgentStreamPayload, PermissionResponse } from '@gravitas/shared'

interface PermissionResponseDependencies {
  respondToPermission(requestId: string, behavior: PermissionResponse['behavior'], alwaysAllow: boolean): string | null
  sendResolvedEvent(sessionId: string, payload: AgentStreamPayload): void
  emitResolvedEvent(sessionId: string, payload: AgentStreamPayload): void
}

/** 将权限响应交给运行中的请求，并同步发布完成事件到窗口和会话总线。 */
export function handlePermissionResponse(response: PermissionResponse, dependencies: PermissionResponseDependencies): void {
  const { requestId, behavior, alwaysAllow } = response
  const sessionId = dependencies.respondToPermission(requestId, behavior, alwaysAllow)
  if (!sessionId) return

  const payload: AgentStreamPayload = {
    kind: 'proma_event',
    event: { type: 'permission_resolved', requestId, behavior },
  }
  dependencies.sendResolvedEvent(sessionId, payload)
  dependencies.emitResolvedEvent(sessionId, payload)
}
