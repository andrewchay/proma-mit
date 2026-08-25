import type { SqlJsDatabase } from '../migrations.ts'
import {
  type ContextEntityType,
  type ContextSearchHit,
  type RecallOptions,
  type RecallResult,
} from '../types.ts'
import { safeAll } from '../migrations.ts'
import { toQueryTokenTiers } from '../retrieval/tokenizer.ts'

export class SearchRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  /**
   * 基于 bigram 分词的多档召回全文搜索。
   *
   * 实现：
   * 1. 查询分词 → 严格档（含 CJK bigram）→ LIKE 子串匹配
   * 2. 严格档 0 结果 → 放宽档（去掉 CJK bigram，只留单字+ASCII词）
   * 3. 返回命中的实体 + 是否用了放宽档
   */
  searchFullText(
    query: string,
    options: { entityTypes?: readonly ContextEntityType[]; limit?: number } = {},
  ): { hits: ContextSearchHit[]; relaxed: boolean; tokens: string[] } {
    const limit = options.limit ?? 20
    const tiers = toQueryTokenTiers(query)

    if (tiers.length === 0) {
      return { hits: [], relaxed: false, tokens: [] }
    }

    // 先跑严格档，命中则返回；否则跑放宽档
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex += 1) {
      const tokens = tiers[tierIndex]!
      const hits = this.searchWithTokens(tokens, limit, options.entityTypes)
      if (hits.length > 0 || tierIndex === tiers.length - 1) {
        return {
          hits,
          relaxed: tierIndex > 0,
          tokens,
        }
      }
    }

    // 不会走到这里（上面已覆盖所有情况）
    return { hits: [], relaxed: false, tokens: [] }
  }

  /**
   * 统一召回接口（目前基于 bigram 分词 + 两档召回）。
   *
   * 后续可扩展为多路融合（FTS + 图谱 + 向量），通过 fuseRrf 合并。
   */
  recall(query: string, options: RecallOptions = {}): RecallResult {
    const { hits, relaxed, tokens } = this.searchFullText(query, options)
    return {
      hits,
      relaxed,
      tokens,
    }
  }

  // ============================================================
  // 内部实现
  // ============================================================

  private searchWithTokens(
    tokens: string[],
    limit: number,
    entityTypes?: readonly ContextEntityType[],
  ): ContextSearchHit[] {
    if (tokens.length === 0) return []

    // 每个 token 都必须命中 title/content/detail 之一（AND 语义）
    const termClauses = tokens.map(() => `(e.title LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.detail LIKE ? ESCAPE '\\')`)
    const params: (string | number)[] = []
    for (const term of tokens) {
      params.push(`%${term}%`, `%${term}%`, `%${term}%`)
    }

    // 评分：标题前缀命中 > 标题子串命中 > 内容/详情命中
    const firstTerm = tokens[0]!
    const scoreCase = `
      CASE
        WHEN e.title LIKE ? ESCAPE '\\' THEN 0
        WHEN e.title LIKE ? ESCAPE '\\' THEN 1
        WHEN e.content LIKE ? ESCAPE '\\' OR e.detail LIKE ? ESCAPE '\\' THEN 2
        ELSE 3
      END
    `
    params.push(`${firstTerm}%`, `%${firstTerm}%`, `%${firstTerm}%`, `%${firstTerm}%`)

    const typeClause = entityTypes && entityTypes.length > 0
      ? `AND e.entity_type IN (${this.placeholders(entityTypes.length)})`
      : ''
    if (entityTypes && entityTypes.length > 0) {
      params.push(...entityTypes)
    }
    params.push(limit)

    const sql = `
      SELECT e.*, (${scoreCase}) AS score
      FROM context_entities e
      WHERE ${termClauses.join(' AND ')} ${typeClause}
      ORDER BY score ASC, e.occurred_at DESC
      LIMIT ?
    `
    const rows = safeAll(this.db, sql, params)
    return rows.map((row) => ({ entity: this.entityRowToEntity(row), rank: Number(row.score) }))
  }

  private placeholders(count: number): string {
    return Array.from({ length: count }, () => '?').join(', ')
  }

  private entityRowToEntity(row: Record<string, unknown>): import('../types.ts').ContextEntity {
    return {
      id: String(row.id),
      entityType: String(row.entity_type) as import('../types.ts').ContextEntityType,
      sourceId: String(row.source_id),
      sourceType: String(row.source_type),
      title: String(row.title),
      detail: row.detail === null || row.detail === undefined ? undefined : String(row.detail),
      content: row.content === null || row.content === undefined ? undefined : String(row.content),
      occurredAt: Number(row.occurred_at),
    }
  }
}
