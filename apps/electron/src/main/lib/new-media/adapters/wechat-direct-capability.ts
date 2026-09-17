/**
 * 微信公众号 direct 能力协商。
 *
 * 两类门槛同时成立才启用能力：
 * 1. 本地前置条件（账号类型、是否已认证、所需接口权限、白名单状态）——保守建模，宁可少开。
 * 2. 平台实际返回的权限集（grantedScopes）——唯一权威来源，本地不推断、不补全。
 *
 * 因此：即使前置条件满足，只要平台没有确认对应权限，能力必须保持关闭，
 * 并在 UI 中给出「缺少平台权限」的明确原因，而不是静默失败。
 */
import type {
  NewMediaPlatformCapabilities,
  WechatAccountType,
  WechatDirectCapabilityReason,
  WechatDirectCapabilityState,
  WechatVerificationStatus,
} from '@gravitas/shared'

export type { WechatDirectCapabilityReason, WechatDirectCapabilityState }

export type WechatDirectCapability =
  | 'material:upload'
  | 'draft:create'
  | 'draft:update'
  | 'draft:query'
  | 'draft:delete'
  | 'freepublish:submit'
  | 'freepublish:status'
  | 'analysis:user'
  | 'analysis:article'
  | 'comment:read'
  | 'comment:reply'
  | 'message:customer-service'

export interface WechatDirectCapabilityRule {
  capability: WechatDirectCapability
  label: string
  /** 平台接口权限名（与微信后台「接口权限」一致，用于比对 grantedScopes）。 */
  requiredScopes: readonly string[]
  allowedAccountTypes: readonly WechatAccountType[]
  /** 是否要求账号已完成微信认证。 */
  requiresVerification: boolean
  /** 是否要求出口 IP 已在微信后台加入白名单。 */
  requiresIpWhitelist: boolean
  /** 该能力是否会产生对外可见的副作用（发布 / 回复 / 群发）。 */
  externalSideEffect: boolean
  note: string
}

/**
 * 能力前置条件矩阵。
 *
 * 这些是本地保守判断，不代表微信当前的最终规则；真实可用性仍以平台返回的
 * 权限集与接口调用结果为准。修改前请对照微信官方接口权限文档。
 */
export const WECHAT_DIRECT_CAPABILITY_RULES: readonly WechatDirectCapabilityRule[] = [
  {
    capability: 'material:upload',
    label: '上传图片素材',
    requiredScopes: ['material'],
    allowedAccountTypes: ['subscription', 'service', 'test'],
    requiresVerification: false,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '仅上传到微信素材库，不对外发布；测试号同样可用。',
  },
  {
    capability: 'draft:create',
    label: '新建草稿',
    requiredScopes: ['draft'],
    allowedAccountTypes: ['subscription', 'service', 'test'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '草稿只存在微信草稿箱，未发布前对外不可见。',
  },
  {
    capability: 'draft:update',
    label: '更新草稿',
    requiredScopes: ['draft'],
    allowedAccountTypes: ['subscription', 'service', 'test'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '更新会覆盖草稿内容，需保留本地版本以便回退。',
  },
  {
    capability: 'draft:query',
    label: '查询草稿',
    requiredScopes: ['draft'],
    allowedAccountTypes: ['subscription', 'service', 'test'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '只读。',
  },
  {
    capability: 'draft:delete',
    label: '删除草稿',
    requiredScopes: ['draft'],
    allowedAccountTypes: ['subscription', 'service', 'test'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '不可恢复，必须逐次人工确认。',
  },
  {
    capability: 'freepublish:submit',
    label: '提交发布',
    requiredScopes: ['freepublish'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: true,
    note: '提交成功不等于发布成功，必须等待平台异步状态；测试号不支持发布。',
  },
  {
    capability: 'freepublish:status',
    label: '查询发布状态',
    requiredScopes: ['freepublish'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '以官方回调为主、轮询为辅，不能凭提交成功推断已发布。',
  },
  {
    capability: 'analysis:user',
    label: '用户分析',
    requiredScopes: ['analysis'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '受平台日期窗口与延迟限制，缺失日期必须如实展示。',
  },
  {
    capability: 'analysis:article',
    label: '图文分析',
    requiredScopes: ['analysis'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '新旧统计接口口径不同，必须分开保存，不能混算。',
  },
  {
    capability: 'comment:read',
    label: '读取留言',
    requiredScopes: ['comment'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: false,
    note: '仅账号已获得留言权限时可用；来源标识需可追溯。',
  },
  {
    capability: 'comment:reply',
    label: '回复留言',
    requiredScopes: ['comment'],
    allowedAccountTypes: ['subscription', 'service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: true,
    note: '每次回复都必须人工审批且幂等，禁止静默自动回复。',
  },
  {
    capability: 'message:customer-service',
    label: '发送客服消息',
    requiredScopes: ['message'],
    allowedAccountTypes: ['service'],
    requiresVerification: true,
    requiresIpWhitelist: true,
    externalSideEffect: true,
    note: '受 48 小时会话窗口与频控限制；超限必须拒绝而不是重试轰炸。',
  },
]

export interface WechatDirectNegotiationInput {
  accountType: WechatAccountType
  verificationStatus: WechatVerificationStatus
  grantedScopes: string[]
  ipWhitelistConfigured: boolean
  /** AppID / AppSecret 是否已配置到加密存储。 */
  hasCredential: boolean
  /** 平台是否已确认账号可用；未连接时任何接口都不可调用。 */
  connected: boolean
}

export interface WechatDirectNegotiationResult {
  capabilities: WechatDirectCapabilityState[]
  enabledCapabilities: WechatDirectCapability[]
  /** 平台未授予、但本地前置条件已满足的权限名，用于提示用户去微信后台开通。 */
  missingScopes: string[]
}

/** 平台权限比对：去空格、小写，避免大小写差异造成误判。 */
function normalizeScope(value: string): string {
  return value.trim().toLowerCase()
}

export function negotiateWechatDirectCapabilities(input: WechatDirectNegotiationInput): WechatDirectNegotiationResult {
  const granted = new Set(input.grantedScopes.map(normalizeScope).filter(Boolean))
  const capabilities: WechatDirectCapabilityState[] = []
  const missingScopes = new Set<string>()

  for (const rule of WECHAT_DIRECT_CAPABILITY_RULES) {
    let reason: WechatDirectCapabilityReason = 'enabled'
    let explanation = '前置条件与平台权限均已满足。'

    if (!input.hasCredential) {
      reason = 'no_credential'
      explanation = '尚未配置 AppID / AppSecret，无法调用微信接口。'
    } else if (!input.connected) {
      reason = 'not_connected'
      explanation = '账号尚未通过微信侧校验，当前不会调用任何接口。'
    } else if (!rule.allowedAccountTypes.includes(input.accountType)) {
      reason = 'account_type_not_allowed'
      explanation = `该能力不支持${accountTypeLabel(input.accountType)}，主要限制来自账号类型。`
    } else if (rule.requiresVerification && input.verificationStatus !== 'verified') {
      reason = 'verification_required'
      explanation = '该能力要求账号已完成微信认证，当前账号未认证。'
    } else if (rule.requiresIpWhitelist && !input.ipWhitelistConfigured) {
      reason = 'ip_whitelist_required'
      explanation = '微信要求调用来源 IP 在白名单内，当前尚未配置出口 IP 白名单。'
    } else if (!rule.requiredScopes.every((scope) => granted.has(normalizeScope(scope)))) {
      reason = 'scope_not_granted'
      const absent = rule.requiredScopes.filter((scope) => !granted.has(normalizeScope(scope)))
      for (const scope of absent) missingScopes.add(scope)
      explanation = `微信未返回该接口权限（缺少 ${absent.join('、')}），本地不代为推断。`
    }

    capabilities.push({
      capability: rule.capability as string,
      label: rule.label,
      enabled: reason === 'enabled',
      reason,
      explanation,
      requiredScopes: rule.requiredScopes,
      externalSideEffect: rule.externalSideEffect,
    })
  }

  return {
    capabilities,
    enabledCapabilities: capabilities.filter((item) => item.enabled).map((item) => item.capability as WechatDirectCapability),
    missingScopes: [...missingScopes],
  }
}

export function accountTypeLabel(type: WechatAccountType): string {
  return { subscription: '订阅号', service: '服务号', test: '测试号' }[type]
}

/**
 * 把协商结果投影为统一的平台能力快照。
 * 只映射到既有的 NewMediaPlatformCapabilities 字段，不新增未定义能力。
 */
export function toWechatPlatformCapabilities(result: WechatDirectNegotiationResult): NewMediaPlatformCapabilities {
  const enabled = new Set(result.enabledCapabilities)
  return {
    localDraft: true,
    remoteDraft: enabled.has('draft:create') || enabled.has('draft:update'),
    // 提交发布仍需人工审批，因此这里只表示「具备提交能力」，不代表会自动发布。
    publish: enabled.has('freepublish:submit') && enabled.has('freepublish:status'),
    readEngagements: enabled.has('comment:read'),
    sendReply: enabled.has('comment:reply'),
    readMetrics: enabled.has('analysis:user') || enabled.has('analysis:article'),
  }
}

/** 对外部可见副作用的能力名，供 UI 与执行器做二次确认。 */
export const WECHAT_DIRECT_EXTERNAL_CAPABILITIES: readonly WechatDirectCapability[] = [
  'freepublish:submit',
  'comment:reply',
  'message:customer-service',
]
