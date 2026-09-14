/**
 * 知识库服务 — Knowledge Service（基础版）
 *
 * 免费版可用的知识库基础能力：
 * - Vault 管理（Obsidian / 本地 Markdown 目录）
 * - Markdown 文件扫描与索引
 * - YAML frontmatter 解析、[[wikilink]] 提取、#tag 提取
 * - 全文搜索与标签搜索
 * - 知识图谱构建
 * - Agent 上下文注入
 * - 数据持久化到 ~/.proma-mit/knowledge/
 *
 * 纯算法逻辑在 @gravitas/core/services/knowledge，此处负责 Electron 层持久化和 IPC。
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join, extname, basename, relative, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { trackNoteReferenced } from './telemetry-tracking'
import {
  getKnowledgeVaultsPath,
  getKnowledgeNotesPath,
  getKnowledgeGraphPath,
} from './config-paths'
import {
  parseNote,
  buildGraph,
  searchNotes,
  calculateSimilarity,
  type KnowledgeGraph,
  type SearchResult,
  type SearchableNote,
} from '@gravitas/core/services/knowledge'

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

// ===== 数据文件路径 =====

function getVaultsPath(): string {
  return getKnowledgeVaultsPath()
}

function getNotesPath(): string {
  return getKnowledgeNotesPath()
}

function getGraphPath(): string {
  return getKnowledgeGraphPath()
}

function ensureVaults(): KnowledgeVault[] {
  const path = getVaultsPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as KnowledgeVault[]
  } catch {
    return []
  }
}

function saveVaults(vaults: KnowledgeVault[]): void {
  const path = getVaultsPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(vaults, null, 2), 'utf-8')
}

function ensureNotes(): KnowledgeNote[] {
  const path = getNotesPath()
  if (!existsSync(path)) return []
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as KnowledgeNote[]
  } catch {
    return []
  }
}

function saveNotes(notes: KnowledgeNote[]): void {
  const path = getNotesPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(notes, null, 2), 'utf-8')
}

function saveGraph(graph: KnowledgeGraph): void {
  const path = getGraphPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(graph, null, 2), 'utf-8')
}

// ===== Vault 管理 =====

export function listKnowledgeVaults(): KnowledgeVault[] {
  return ensureVaults()
}

export function getKnowledgeVault(id: string): KnowledgeVault | null {
  return ensureVaults().find((v) => v.id === id) ?? null
}

export function createKnowledgeVault(
  input: Omit<KnowledgeVault, 'id' | 'createdAt' | 'lastIndexedAt'>,
): KnowledgeVault {
  const vault: KnowledgeVault = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }
  const vaults = ensureVaults()
  vaults.push(vault)
  saveVaults(vaults)
  return vault
}

export function updateKnowledgeVault(
  id: string,
  patch: Partial<KnowledgeVault>,
): KnowledgeVault | null {
  const vaults = ensureVaults()
  const idx = vaults.findIndex((v) => v.id === id)
  if (idx === -1) return null
  const updated = { ...vaults[idx], ...patch } as KnowledgeVault
  vaults[idx] = updated
  saveVaults(vaults)
  return vaults[idx]!
}

export function deleteKnowledgeVault(id: string): boolean {
  const vaults = ensureVaults()
  const filtered = vaults.filter((v) => v.id !== id)
  if (filtered.length === vaults.length) return false
  saveVaults(filtered)
  // 同时删除该 vault 的笔记索引
  const notes = ensureNotes().filter((n) => n.vaultId !== id)
  saveNotes(notes)
  return true
}

// ===== Markdown 文件扫描 =====

function scanMarkdownFiles(dir: string): string[] {
  const files: string[] = []

  function scan(currentDir: string) {
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name)
        if (entry.isDirectory()) {
          // 跳过常见非内容目录
          if (
            ['.git', '.obsidian', 'node_modules', 'dist', '.trash', 'attachments', 'assets'].includes(
              entry.name,
            )
          ) {
            continue
          }
          scan(fullPath)
        } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
          files.push(fullPath)
        }
      }
    } catch (err) {
      console.error(`[Knowledge] 扫描目录失败: ${currentDir}`, err)
    }
  }

  scan(dir)
  return files
}

// ===== 笔记索引 =====

export async function indexKnowledgeVault(
  vaultId: string,
): Promise<{ indexed: number; errors: string[] }> {
  const vault = getKnowledgeVault(vaultId)
  if (!vault) {
    return { indexed: 0, errors: ['Vault 不存在'] }
  }

  if (!existsSync(vault.path)) {
    return { indexed: 0, errors: [`Vault 路径不存在: ${vault.path}`] }
  }

  const errors: string[] = []
  const now = new Date().toISOString()

  // 扫描所有 Markdown 文件
  const mdFiles = scanMarkdownFiles(vault.path)

  // 解析每个文件
  const newNotes: KnowledgeNote[] = []
  for (const filePath of mdFiles) {
    try {
      const rawContent = readFileSync(filePath, 'utf-8')
      const fileName = basename(filePath, '.md')
      const parsed = parseNote(rawContent, fileName)

      const relativePath = relative(vault.path, filePath)

      // 获取文件修改时间
      let updatedAt = now
      try {
        const stat = statSync(filePath)
        updatedAt = stat.mtime.toISOString()
      } catch {
        // 忽略
      }

      const note: KnowledgeNote = {
        id: randomUUID(),
        vaultId,
        title: parsed.title,
        filePath: relativePath,
        content: parsed.content,
        rawContent: parsed.rawContent,
        tags: parsed.tags,
        links: parsed.links,
        backlinks: [], // 稍后计算
        frontmatter: parsed.frontmatter,
        wordCount: parsed.wordCount,
        createdAt: (parsed.frontmatter.created as string) || now,
        updatedAt,
        indexedAt: now,
      }

      newNotes.push(note)
    } catch (err) {
      errors.push(`解析失败: ${relative(vault.path, filePath)}`)
      console.error(`[Knowledge] 解析 Markdown 失败: ${filePath}`, err)
    }
  }

  // 计算 backlinks
  const titleToId: Record<string, string> = {}
  for (const note of newNotes) {
    titleToId[note.title] = note.id
    const fileName = basename(note.filePath, '.md')
    if (!titleToId[fileName]) {
      titleToId[fileName] = note.id
    }
  }

  for (const note of newNotes) {
    const backlinks: string[] = []
    for (const other of newNotes) {
      if (other.id === note.id) continue
      for (const link of other.links) {
        if (link === note.title || link === basename(note.filePath, '.md')) {
          if (!backlinks.includes(other.id)) {
            backlinks.push(other.id)
          }
        }
      }
    }
    note.backlinks = backlinks
  }

  // 合并到现有笔记：保留其他 vault 的笔记，替换当前 vault 的笔记
  const existingNotes = ensureNotes().filter((n) => n.vaultId !== vaultId)
  const allNotes = [...existingNotes, ...newNotes]
  saveNotes(allNotes)

  // 更新 vault 的索引时间
  updateKnowledgeVault(vaultId, { lastIndexedAt: now })

  // 重建图谱
  rebuildGraph()

  return { indexed: newNotes.length, errors }
}

export async function indexAllVaults(): Promise<
  Array<{ vaultId: string; indexed: number; errors: string[] }>
> {
  const vaults = ensureVaults().filter((v) => v.enabled)
  const results: Array<{ vaultId: string; indexed: number; errors: string[] }> = []
  for (const vault of vaults) {
    const result = await indexKnowledgeVault(vault.id)
    results.push({ vaultId: vault.id, ...result })
  }
  return results
}

// ===== 图谱构建 =====

function rebuildGraph(): void {
  const notes = ensureNotes()
  const graph = buildGraph(
    notes.map((n) => ({
      id: n.id,
      title: n.title,
      filePath: n.filePath,
      tags: n.tags,
      links: n.links,
    })),
  )
  saveGraph(graph)
}

export function getKnowledgeGraph(vaultId?: string): KnowledgeGraph {
  const path = getGraphPath()
  if (!existsSync(path)) {
    return { nodes: [], edges: [] }
  }

  try {
    const graph = JSON.parse(readFileSync(path, 'utf-8')) as KnowledgeGraph

    if (!vaultId) return graph

    // 筛选指定 vault 的笔记节点
    const notes = ensureNotes()
    const vaultNoteIds = new Set(notes.filter((n) => n.vaultId === vaultId).map((n) => n.id))

    const filteredNodes = graph.nodes.filter((n) => n.type === 'tag' || vaultNoteIds.has(n.id))
    const filteredEdges = graph.edges.filter(
      (e) => vaultNoteIds.has(e.source) || vaultNoteIds.has(e.target),
    )

    return { nodes: filteredNodes, edges: filteredEdges }
  } catch {
    return { nodes: [], edges: [] }
  }
}

// ===== 搜索 =====

export function searchKnowledge(query: string, vaultId?: string): KnowledgeSearchResult[] {
  const notes = ensureNotes()
  let filtered = vaultId ? notes.filter((n) => n.vaultId === vaultId) : [...notes]

  if (!query || !query.trim()) {
    return filtered
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .map((n) => ({ note: n, score: 1, highlights: [], matchType: 'title' as const }))
  }

  const searchableNotes: SearchableNote[] = filtered.map((n: KnowledgeNote) => ({
    id: n.id,
    title: n.title,
    content: n.content,
    tags: n.tags,
    links: n.links,
  }))

  const results = searchNotes(searchableNotes, query)

  // 映射回完整笔记
  const noteMap = new Map(filtered.map((n: KnowledgeNote) => [n.id, n]))
  return results
    .map((r: SearchResult) => {
      const note = noteMap.get(r.note.id)
      if (!note) return null
      return {
        note,
        score: r.score,
        highlights: r.highlights,
        matchType: r.matchType,
      }
    })
    .filter((r): r is KnowledgeSearchResult => r !== null)
}

// 按标签搜索
export function searchByTag(tag: string, vaultId?: string): KnowledgeNote[] {
  const notes = ensureNotes()
  const filtered = vaultId ? notes.filter((n) => n.vaultId === vaultId) : notes
  return filtered.filter((n) => n.tags.some((t) => t.toLowerCase() === tag.toLowerCase()))
}

// 获取所有标签
export function getAllTags(vaultId?: string): Array<{ tag: string; count: number }> {
  const notes = ensureNotes()
  const filtered = vaultId ? notes.filter((n) => n.vaultId === vaultId) : notes

  const counts: Record<string, number> = {}
  for (const note of filtered) {
    for (const tag of note.tags) {
      counts[tag] = (counts[tag] || 0) + 1
    }
  }

  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
}

// ===== Agent 上下文注入 =====

export async function getKnowledgeContextForAgent(
  query: string,
  maxTokens: number = 4000,
): Promise<string> {
  const results = searchKnowledge(query)
  if (results.length === 0) {
    return ''
  }

  // 按相关性取前 N 条，估算 token（中文字符 ≈ 1 token，英文 ≈ 0.75）
  const chunks: string[] = []
  // 记录实际进入上下文的笔记 id，供采集层统计「知识被使用」
  const referencedNoteIds: string[] = []
  let estimatedTokens = 0

  for (const result of results.slice(0, 5)) {
    const note = result.note
    const chunk = `## ${note.title}\n${note.content.slice(0, 800)}\n`
    const chunkTokens = Math.ceil(chunk.length * 0.6)

    if (estimatedTokens + chunkTokens > maxTokens) {
      break
    }

    chunks.push(chunk)
    referencedNoteIds.push(note.id)
    estimatedTokens += chunkTokens
  }

  if (chunks.length === 0) {
    return ''
  }

  // 采集：笔记被 Agent 引用（旁路观测，失败不影响上下文返回）
  trackNoteReferenced(referencedNoteIds)

  return `## 知识库参考\n\n${chunks.join('\n---\n')}`
}

// ===== 笔记 CRUD =====

export function getKnowledgeNote(id: string): KnowledgeNote | null {
  return ensureNotes().find((n) => n.id === id) ?? null
}

export function listKnowledgeNotes(vaultId?: string): KnowledgeNote[] {
  const notes = ensureNotes()
  const filtered = vaultId ? notes.filter((n) => n.vaultId === vaultId) : notes
  return filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

export function deleteKnowledgeNote(id: string): boolean {
  const notes = ensureNotes()
  const filtered = notes.filter((n) => n.id !== id)
  if (filtered.length === notes.length) return false
  saveNotes(filtered)
  rebuildGraph()
  return true
}
