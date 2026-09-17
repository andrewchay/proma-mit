/**
 * 权限集 → Adapter 能力矩阵（P3-06）。
 *
 * 商家授权时微信返回 func_info（权限集列表）；本模块把权限集 id 映射为产品能力：
 * - generateCapabilityMatrix：按账号实际授权的权限集生成能力矩阵；
 *   未授权的权限不生成条目——前端不显示、执行器不调用（DoD 硬性要求）；
 * - 互斥/依赖规则：命中时产出显著警告（blocking 级提示文案），供前端展示；
 * - assertCapability：执行器侧的强制守卫，未授权能力一律抛错，防止绕过 UI 的直接调用。
 *
 * ⚠️ 权限集 id 与能力的对应关系以微信官方文档为准；接入生产前需对照
 * 《第三方平台权限集介绍》核验 FUNC_SCOPE_CAPABILITY_MAP，发现漂移时更新映射并补测试。
 */

/** 产品级能力标识（与 P2 direct 执行器的能力命名对齐）。 */
export type WechatCapabilityId =
  | 'material' // 素材管理（上传/列表/删除）
  | 'draft' // 草稿箱（创建/管理）
  | 'publish' // 发布能力（提交发布与状态查询）
  | 'stats' // 数据统计（用户/图文）
  | 'comment' // 留言管理（只读同步）
  | 'menu' // 自定义菜单
  | 'customer_service' // 客服消息
  | 'web_auth' // 网页授权

export interface WechatCapabilityDescriptor {
  id: WechatCapabilityId
  /** 展示名（中文）。 */
  label: string
  description: string
  /** 需要的权限集 id（任一满足即可启用）。 */
  requiredFuncScopeIds: number[]
}

export const WECHAT_CAPABILITIES: WechatCapabilityDescriptor[] = [
  { id: 'material', label: '素材管理', description: '代商家上传、列举与删除图文素材', requiredFuncScopeIds: [7] },
  { id: 'draft', label: '草稿箱', description: '代商家创建与管理草稿', requiredFuncScopeIds: [7] },
  { id: 'publish', label: '发布能力', description: '代商家提交发布并查询发布状态（提交≠自动发布）', requiredFuncScopeIds: [7] },
  { id: 'stats', label: '数据统计', description: '同步商家用户与图文统计数据（口径与官方后台分离标注）', requiredFuncScopeIds: [2] },
  { id: 'comment', label: '留言管理', description: '只读同步商家留言，回复需人工审批（P4）', requiredFuncScopeIds: [1] },
  { id: 'menu', label: '自定义菜单', description: '读取与配置商家公众号菜单', requiredFuncScopeIds: [11] },
  { id: 'customer_service', label: '客服消息', description: '客服消息接口（产品内为人工审批后回复，P4 范围）', requiredFuncScopeIds: [10, 30] },
  { id: 'web_auth', label: '网页授权', description: '代商家发起微信网页授权', requiredFuncScopeIds: [4] },
]

/** 互斥/依赖规则：命中即产出显著警告。 */
export interface WechatCapabilityConflictRule {
  /** 同时启用这些能力时触发。 */
  when: WechatCapabilityId[]
  severity: 'warning' | 'blocking'
  message: string
}

/**
 * 互斥规则（产品定义）。示例：群发与发布同属外发通道，产品只支持「发布」受控流，
 * 若商家权限集同时包含两者，前端必须显著提示运营确认走哪条通道。
 * 规则以产品行为为准，接入时按实际权限集核验。
 */
export const WECHAT_CAPABILITY_CONFLICT_RULES: WechatCapabilityConflictRule[] = [
  {
    when: ['publish', 'customer_service'],
    severity: 'warning',
    message: '发布能力与客服消息同属对外触达通道：发布走人工审批流，客服回复需单独审批（P4），请确认两条通道的审批责任人。',
  },
]

export interface WechatCapabilityMatrixEntry extends WechatCapabilityDescriptor {
  enabled: boolean
  /** 启用时命中的权限集 id。 */
  matchedFuncScopeIds: number[]
}

export interface WechatCapabilityMatrix {
  authorizerAppId: string
  capabilities: WechatCapabilityMatrixEntry[]
  /** 互斥/依赖命中项（显著提示文案）。 */
  conflicts: WechatCapabilityConflictRule[]
}

/** 由授权权限集生成能力矩阵；未授权权限不生成启用条目。 */
export function generateCapabilityMatrix(input: { authorizerAppId: string; funcScopes: number[] }): WechatCapabilityMatrix {
  const scopeSet = new Set(input.funcScopes)
  const enabledIds = new Set<WechatCapabilityId>()
  const capabilities = WECHAT_CAPABILITIES.map((descriptor) => {
    const matched = descriptor.requiredFuncScopeIds.filter((id) => scopeSet.has(id))
    const enabled = matched.length > 0
    if (enabled) enabledIds.add(descriptor.id)
    return { ...descriptor, enabled, matchedFuncScopeIds: matched }
  })
  const conflicts = WECHAT_CAPABILITY_CONFLICT_RULES.filter((rule) => rule.when.every((id) => enabledIds.has(id)))
  return { authorizerAppId: input.authorizerAppId, capabilities, conflicts }
}

/** 执行器侧守卫：能力未授权时抛错（不调用），授权但已撤权由上层租户/状态守卫负责。 */
export class WechatCapabilityDeniedError extends Error {}

export function assertCapability(matrix: WechatCapabilityMatrix, capability: WechatCapabilityId): void {
  const entry = matrix.capabilities.find((item) => item.id === capability)
  if (!entry || !entry.enabled) {
    throw new WechatCapabilityDeniedError(`能力未授权：${capability}（authorizer=${matrix.authorizerAppId}）`)
  }
}
