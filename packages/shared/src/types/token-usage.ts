/**
 * Token 消耗统计类型定义
 *
 * 用于 Agent 会话按轮次/工具/Skill/MCP/模型维度的用量统计。
 */

/** 单轮 Token 使用记录 */
export interface TokenUsageRecord {
  /** 记录 ID */
  id: string
  /** 所属会话 ID */
  sessionId: string
  /** 本轮在会话中的序号（从 1 开始） */
  turnIndex: number
  /** 对应 assistant message 的 uuid */
  messageUuid?: string
  /** 记录时间戳 */
  timestamp: number
  /** 模型 ID */
  modelId?: string
  /** 渠道 ID */
  channelId?: string
  /** Agent Runtime（claude / pi / ...） */
  agentRuntime?: string

  /** 整轮输入 token */
  inputTokens: number
  /** 整轮输出 token */
  outputTokens: number
  /** 缓存读取 token */
  cacheReadTokens: number
  /** 缓存创建 token */
  cacheCreationTokens: number
  /** 总 token */
  totalTokens: number

  /** 输入费用（USD），未返回时为 0 */
  costInput: number
  /** 输出费用（USD），未返回时为 0 */
  costOutput: number
  /** 缓存读取费用（USD），未返回时为 0 */
  costCacheRead: number
  /** 缓存创建费用（USD），未返回时为 0 */
  costCacheCreation: number
  /** 总费用（USD） */
  costTotal: number

  /** 本轮调用的工具名列表（去重） */
  toolNames: string[]
  /** 本轮涉及的 Skill ID 列表（从工具名解析） */
  skillIds: string[]
  /** 本轮涉及的 MCP 服务器列表（从工具名解析） */
  mcpServers: string[]

  /** 会话标题快照 */
  sessionTitle?: string
  /** 工作区 ID */
  workspaceId?: string
  /** 绑定的 Goal id（长生命周期目标） */
  goalId?: string
}

/** Token 使用查询条件 */
export interface TokenUsageQuery {
  sessionId?: string
  workspaceId?: string
  /** 起始时间（毫秒时间戳） */
  from?: number
  /** 截止时间（毫秒时间戳） */
  to?: number
  /** 限制条数 */
  limit?: number
}

/** Token 使用聚合统计 */
export interface TokenUsageAggregate {
  /** 输入 token 总计 */
  totalInputTokens: number
  /** 输出 token 总计 */
  totalOutputTokens: number
  /** 缓存读取 token 总计 */
  totalCacheReadTokens: number
  /** 缓存创建 token 总计 */
  totalCacheCreationTokens: number
  /** 总 token 总计 */
  totalTokens: number
  /** 总费用 */
  totalCost: number
  /** 按工具聚合 */
  byTool: TokenUsageDimensionItem[]
  /** 按 Skill 聚合 */
  bySkill: TokenUsageDimensionItem[]
  /** 按 MCP 服务器聚合 */
  byMcpServer: TokenUsageDimensionItem[]
  /** 按模型聚合 */
  byModel: TokenUsageDimensionItem[]
  /** 按天聚合 */
  byDay: TokenUsageDayItem[]
}

/** 聚合维度条目 */
export interface TokenUsageDimensionItem {
  name: string
  /** 出现次数（轮次） */
  count: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  cost: number
}

/** 按天聚合条目 */
export interface TokenUsageDayItem {
  date: string
  count: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  cost: number
}

/** 会话级汇总 */
export interface TokenUsageSessionSummary {
  sessionId: string
  title: string
  workspaceId?: string
  /** 轮次数 */
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  cost: number
  lastTimestamp: number
}

/** Token 使用索引（轻量，用于首页快速加载） */
export interface TokenUsageIndex {
  version: 1
  sessions: TokenUsageSessionSummary[]
  lastUpdatedAt: number
}

/** IPC 通道 */
export const TOKEN_USAGE_IPC_CHANNELS = {
  /** 查询轮次明细 */
  LIST: 'token-usage:list',
  /** 查询聚合统计 */
  AGGREGATE: 'token-usage:aggregate',
  /** 查询会话汇总列表 */
  LIST_SESSIONS: 'token-usage:list-sessions',
  /** 清空所有 token 记录 */
  CLEAR: 'token-usage:clear',
  /** 统一成本记账小账本（PH2-D 收敛：单一成本口径） */
  COST_MINI_LEDGER: 'token-usage:cost-mini-ledger',
} as const

/** 统一成本记账小账本（PH2-D） */
export interface CostMiniLedger {
  /** 起止时间 */
  from: number
  to: number
  /** 总费用（USD） */
  totalCostUsd: number
  /** 总 token */
  totalTokens: number
  /** 记录条数 */
  recordCount: number
  /** 按天分布 */
  byDay: Array<{ date: string; costUsd: number; tokens: number }>
  /** 按模型分布 */
  byModel: Array<{ modelId: string; costUsd: number; tokens: number }>
  /** 按会话分布 */
  bySession: Array<{ sessionId: string; costUsd: number; tokens: number }>
}
