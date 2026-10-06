/**
 * 知识索引仓储（K1-03）
 *
 * 存储知识文档与分块，并提供「按知识库范围过滤后再检索」的查询。
 *
 * 关键设计：**范围过滤在 SQL 层完成，不在应用层收尾**。先检索全库再过滤
 * 结果，会让越权内容进入排序与截断过程，既影响召回质量，也容易在改动中
 * 泄漏。这里把 allowedKnowledgeBaseIds 作为 WHERE 条件传入。
 *
 * 索引是可重建的派生数据：原件、目录与人工确认才是权威来源。
 */
import type { SqlJsDatabase } from '../migrations.ts'
import { safeAll } from '../migrations.ts'
import { toIndexTokens, toQueryTokenTiers } from '../retrieval/tokenizer.ts'

export interface KnowledgeDocumentRow {
  id: string
  knowledgeBaseId: string
  sourceId: string
  relativePath: string
  title: string
  contentHash: string
  byteSize: number
  modifiedAt: number
  indexedAt: number
  updatedAt: number
}

export interface KnowledgeChunkInput {
  id: string
  chunkIndex: number
  heading?: string
  content: string
  charStart: number
  charEnd: number
}

export interface KnowledgeChunkRow extends KnowledgeChunkInput {
  documentId: string
}

export interface KnowledgeSearchHit {
  documentId: string
  knowledgeBaseId: string
  sourceId: string
  relativePath: string
  title: string
  chunkId: string
  chunkIndex: number
  heading?: string
  excerpt: string
  charStart: number
  charEnd: number
  contentHash: string
  score: number
}

export interface KnowledgeSearchOptions {
  /** 允许检索的知识库 ID；空数组表示无范围，直接返回空结果 */
  allowedKnowledgeBaseIds: readonly string[]
  /** 允许检索的来源 ID；显式空数组表示无来源，直接返回空结果 */
  sourceIds?: readonly string[]
  limit?: number
}

export class KnowledgeRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  /**
   * 写入一个文档及其分块。
   *
   * 先删旧分块再插入：同一 documentId 代表同一来源位置，旧版本的内容必须
   * 整体消失，避免新旧分块同时被检索到（那会让回答混用两个版本的原文）。
   */
  upsertDocument(input: {
    document: KnowledgeDocumentRow
    chunks: readonly KnowledgeChunkInput[]
  }): void {
    this.deleteDocument(input.document.id)

    this.run(
      `INSERT INTO knowledge_documents
        (id, knowledge_base_id, source_id, relative_path, title, content_hash, byte_size, modified_at, indexed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.document.id,
        input.document.knowledgeBaseId,
        input.document.sourceId,
        input.document.relativePath,
        input.document.title,
        input.document.contentHash,
        input.document.byteSize,
        input.document.modifiedAt,
        input.document.indexedAt,
        input.document.updatedAt,
      ],
    )

    for (const chunk of input.chunks) {
      this.run(
        `INSERT INTO knowledge_chunks
          (id, document_id, chunk_index, heading, content, char_start, char_end, token_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${input.document.id}:${chunk.chunkIndex}`,
          input.document.id,
          chunk.chunkIndex,
          chunk.heading ?? null,
          chunk.content,
          chunk.charStart,
          chunk.charEnd,
          toIndexTokens(`${chunk.heading ?? ''} ${chunk.content}`).join(' '),
        ],
      )
    }
  }

  /** 删除文档及其分块（外键 ON DELETE CASCADE） */
  deleteDocument(documentId: string): void {
    this.run(`DELETE FROM knowledge_chunks WHERE document_id = ?`, [documentId])
    this.run(`DELETE FROM knowledge_documents WHERE id = ?`, [documentId])
  }

  /** 删除某个来源的全部文档（来源被移出或停用时调用） */
  deleteBySource(sourceId: string): number {
    const docs = this.listDocumentsBySource(sourceId)
    for (const doc of docs) this.deleteDocument(doc.id)
    return docs.length
  }

  listDocumentsBySource(sourceId: string): KnowledgeDocumentRow[] {
    return safeAll(
      this.db,
      `SELECT * FROM knowledge_documents WHERE source_id = ?`,
      [sourceId],
    ).map((row) => this.rowToDocument(row))
  }

  getDocument(documentId: string): KnowledgeDocumentRow | null {
    const rows = safeAll(this.db, `SELECT * FROM knowledge_documents WHERE id = ?`, [documentId])
    const row = rows[0]
    return row ? this.rowToDocument(row) : null
  }

  listDocuments(allowedKnowledgeBaseIds: readonly string[]): KnowledgeDocumentRow[] {
    if (allowedKnowledgeBaseIds.length === 0) return []
    const placeholders = allowedKnowledgeBaseIds.map(() => '?').join(', ')
    return safeAll(
      this.db,
      `SELECT * FROM knowledge_documents
       WHERE knowledge_base_id IN (${placeholders})
       ORDER BY modified_at DESC`,
      [...allowedKnowledgeBaseIds],
    ).map((row) => this.rowToDocument(row))
  }

  listChunks(documentId: string): KnowledgeChunkRow[] {
    return safeAll(
      this.db,
      `SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY chunk_index ASC`,
      [documentId],
    ).map((row) => ({
      id: String(row.id),
      documentId: String(row.document_id),
      chunkIndex: Number(row.chunk_index),
      heading: row.heading == null ? undefined : String(row.heading),
      content: String(row.content ?? ''),
      charStart: Number(row.char_start ?? 0),
      charEnd: Number(row.char_end ?? 0),
    }))
  }

  /**
   * 关键词检索。
   *
   * 两档召回：先要求所有 token 命中（AND），无结果时退化为 OR 取交集为空
   * 的宽松档，与 Context Store 既有策略一致，避免长查询零结果。
   */
  search(query: string, options: KnowledgeSearchOptions): { hits: KnowledgeSearchHit[]; relaxed: boolean } {
    const allowed = options.allowedKnowledgeBaseIds
    const sourceIds = options.sourceIds
    if (allowed.length === 0 || sourceIds?.length === 0) return { hits: [], relaxed: false }

    const tiers = toQueryTokenTiers(query)
    if (tiers.length === 0) return { hits: [], relaxed: false }

    const limit = options.limit ?? 20
    const kbPlaceholders = allowed.map(() => '?').join(', ')
    const sourceClause = sourceIds
      ? ` AND d.source_id IN (${sourceIds.map(() => '?').join(', ')})`
      : ''

    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex += 1) {
      const tokens = tiers[tierIndex]!
      const clauses = tokens.map(() => `c.token_text LIKE ? ESCAPE '\\'`)
      const params: (string | number)[] = [...allowed]
      if (sourceIds) params.push(...sourceIds)
      for (const token of tokens) params.push(`%${token}%`)

      const hits = safeAll(
        this.db,
        `SELECT c.id AS chunk_id, c.chunk_index, c.heading, c.content, c.char_start, c.char_end,
                d.id AS document_id, d.knowledge_base_id, d.source_id, d.relative_path, d.title, d.content_hash
         FROM knowledge_chunks c
         JOIN knowledge_documents d ON d.id = c.document_id
         WHERE d.knowledge_base_id IN (${kbPlaceholders})${sourceClause}
           AND ${clauses.join(' AND ')}
         ORDER BY d.modified_at DESC
         LIMIT ?`,
        [...params, limit],
      ).map((row) => this.rowToHit(row))

      if (hits.length > 0 || tierIndex === tiers.length - 1) {
        return { hits, relaxed: tierIndex > 0 }
      }
    }
    return { hits: [], relaxed: false }
  }

  /** 文档总数（用于覆盖情况说明）；显式空来源集合表示无可见文档 */
  countDocuments(
    allowedKnowledgeBaseIds: readonly string[],
    sourceIds?: readonly string[],
  ): number {
    if (allowedKnowledgeBaseIds.length === 0 || sourceIds?.length === 0) return 0
    const placeholders = allowedKnowledgeBaseIds.map(() => '?').join(', ')
    const sourceClause = sourceIds
      ? ` AND source_id IN (${sourceIds.map(() => '?').join(', ')})`
      : ''
    const rows = safeAll(
      this.db,
      `SELECT COUNT(*) AS count FROM knowledge_documents WHERE knowledge_base_id IN (${placeholders})${sourceClause}`,
      sourceIds ? [...allowedKnowledgeBaseIds, ...sourceIds] : [...allowedKnowledgeBaseIds],
    )
    return Number(rows[0]?.count ?? 0)
  }

  private run(sql: string, params: (string | number | null)[]): void {
    const stmt = this.db.prepare(sql)
    try {
      stmt.bind(params)
      stmt.step()
    } finally {
      stmt.free()
    }
  }

  private rowToDocument(row: Record<string, unknown>): KnowledgeDocumentRow {
    return {
      id: String(row.id),
      knowledgeBaseId: String(row.knowledge_base_id),
      sourceId: String(row.source_id),
      relativePath: String(row.relative_path),
      title: String(row.title ?? ''),
      contentHash: String(row.content_hash),
      byteSize: Number(row.byte_size ?? 0),
      modifiedAt: Number(row.modified_at ?? 0),
      indexedAt: Number(row.indexed_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }
  }

  private rowToHit(row: Record<string, unknown>): KnowledgeSearchHit {
    const content = String(row.content ?? '')
    return {
      documentId: String(row.document_id),
      knowledgeBaseId: String(row.knowledge_base_id),
      sourceId: String(row.source_id),
      relativePath: String(row.relative_path),
      title: String(row.title ?? ''),
      chunkId: String(row.chunk_id),
      chunkIndex: Number(row.chunk_index ?? 0),
      heading: row.heading == null ? undefined : String(row.heading),
      excerpt: content.slice(0, 400),
      charStart: Number(row.char_start ?? 0),
      charEnd: Number(row.char_end ?? 0),
      contentHash: String(row.content_hash),
      score: 1,
    }
  }
}
