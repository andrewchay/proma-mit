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
  /** 查询当前是否具备编辑权限 */
  GET_WRITE_PERMISSION: 'knowledge:get-write-permission',
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
