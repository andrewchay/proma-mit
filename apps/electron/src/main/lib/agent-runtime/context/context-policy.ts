import type { ContextItem, ContextProjectionPolicy, ContextProjectionRequest, ContextVisibility } from '@gravitas/shared'

export interface ResolvedContextProjectionRequest extends ContextProjectionRequest {
  maxInputTokens: number
  allowedVisibility: ContextVisibility[]
  policy: ContextProjectionPolicy
}

const DEFAULT_POLICY: ContextProjectionPolicy = {
  allowUnverified: false,
  includeRawEvidence: false,
  includeSummaries: true,
  includeFullContent: true,
}

/**
 * 为投影请求补齐稳定默认值。默认不包含 private 内容，也不让未验证事项静默进入模型上下文。
 */
export function resolveContextProjectionRequest(request: ContextProjectionRequest): ResolvedContextProjectionRequest {
  return {
    ...request,
    maxInputTokens: request.maxInputTokens ?? 4_000,
    allowedVisibility: request.allowedVisibility ?? ['model', 'parent'],
    policy: { ...DEFAULT_POLICY, ...request.policy },
  }
}

/** Policy 是收紧边界而非提权提示；任一限制不满足即拒绝 item。 */
export function isContextItemAllowed(
  item: ContextItem,
  request: ResolvedContextProjectionRequest,
): boolean {
  return contextItemRejectionReason(item, request) === undefined
}

/** 返回拒绝原因，使 policy/visibility 过滤不会形成不可解释的静默省略。 */
export function contextItemRejectionReason(
  item: ContextItem,
  request: ResolvedContextProjectionRequest,
): string | undefined {
  if (item.source.sessionId !== request.sessionId) return 'different session'
  if (!request.allowedVisibility.includes(item.visibility)) return `visibility=${item.visibility} not allowed`
  if (request.excludedKinds?.includes(item.kind)) return `kind=${item.kind} excluded`
  if (item.expiresAt && item.expiresAt <= item.updatedAt) return 'expired at source update time'
  if (!request.policy.allowUnverified && !isVerified(item)) return 'unverified evidence blocked by policy'
  if (!matchesPathPolicy(item, request.policy)) return 'path blocked by policy'
  if (!matchesModelPolicy(request)) return 'target model blocked by policy'
  return undefined
}

export function isVerified(item: ContextItem): boolean {
  return item.confidence === 'high'
    && item.evidence.length > 0
    && item.evidence.every((evidence) => evidence.verified)
}

function matchesPathPolicy(item: ContextItem, policy: ContextProjectionPolicy): boolean {
  const locators = item.evidence.flatMap((evidence) => evidence.locator ? [evidence.locator] : [])
  if (policy.deniedPaths?.some((path) => locators.some((locator) => locator.startsWith(path)))) return false
  if (policy.allowedPaths && policy.allowedPaths.length > 0) {
    return locators.some((locator) => policy.allowedPaths!.some((path) => locator.startsWith(path)))
  }
  return true
}

function matchesModelPolicy(request: ResolvedContextProjectionRequest): boolean {
  const allowlist = request.policy.modelAllowlist
  if (!allowlist || allowlist.length === 0) return true
  if (!request.targetModel) return false
  const qualified = `${request.targetModel.provider}/${request.targetModel.modelId}`
  return allowlist.includes(qualified)
}
