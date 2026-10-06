/**
 * 知识库 IPC 通道
 *
 * 免费版基础能力，无需订阅即可使用。
 */

// ===== 类型定义 =====

export interface KnowledgeVault {
  id: string
  name: string
  path: string
  type: 'obsidian' | 'local-markdown' | 'folder'
  enabled: boolean
  lastIndexedAt?: string
  createdAt: string
}

export interface KnowledgeNote {
  id: string
  vaultId: string
  title: string
  filePath: string
  content: string
  rawContent: string
  tags: string[]
  links: string[]
  backlinks: string[]
  frontmatter: Record<string, unknown>
  wordCount: number
  createdAt: string
  updatedAt: string
  indexedAt: string
}

export interface KnowledgeSearchResult {
  note: KnowledgeNote
  score: number
  highlights: string[]
  matchType: 'title' | 'content' | 'tag' | 'link'
}

export interface KnowledgeGraphNode {
  id: string
  label: string
  type: 'note' | 'tag'
  count?: number
}

export interface KnowledgeGraphEdge {
  source: string
  target: string
  type: 'link' | 'backlink' | 'tag'
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
}

export const KNOWLEDGE_IPC_CHANNELS = {
  // Vault 管理
  /** 获取 Vault 列表 */
  LIST_VAULTS: 'knowledge:list-vaults',
  /** 创建 Vault */
  CREATE_VAULT: 'knowledge:create-vault',
  /** 更新 Vault */
  UPDATE_VAULT: 'knowledge:update-vault',
  /** 删除 Vault */
  DELETE_VAULT: 'knowledge:delete-vault',

  // 索引
  /** 索引指定 Vault */
  INDEX_VAULT: 'knowledge:index-vault',
  /** 索引所有启用的 Vault */
  INDEX_ALL_VAULTS: 'knowledge:index-all-vaults',

  // 搜索
  /** 搜索笔记 */
  SEARCH_NOTES: 'knowledge:search-notes',
  /** 按标签搜索 */
  SEARCH_BY_TAG: 'knowledge:search-by-tag',
  /** 获取所有标签 */
  GET_ALL_TAGS: 'knowledge:get-all-tags',

  // 笔记
  /** 获取笔记详情 */
  GET_NOTE: 'knowledge:get-note',
  /** 获取笔记列表 */
  LIST_NOTES: 'knowledge:list-notes',
  /** 删除笔记 */
  DELETE_NOTE: 'knowledge:delete-note',

  // 图谱
  /** 获取知识图谱 */
  GET_GRAPH: 'knowledge:get-graph',

  // Agent 上下文
  /** 获取 Agent 上下文 */
  GET_CONTEXT_FOR_AGENT: 'knowledge:get-context-for-agent',

  // 编辑（Knowledge Pro：写用户 Markdown 文件）
  /** 新建笔记 */
  CREATE_NOTE: 'knowledge:create-note',
  /** 更新笔记内容 */
  UPDATE_NOTE: 'knowledge:update-note',
  /** 重命名笔记 */
  RENAME_NOTE: 'knowledge:rename-note',
  /** 删除笔记文件 */
  DELETE_NOTE_FILE: 'knowledge:delete-note-file',
  /** 读取笔记原文（绕过索引缓存，供编辑区加载） */
  READ_NOTE_FILE: 'knowledge:read-note-file',
  /** 查询笔记文件状态（外部变更检测） */
  STAT_NOTE_FILE: 'knowledge:stat-note-file',
  /** 查询笔记当前内容版本（并发编辑比对，主进程哈希） */
  NOTE_FILE_VERSION: 'knowledge:note-file-version',
  /** 查询当前是否具备编辑权限 */
  GET_WRITE_PERMISSION: 'knowledge:get-write-permission',
  /** 候选关联建议（相似度启发式，仅供查看确认） */
  GET_LINK_SUGGESTIONS: 'knowledge:get-link-suggestions',
  /** AOF 图谱构建（K2-02，本地治理链路） */
  BUILD_KNOWLEDGE_GRAPH: 'knowledge:build-knowledge-graph',
  /** AOF 图谱状态 */
  GET_GRAPH_BUILD_STATUS: 'knowledge:get-graph-build-status',
  /** AOF release-pinned 语义查询 */
  QUERY_KNOWLEDGE_GRAPH: 'knowledge:query-knowledge-graph',

  // 知识目录（来源 / 知识库 / Project 关联）
  /** 读取完整目录快照 */
  READ_CATALOG: 'knowledge:read-catalog',
  /** 执行旧 Vault 幂等迁移 */
  MIGRATE_LEGACY_VAULTS: 'knowledge:migrate-legacy-vaults',
  /** 创建来源 */
  CREATE_SOURCE: 'knowledge:create-source',
  /** 更新来源 */
  UPDATE_SOURCE: 'knowledge:update-source',
  /** 删除来源 */
  DELETE_SOURCE: 'knowledge:delete-source',
  /** 创建知识库 */
  CREATE_KNOWLEDGE_BASE: 'knowledge:create-knowledge-base',
  /** 更新知识库 */
  UPDATE_KNOWLEDGE_BASE: 'knowledge:update-knowledge-base',
  /** 删除知识库 */
  DELETE_KNOWLEDGE_BASE: 'knowledge:delete-knowledge-base',
  /** 关联知识库到 Project */
  BIND_PROJECT: 'knowledge:bind-project',
  /** 解除 Project 关联 */
  UNBIND_PROJECT: 'knowledge:unbind-project',
  /** 查询 Project 关联的知识库 */
  LIST_PROJECT_KNOWLEDGE_BASES: 'knowledge:list-project-knowledge-bases',
  /** 解析会话知识范围（UI 展示当前范围用） */
  RESOLVE_SESSION_SCOPE: 'knowledge:resolve-session-scope',
} as const

/**
 * 分析引擎 IPC 通道
 *
 * 免费版基础能力，无需订阅即可使用。
 */

// ===== 类型定义 =====

export type AnalysisType = 'time' | 'productivity' | 'comprehensive'

export interface AnalysisSection {
  id: string
  title: string
  type: 'chart' | 'text' | 'table' | 'comparison'
  chartType?: 'bar' | 'pie' | 'line' | 'stacked-bar' | 'radar'
  data: unknown
  insight?: string
}

export interface AnalysisReport {
  id: string
  type: AnalysisType
  title: string
  period: { start: string; end: string }
  summary: string
  sections: AnalysisSection[]
  recommendations: string[]
  createdAt: string
}

export const ANALYSIS_IPC_CHANNELS = {
  // 报告管理
  /** 获取报告列表 */
  LIST_REPORTS: 'analysis:list-reports',
  /** 获取报告详情 */
  GET_REPORT: 'analysis:get-report',
  /** 删除报告 */
  DELETE_REPORT: 'analysis:delete-report',

  // 报告生成
  /** 生成时间分析报告 */
  GENERATE_TIME_REPORT: 'analysis:generate-time-report',
  /** 生成生产力分析报告 */
  GENERATE_PRODUCTIVITY_REPORT: 'analysis:generate-productivity-report',
  /** 生成综合分析报告 */
  GENERATE_COMPREHENSIVE_REPORT: 'analysis:generate-comprehensive-report',

  // 快捷查询
  /** 生成月度报告 */
  GENERATE_MONTHLY_REPORT: 'analysis:generate-monthly-report',
  /** 生成周报 */
  GENERATE_WEEKLY_REPORT: 'analysis:generate-weekly-report',
} as const

/**
 * 知识目录（Source / KnowledgeBase / Project 关联）
 *
 * 设计边界：
 * - Source 指向原件（Vault 目录、文件、网页快照、会话片段），不搬移原件。
 * - KnowledgeBase 是「用途」维度的逻辑集合，可包含多个来源。
 * - Project 关联只记录「这个项目允许使用哪些知识库」，解除关联不删库。
 *
 * 与旧 Vault 的关系：每个旧 Vault 迁移为一个 Source 和一个默认 KnowledgeBase，
 * 保留原 vaultId 与 noteId，旧 JSON 文件继续存在以便回滚。
 */

/** 来源类型 */
export type KnowledgeSourceType = 'vault' | 'file' | 'web' | 'session'

/** 创建来源的入参（不含服务端生成字段） */
export interface KnowledgeSourceInput {
  type: KnowledgeSourceType
  name: string
  locator: string
  scopePath?: string
  excludePatterns?: string[]
  enabled?: boolean
}

/** 来源登记（指向原件，不复制内容） */
export interface KnowledgeSource {
  id: string
  type: KnowledgeSourceType
  name: string
  /** vault：目录绝对路径；file：文件绝对路径；web：URL；session：会话 ID */
  locator: string
  /** 来源内限定子路径（目录来源可选），如 'projects' */
  scopePath?: string
  /** 排除规则（相对路径前缀或文件名） */
  excludePatterns?: string[]
  enabled: boolean
  createdAt: string
  /** 兼容字段：由旧 Vault 迁移而来时保留原 vaultId */
  legacyVaultId?: string
}

/** 知识库（逻辑集合，面向用途） */
export interface KnowledgeBase {
  id: string
  name: string
  description?: string
  /** 成员来源 ID */
  sourceIds: string[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** Project 与知识库的关联绑定 */
export interface ProjectKnowledgeBinding {
  id: string
  projectId: string
  knowledgeBaseId: string
  createdAt: string
}

/** 目录修订信息：用于缓存失效与乐观并发 */
export interface KnowledgeCatalogRevision {
  /** 每次目录变更递增；关联变更后旧缓存不得命中 */
  revision: number
  updatedAt: string
}

/** 目录快照（服务与 UI 的统一读取结构） */
export interface KnowledgeCatalog {
  schemaVersion: number
  revision: KnowledgeCatalogRevision
  sources: KnowledgeSource[]
  knowledgeBases: KnowledgeBase[]
  bindings: ProjectKnowledgeBinding[]
}

/** 候选关联建议（词面/标签相似度启发式，不是事实置信度） */
export interface KnowledgeLinkSuggestion {
  sourceId: string
  sourceTitle: string
  targetId: string
  targetTitle: string
  confidence: number
  reason: string
}
