/**
 * 模型家族判断工具
 *
 * 集中管理"是否属于真正的 Claude 家族"等模型识别逻辑。
 * 与官方 Proma v0.16.8 修复对齐：不能只按 `includes('claude')` 判断，
 * 否则自定义 fork / 代理别名（如 `gateway/claude-proxy`、`my-claude-fork`）
 * 会被误判为 Claude，导致误注入 CLAUDE_CODE_MAX_OUTPUT_TOKENS、
 * SubAgent 误用 Claude 模型分层。
 */

/**
 * 判断模型是否属于真正的 Claude 家族（用于 SubAgent 分层与 SDK 环境变量注入）。
 *
 * 识别规则：模型 ID 以 `claude-` 开头（允许 `claude-sonnet-4-6`、
 * `claude-3-5-sonnet-20241022`、`claude-opus-4-7` 等真实家族名形态），
 * 同时排除带 `/` 或 `:` 的代理/路由别名。
 */
export function isClaudeFamilyModel(modelId: string | undefined | null): boolean {
  if (!modelId) return false
  const id = modelId.trim().toLowerCase()
  if (!id.startsWith('claude-')) return false
  // 代理/路由别名通常带 / 或 :（如 gateway/claude-proxy、provider:claude-sonnet）
  if (id.includes('/') || id.includes(':')) return false
  return true
}
