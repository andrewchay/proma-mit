/**
 * 出海 Sourcing 邮件收发类型与 IPC 通道（outbound-mail）
 *
 * 设计约束：
 * - 发送审批制：所有邮件先入待发队列（draft），经人工逐封确认（approved）后才经
 *   SMTP 发出；Agent 工具只能入队，不能直接发送。
 * - 凭据（IMAP/SMTP 密码/授权码）以 safeStorage 加密态持久化，绝不进入
 *   Agent 上下文、工具结果或审计。
 */

// =====================================================================
// IPC 通道
// =====================================================================

export const OUTBOUND_MAIL_IPC_CHANNELS = {
  /** 读取邮箱账户配置（密码以加密态返回，明文不出主进程） */
  GET_CONFIG: 'outbound-mail:get-config',
  /** 保存邮箱账户配置（明文密码仅在本次请求中存在，保存即加密） */
  SAVE_CONFIG: 'outbound-mail:save-config',
  /** 测试 IMAP/SMTP 连接 */
  TEST_CONNECTION: 'outbound-mail:test-connection',
  /** 列出收件箱来信 */
  LIST_INBOX: 'outbound-mail:list-inbox',
  /** 手动触发一次同步 */
  SYNC_NOW: 'outbound-mail:sync-now',
  /** 列出待发队列 */
  LIST_OUTBOX: 'outbound-mail:list-outbox',
  /** 队列一封待发邮件（Agent 工具与 UI 共用） */
  QUEUE_EMAIL: 'outbound-mail:queue-email',
  /** 审批通过并发送 */
  APPROVE_SEND: 'outbound-mail:approve-send',
  /** 驳回待发邮件 */
  REJECT_EMAIL: 'outbound-mail:reject-email',
  /** 查询本地外联漏斗指标 */
  GET_METRICS: 'outbound-mail:get-metrics',
  /** 同步完成事件（main → renderer） */
  ON_SYNCED: 'outbound-mail:on-synced',
  /** 队列变化事件（main → renderer） */
  ON_OUTBOX_CHANGED: 'outbound-mail:on-outbox-changed',
} as const

// =====================================================================
// 邮箱账户配置
// =====================================================================

/** 邮箱账户配置（持久化形态；password 为 safeStorage 密文） */
export interface OutboundMailboxConfig {
  /** 显示名称 */
  label: string
  /** 邮箱地址 */
  email: string
  /** IMAP 主机 */
  imapHost: string
  /** IMAP 端口（默认 993） */
  imapPort: number
  /** 是否使用 TLS（默认 true） */
  imapTls: boolean
  /** SMTP 主机 */
  smtpHost: string
  /** SMTP 端口（默认 465） */
  smtpPort: number
  /** SMTP 是否使用 TLS（默认 true；false 时用 STARTTLS 587 语义由实现判断） */
  smtpTls: boolean
  /** 发信人显示名 */
  fromName: string
  /** 密码/授权码（safeStorage 密文，base64） */
  passwordEncrypted: string
  /** 可选定时同步间隔（分钟；0 = 关闭） */
  syncIntervalMinutes: number
  updatedAt: number
}

/** 渲染进程可见的配置形态（不含密码，只含是否已配置） */
export type OutboundMailboxConfigView = Omit<OutboundMailboxConfig, 'passwordEncrypted'> & {
  passwordConfigured: boolean
}

// =====================================================================
// 收件箱
// =====================================================================

/** 来信分类：外联回信（线程匹配已发送）/ 新来信 / 其他 */
export type OutboundInboxCategory = 'outreach_reply' | 'new_inbound' | 'other'

/** 收件箱条目（正文完整存于 JSONL，视图与工具默认只给摘要） */
export interface OutboundInboxItem {
  id: string
  messageId: string
  fromEmail: string
  fromName: string
  subject: string
  /** 纯文本摘要（截断） */
  snippet: string
  /** 完整纯文本正文 */
  text: string
  /** HTML 正文（可选） */
  html: string | null
  receivedAt: number
  category: OutboundInboxCategory
  /** 匹配到的已发送邮件 id（outreach_reply 时存在） */
  threadMailId: string | null
  /** 是否已处理（人工标记或已起草回复） */
  handled: boolean
}

export interface OutboundInboxQuery {
  category?: OutboundInboxCategory
  /** 仅未处理 */
  unhandledOnly?: boolean
  limit?: number
}

export interface OutboundInboxListResult {
  items: OutboundInboxItem[]
  total: number
  lastSyncedAt: number | null
}

// =====================================================================
// 待发队列
// =====================================================================

/** 待发邮件状态机：draft → approved → sent；draft → rejected 终止 */
export type OutboundOutboxStatus = 'draft' | 'approved' | 'sent' | 'rejected' | 'failed'

/** 待发邮件条目 */
export interface OutboundOutboxItem {
  id: string
  to: string
  subject: string
  /** 纯文本正文（发送审批制只支持纯文本，与 REPLY_RULES 一致） */
  body: string
  /** 线程头（回复时使用） */
  inReplyTo: string | null
  references: string[]
  status: OutboundOutboxStatus
  /** 来源：agent 工具 / 人工 */
  source: 'agent' | 'manual'
  /** 关联的来信 id（回复场景） */
  replyToInboxId: string | null
  createdAt: number
  /** 审批/驳回/发送时间与说明 */
  decidedAt: number | null
  decisionNote: string | null
  /** 发送成功后的 messageId */
  sentMessageId: string | null
  /** 发送失败原因 */
  error: string | null
}

// =====================================================================
// 服务结果
// =====================================================================

/** 同步结果 */
export interface OutboundSyncResult {
  ok: boolean
  fetched: number
  newItems: number
  error: string | null
  syncedAt: number
}

/** 邮箱配置测试结果 */
export interface OutboundMailTestResult {
  imapOk: boolean
  smtpOk: boolean
  error: string | null
}
