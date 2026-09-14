/**
 * 知识库渲染层状态
 *
 * 对应免费版基础能力 knowledge-basic（只读索引模式）：Vault 管理、索引、
 * 搜索、笔记浏览与图谱概览。
 *
 * 编辑模式（写入 Markdown 文件）属于 Knowledge Pro 插件能力，不在本文件
 * 范围内。这里的 IPC 调用全部是只读或索引操作，不会修改用户的 Markdown
 * 源文件。
 */
import { atom } from 'jotai'
import type {
  KnowledgeGraph,
  KnowledgeNote,
  KnowledgeSearchResult,
  KnowledgeVault,
} from '@gravitas/shared'

// ===== 基础状态 =====

/** Vault 列表 */
export const knowledgeVaultsAtom = atom<KnowledgeVault[]>([])

/** 当前选中的 Vault id（null 表示「全部 Vault」） */
export const selectedVaultIdAtom = atom<string | null>(null)

/** 笔记列表（受当前 Vault 过滤） */
export const knowledgeNotesAtom = atom<KnowledgeNote[]>([])

/** 当前打开的笔记 */
export const activeNoteAtom = atom<KnowledgeNote | null>(null)

/** 搜索结果（非空时列表区展示结果而非全量笔记） */
export const knowledgeSearchResultsAtom = atom<KnowledgeSearchResult[]>([])

/** 当前搜索词（空串表示未在搜索） */
export const knowledgeSearchQueryAtom = atom<string>('')

/** 标签列表与计数 */
export const knowledgeTagsAtom = atom<Array<{ tag: string; count: number }>>([])

/** 当前选中的标签过滤（null 表示不过滤） */
export const selectedTagAtom = atom<string | null>(null)

/** 知识图谱 */
export const knowledgeGraphAtom = atom<KnowledgeGraph>({ nodes: [], edges: [] })

// ===== 加载状态 =====

/** 是否正在加载（列表/笔记） */
export const knowledgeLoadingAtom = atom<boolean>(false)

/** 是否正在索引 */
export const knowledgeIndexingAtom = atom<boolean>(false)

/** 最近一次错误信息（null 表示无错误） */
export const knowledgeErrorAtom = atom<string | null>(null)

/** 最近一次索引结果摘要（用于提示用户） */
export const knowledgeIndexNoticeAtom = atom<string | null>(null)

// ===== 派生状态 =====

/** 当前选中的 Vault 对象 */
export const selectedVaultAtom = atom<KnowledgeVault | null>((get) => {
  const id = get(selectedVaultIdAtom)
  if (!id) return null
  return get(knowledgeVaultsAtom).find((v) => v.id === id) ?? null
})

/**
 * 列表区实际展示的笔记。
 *
 * 优先级：搜索词非空 → 搜索命中笔记；否则选中标签 → 该标签笔记；
 * 否则全部笔记（已按 Vault 过滤）。
 */
export const visibleNotesAtom = atom<KnowledgeNote[]>((get) => {
  const query = get(knowledgeSearchQueryAtom).trim()
  if (query) {
    return get(knowledgeSearchResultsAtom).map((r) => r.note)
  }
  const tag = get(selectedTagAtom)
  const notes = get(knowledgeNotesAtom)
  if (tag) {
    return notes.filter((n) => n.tags.includes(tag))
  }
  return notes
})

/** 是否处于空状态（无 Vault） */
export const knowledgeEmptyAtom = atom<boolean>((get) => get(knowledgeVaultsAtom).length === 0)

// ===== 操作函数（供组件在事件中直接调用） =====

/**
 * 从主进程拉取知识库全量状态。
 *
 * 保持「一次调用刷新所有派生数据」的简单模型：Vault 列表变化会影响
 * 笔记、标签与图谱的可见范围，分开刷新容易出现状态不一致。
 */
export async function refreshKnowledge(): Promise<{
  vaults: KnowledgeVault[]
  notes: KnowledgeNote[]
  tags: Array<{ tag: string; count: number }>
}> {
  const api = window.electronAPI?.knowledge
  if (!api) throw new Error('知识库 API 未初始化')

  const vaults = await api.listVaults()
  const notes = await api.listNotes()
  const tags = await api.getAllTags()
  return { vaults, notes, tags }
}

/** 索引单个 Vault，返回结果摘要文案 */
export async function indexVault(vaultId: string, vaultName: string): Promise<string> {
  const api = window.electronAPI?.knowledge
  if (!api) throw new Error('知识库 API 未初始化')

  const result = await api.indexVault(vaultId)
  const errorSuffix = result.errors.length > 0 ? `，${result.errors.length} 个文件失败` : ''
  return `「${vaultName}」索引完成：${result.indexed} 篇笔记${errorSuffix}`
}

/** 索引全部启用的 Vault，返回汇总文案 */
export async function indexAllVaults(): Promise<string> {
  const api = window.electronAPI?.knowledge
  if (!api) throw new Error('知识库 API 未初始化')

  const results = await api.indexAllVaults()
  if (results.length === 0) return '没有可索引的 Vault'
  const totalIndexed = results.reduce((sum, r) => sum + r.indexed, 0)
  const totalErrors = results.reduce((sum, r) => sum + r.errors.length, 0)
  const errorSuffix = totalErrors > 0 ? `，${totalErrors} 个文件失败` : ''
  return `索引 ${results.length} 个 Vault，共 ${totalIndexed} 篇笔记${errorSuffix}`
}
