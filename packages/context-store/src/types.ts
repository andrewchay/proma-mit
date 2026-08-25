export type ContextEntityType =
  | 'run'
  | 'session'
  | 'task'
  | 'file_event'
  | 'todo_event'
  | 'calendar'
  | 'member'
  | 'fact'
  | 'session_message'
  | 'tool_call'

export interface ContextEntity {
  id: string
  entityType: ContextEntityType
  /** 来源系统中的原始 ID（如 run uuid、task id） */
  sourceId: string
  /** 来源系统标识（如 'run_store', 'project_store', 'todo_service'） */
  sourceType: string
  title: string
  /** 简短摘要，用于关系图展示 */
  detail?: string
  /** 可搜索的完整文本 */
  content?: string
  /** 事件发生时间（毫秒时间戳） */
  occurredAt: number
}

export interface ContextEdgeInput {
  fromEntityId: string
  toEntityId: string
  relationType: string
  /** 哪次运行或事件推导出的这条关系 */
  sourceRunId?: string
  /** 0.0~1.0，自动推导的关系可小于 1.0 */
  confidence?: number
  occurredAt?: number
}

export interface ContextEdge {
  id: string
  fromEntityId: string
  toEntityId: string
  relationType: string
  sourceRunId?: string
  confidence: number
  occurredAt: number
}

export interface ContextFactInput {
  entityId: string
  factType: string
  key: string
  value: string
  sourceRunId?: string
  confidence?: number
}

export interface ContextFact {
  id: string
  entityId: string
  factType: string
  key: string
  value: string
  sourceRunId?: string
  confidence: number
  createdAt: number
}

export interface ContextSearchHit {
  entity: ContextEntity
  /** FTS5 rank（越小越相关） */
  rank: number
}

export interface RecallOptions {
  /** 限定召回的实体类型 */
  entityTypes?: readonly ContextEntityType[]
  /** 单次召回上限 */
  limit?: number
}

export interface RecallResult {
  hits: ContextSearchHit[]
  /** 是否用了降级匹配 */
  relaxed: boolean
  /** 实际用于检索的词元 */
  tokens: string[]
}

export interface ContextRelatedNode {
  edge: ContextEdge
  entity: ContextEntity
}

export interface ContextStoreOptions {
  /** 数据库文件路径；为空则在内存中创建（测试用） */
  path?: string
  /** 工作区 slug；提供时自动解析为 ~/.proma/workspaces/{slug}/context-store.db */
  workspaceSlug?: string
}
