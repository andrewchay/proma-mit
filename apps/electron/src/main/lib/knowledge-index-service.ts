/**
 * 知识索引服务（K1-03）
 *
 * 把来源目录中的 Markdown 原件写入 context-store 的知识索引表。
 *
 * 边界：
 * - 原件是权威数据；索引是可重建的派生数据（storage-contract 同类边界）。
 * - 只做本地关键词索引，不调用任何模型、不产生网络请求。
 * - 失败隔离：单个文件的问题记录到 errors，不阻塞也不吞掉其他文件。
 * - 增量：内容哈希未变的文件跳过，重跑不重复劳动。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, extname } from 'node:path'
import { openContextStore, type ContextStoreHandle } from '@gravitas/context-store'
import { chunkDocument } from '@gravitas/core/services/knowledge'
import { getConfigDir } from './config-paths'
import { readCatalog } from './knowledge-catalog-service'

/** 索引数据库位置：与 Context Store 同级但独立文件 */
export const KNOWLEDGE_INDEX_DB_PATH = 'knowledge-index/knowledge-index.db'

let storeHandle: ContextStoreHandle | null = null
let storeHandlePath: string | null = null
let opening: Promise<ContextStoreHandle> | null = null

/** 当前配置根下的索引库路径 */
function knowledgeIndexDbPath(): string {
  return join(getConfigDir(), KNOWLEDGE_INDEX_DB_PATH)
}

/** 打开（或复用）知识索引数据库；配置根变化时（测试隔离）重新打开 */
export async function openKnowledgeIndexStore(): Promise<ContextStoreHandle> {
  const path = knowledgeIndexDbPath()
  if (storeHandle && storeHandlePath === path) return storeHandle
  // 配置根变了：旧句柄属于上一个临时目录，不能复用也不需要持久化它
  if (storeHandle) {
    try { storeHandle.close() } catch { /* 旧目录可能已删除 */ }
    storeHandle = null
  }
  if (!opening || storeHandlePath !== path) {
    opening = openContextStore({ path })
    opening.then((handle) => {
      storeHandle = handle
      storeHandlePath = path
    }).catch(() => { opening = null })
  }
  return opening
}

/** 关闭并持久化索引数据库（应用退出时调用） */
export async function closeKnowledgeIndexStore(): Promise<void> {
  if (storeHandle) {
    try { storeHandle.close() } finally {
      storeHandle = null
      storeHandlePath = null
      opening = null
    }
  }
}

export interface IndexSourceRequest {
  sourceType: string
  sourceId: string
}

export interface IndexRunResult {
  ok: boolean
  /** 本次新写入或更新的文档数 */
  indexed: number
  /** 内容未变化而跳过的文档数 */
  unchanged: number
  /** 处理失败的文档数 */
  failed: number
  /** 失败详情（相对路径 + 原因） */
  errors: string[]
  /** 本次是否检测到来源目录消失等结构性问题 */
  missing?: boolean
}

/** 内容哈希：与编辑冲突检测同源，保证"改过"判定一致 */
function contentHash(rawContent: string): string {
  return createHash('sha256').update(rawContent, 'utf-8').digest('hex')
}

const INDEXABLE_EXTENSIONS = new Set(['.md'])
const SKIPPED_DIRS = new Set(['.git', '.obsidian', 'node_modules', 'dist', '.trash', 'attachments', 'assets'])

interface DiscoveredFile {
  relativePath: string
  absolutePath: string
  size: number
  modifiedAt: number
}

function scanMarkdownFiles(root: string, scopePath?: string): DiscoveredFile[] {
  const base = scopePath ? join(root, scopePath) : root
  if (!existsSync(base)) return []

  const files: DiscoveredFile[] = []
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue
        walk(fullPath)
      } else if (entry.isFile() && INDEXABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        try {
          const stat = statSync(fullPath)
          files.push({
            relativePath: relative(root, fullPath).replace(/\\/g, '/'),
            absolutePath: fullPath,
            size: stat.size,
            modifiedAt: stat.mtimeMs,
          })
        } catch {
          // stat 失败的文件留待读取阶段报错
        }
      }
    }
  }
  walk(base)
  return files
}

/**
 * 索引单个来源。
 *
 * 来源必须是 catalog 中登记且启用的 vault 来源；未登记的 sourceId 直接
 * 失败，避免任何调用方凭空给任意目录建索引。
 */
export async function indexSource(request: IndexSourceRequest): Promise<IndexRunResult> {
  const catalog = readCatalog()
  const source = catalog.sources.find((s) => s.id === request.sourceId && s.type === request.sourceType)
  if (!source) {
    return { ok: false, indexed: 0, unchanged: 0, failed: 0, errors: [`来源未注册或类型不匹配: ${request.sourceId}`] }
  }
  if (!source.enabled) {
    return { ok: false, indexed: 0, unchanged: 0, failed: 0, errors: [`来源已停用: ${source.name}`] }
  }
  if (!existsSync(source.locator)) {
    return { ok: false, indexed: 0, unchanged: 0, failed: 0, errors: [`来源路径不存在: ${source.locator}`], missing: true }
  }

  const knowledgeBaseIds = catalog.knowledgeBases
    .filter((kb) => kb.enabled && kb.sourceIds.includes(source.id))
    .map((kb) => kb.id)
  if (knowledgeBaseIds.length === 0) {
    return { ok: true, indexed: 0, unchanged: 0, failed: 0, errors: [] }
  }

  const store = await openKnowledgeIndexStore()
  const files = scanMarkdownFiles(source.locator, source.scopePath)
  const existing = new Map(store.knowledge.listDocumentsBySource(source.id).map((d) => [d.relativePath, d]))

  let indexed = 0
  let unchanged = 0
  let failed = 0
  const errors: string[] = []
  const seenPaths = new Set<string>()
  const now = Date.now()

  for (const file of files) {
    seenPaths.add(file.relativePath)

    let rawContent: string
    try {
      rawContent = readFileSync(file.absolutePath, 'utf-8')
    } catch (err) {
      failed += 1
      errors.push(`${file.relativePath}: 读取失败 (${err instanceof Error ? err.message : String(err)})`)
      continue
    }

    const hash = contentHash(rawContent)
    const previous = existing.get(file.relativePath)
    if (previous && previous.contentHash === hash) {
      unchanged += 1
      continue
    }

    try {
      const chunks = chunkDocument(rawContent)
      const title = /^#\s+(.+)$/m.exec(rawContent)?.[1]?.trim()
        ?? file.relativePath.replace(/\.md$/i, '').split('/').pop()
        ?? file.relativePath

      // 一个文件被多个知识库共享时，为每个成员库各写一份文档记录，
      // 让 SQL 层范围过滤天然生效（而不是检索后过滤）。
      for (const kbId of knowledgeBaseIds) {
        store.knowledge.upsertDocument({
          document: {
            id: `${source.id}:${file.relativePath}:${kbId}`,
            knowledgeBaseId: kbId,
            sourceId: source.id,
            relativePath: file.relativePath,
            title,
            contentHash: hash,
            byteSize: file.size,
            modifiedAt: file.modifiedAt,
            indexedAt: now,
            updatedAt: now,
          },
          chunks: chunks.map((c) => ({
            id: `${source.id}:${file.relativePath}:${kbId}:${c.chunkIndex}`,
            chunkIndex: c.chunkIndex,
            heading: c.heading,
            content: c.content,
            charStart: c.charStart,
            charEnd: c.charEnd,
          })),
        })
      }
      indexed += 1
    } catch (err) {
      failed += 1
      errors.push(`${file.relativePath}: 索引失败 (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  // 磁盘上已消失的文件从索引中移除
  for (const [relativePath, doc] of existing) {
    if (!seenPaths.has(relativePath)) store.knowledge.deleteDocument(doc.id)
  }

  store.persist()

  return { ok: true, indexed, unchanged, failed, errors }
}

/** 索引全部启用的 vault 来源 */
export async function indexAllEnabledSources(): Promise<IndexRunResult> {
  const catalog = readCatalog()
  const sourceIds = [...new Set(catalog.sources.filter((s) => s.type === 'vault' && s.enabled).map((s) => s.id))]

  const merged: IndexRunResult = { ok: true, indexed: 0, unchanged: 0, failed: 0, errors: [] }
  for (const sourceId of sourceIds) {
    const run = await indexSource({ sourceType: 'vault', sourceId })
    if (!run.ok) {
      merged.ok = false
      merged.errors.push(...run.errors)
      continue
    }
    merged.indexed += run.indexed
    merged.unchanged += run.unchanged
    merged.failed += run.failed
    merged.errors.push(...run.errors)
  }
  return merged
}

export interface KnowledgeIndexStatus {
  documentCount: number
  lastIndexedAt: number | null
}

/** 查询知识库的索引状态（UI 展示与覆盖情况说明） */
export function getKnowledgeIndexStatus(allowedKnowledgeBaseIds: readonly string[]): KnowledgeIndexStatus {
  // 同步读取：状态查询不允许触发数据库打开的异步链路
  if (allowedKnowledgeBaseIds.length === 0 || !storeHandle) {
    return { documentCount: 0, lastIndexedAt: null }
  }
  const docs = storeHandle.knowledge.listDocuments(allowedKnowledgeBaseIds)
  return {
    documentCount: docs.length,
    lastIndexedAt: docs.reduce((max, d) => Math.max(max, d.indexedAt), 0) || null,
  }
}

/** 从索引移除某来源的全部文档（来源被删除或撤权时调用） */
export function removeSourceFromIndex(sourceId: string): number {
  if (!storeHandle) return 0
  const removed = storeHandle.knowledge.deleteBySource(sourceId)
  storeHandle.persist()
  return removed
}
