import type { EntitlementService } from '../services/entitlement-service'

export async function handleGetEntitlements(
  deps: { entitlementService: EntitlementService },
  accountId: string,
): Promise<Response> {
  const snapshot = await deps.entitlementService.getCurrentSnapshot(accountId)
  if (!snapshot) return Response.json({ code: 'entitlement_not_found', message: '暂无权益记录', retryable: false }, { status: 404 })
  return Response.json({ entitlement: snapshot })
}
