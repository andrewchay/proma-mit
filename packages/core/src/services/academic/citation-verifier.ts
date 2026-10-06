/**
 * 引用验证器 — 交叉核对引用真实性
 *
 * 支持：
 * - DOI 格式验证
 * - 与外部数据库交叉核对（Semantic Scholar / Crossref / OpenAlex）
 * - 引用文本与数据库记录匹配度检查
 * - 生成验证报告
 */

import type { CitationCheckResult } from '@gravitas/shared'

/** 外部引用数据库接口 */
export interface CitationDatabaseAdapter {
  /** 通过 DOI 查询文献 */
  lookupByDoi(doi: string): Promise<DatabaseRecord | null>
  /** 通过标题+作者查询 */
  lookupByTitle(title: string, authors?: string[]): Promise<DatabaseRecord | null>
  /** 适配器名称 */
  name: string
}

/** 数据库返回记录 */
export interface DatabaseRecord {
  doi?: string
  title: string
  authors: string[]
  year?: number
  journal?: string
  abstract?: string
  url?: string
}

/** 解析出的引用信息 */
export interface ParsedCitation {
  rawText: string
  doi?: string
  title?: string
  authors?: string[]
  year?: number
  journal?: string
}

/** 验证配置 */
export interface CitationVerifierConfig {
  /** 是否要求 DOI */
  requireDoi: boolean
  /** 标题匹配相似度阈值（0-1） */
  titleMatchThreshold: number
  /** 作者匹配最小数量 */
  minAuthorMatch: number
  /** 是否检查年份 */
  checkYear: boolean
}

const DEFAULT_CONFIG: CitationVerifierConfig = {
  requireDoi: false,
  titleMatchThreshold: 0.7,
  minAuthorMatch: 1,
  checkYear: true,
}

// ============================================
// 引用验证器
// ============================================

export class CitationVerifier {
  private adapters: CitationDatabaseAdapter[]
  private config: CitationVerifierConfig

  constructor(adapters: CitationDatabaseAdapter[], config?: Partial<CitationVerifierConfig>) {
    this.adapters = adapters
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 验证单条引用
   */
  async verifyCitation(citation: ParsedCitation): Promise<CitationCheckResult> {
    const issues: string[] = []

    // 1. DOI 格式验证
    if (citation.doi && !this.isValidDoiFormat(citation.doi)) {
      issues.push(`DOI 格式无效: ${citation.doi}`)
    }

    // 2. 外部数据库交叉核对
    let dbRecord: DatabaseRecord | null = null

    if (citation.doi) {
      for (const adapter of this.adapters) {
        dbRecord = await adapter.lookupByDoi(citation.doi)
        if (dbRecord) {
          break
        }
      }
    }

    if (!dbRecord && citation.title) {
      for (const adapter of this.adapters) {
        dbRecord = await adapter.lookupByTitle(citation.title, citation.authors)
        if (dbRecord) {
          break
        }
      }
    }

    // 3. 核对结果分析
    if (!dbRecord) {
      issues.push('未能在外部数据库中找到该引用记录')
      if (this.config.requireDoi && !citation.doi) {
        issues.push('缺少 DOI，建议补充以提升可验证性')
      }
    } else {
      // 标题匹配检查
      if (citation.title && dbRecord.title) {
        const similarity = this.calculateSimilarity(citation.title, dbRecord.title)
        if (similarity < this.config.titleMatchThreshold) {
          issues.push(
            `标题匹配度低 (${(similarity * 100).toFixed(0)}%): 引用"${citation.title}" vs 数据库"${dbRecord.title}"`
          )
        }
      }

      // 作者匹配检查
      if (citation.authors && dbRecord.authors.length > 0) {
        const matchedAuthors = this.countMatchedAuthors(citation.authors, dbRecord.authors)
        if (matchedAuthors < this.config.minAuthorMatch) {
          issues.push(
            `作者信息不匹配: 引用作者 [${citation.authors.join(', ')}] vs 数据库 [${dbRecord.authors.join(', ')}]`
          )
        }
      }

      // 年份检查
      if (this.config.checkYear && citation.year && dbRecord.year) {
        if (citation.year !== dbRecord.year) {
          issues.push(`年份不一致: 引用 ${citation.year} vs 数据库 ${dbRecord.year}`)
        }
      }
    }

    const isValid = issues.length === 0

    return {
      id: `cite-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      rawText: citation.rawText,
      isValid,
      issue: issues.length > 0 ? issues.join('; ') : undefined,
      suggestion: this.generateSuggestion(citation, dbRecord, issues),
    }
  }

  /**
   * 批量验证引用
   */
  async verifyCitations(citations: ParsedCitation[]): Promise<CitationCheckResult[]> {
    const results: CitationCheckResult[] = []
    for (const citation of citations) {
      results.push(await this.verifyCitation(citation))
    }
    return results
  }

  /**
   * 从论文文本中提取引用
   */
  extractCitations(text: string): ParsedCitation[] {
    const citations: ParsedCitation[] = []

    // DOI 模式匹配
    const doiPattern = /10\.\d{4,}\/[^\s\]\)]+/g
    const doiMatches = text.matchAll(doiPattern)
    for (const match of doiMatches) {
      const doi = match[0]
      // 获取上下文（前后 200 字符）
      const start = Math.max(0, match.index! - 200)
      const end = Math.min(text.length, match.index! + doi.length + 200)
      const context = text.slice(start, end)

      citations.push({
        rawText: context,
        doi,
        ...this.extractMetadataFromContext(context),
      })
    }

    // 括号引用模式 [1], [2,3], [1-5]
    const bracketPattern = /\[(\d+(?:[-,]\d+)*)\]/g
    const bracketMatches = text.matchAll(bracketPattern)
    for (const match of bracketMatches) {
      const contextStart = Math.max(0, match.index! - 150)
      const contextEnd = Math.min(text.length, match.index! + match[0].length + 150)
      citations.push({
        rawText: text.slice(contextStart, contextEnd),
        ...this.extractMetadataFromContext(text.slice(contextStart, contextEnd)),
      })
    }

    // 去重（基于 DOI 或 rawText 前 50 字符）
    const seen = new Set<string>()
    return citations.filter((c) => {
      const key = c.doi ?? c.rawText.slice(0, 50)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // ============================================
  // 内部方法
  // ============================================

  private isValidDoiFormat(doi: string): boolean {
    return /^10\.\d{4,}\/[\S]+$/.test(doi)
  }

  private calculateSimilarity(a: string, b: string): number {
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2)

    const wordsA = new Set(normalize(a))
    const wordsB = new Set(normalize(b))

    if (wordsA.size === 0 || wordsB.size === 0) return 0

    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)))
    const union = new Set([...wordsA, ...wordsB])

    return intersection.size / union.size
  }

  private countMatchedAuthors(cited: string[], db: string[]): number {
    let count = 0
    for (const c of cited) {
      const cLower = c.toLowerCase()
      for (const d of db) {
        const dLower = d.toLowerCase()
        // 支持部分匹配（如 "Smith" 匹配 "Smith, J.")
        if (dLower.includes(cLower) || cLower.includes(dLower.split(',')[0]!.trim())) {
          count++
          break
        }
      }
    }
    return count
  }

  private extractMetadataFromContext(context: string): Partial<ParsedCitation> {
    const result: Partial<ParsedCitation> = {}

    // 提取年份
    const yearMatch = context.match(/\b(19|20)\d{2}\b/)
    if (yearMatch) {
      result.year = parseInt(yearMatch[0], 10)
    }

    // 提取标题（引号或斜体之间的内容）
    const titleMatch = context.match(/["""]([^"""]+)["""]/) || context.match(/<i>([^<]+)<\/i>/)
    if (titleMatch) {
      result.title = titleMatch[1]!.trim()
    }

    // 提取作者（et al. 前的名字）
    const authorMatch = context.match(/([A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+)*)\s+et\s+al\./)
    if (authorMatch) {
      result.authors = authorMatch[1]!.split(/,\s*/).map((a) => a.trim())
    }

    return result
  }

  private generateSuggestion(
    citation: ParsedCitation,
    dbRecord: DatabaseRecord | null,
    issues: string[]
  ): string | undefined {
    const suggestions: string[] = []

    if (!citation.doi && dbRecord?.doi) {
      suggestions.push(`建议添加 DOI: ${dbRecord.doi}`)
    }

    if (dbRecord && issues.some((i) => i.includes('标题'))) {
      suggestions.push(`请核对标题: 数据库记录为 "${dbRecord.title}"`)
    }

    if (dbRecord && issues.some((i) => i.includes('年份'))) {
      suggestions.push(`请核对年份: 数据库记录为 ${dbRecord.year}`)
    }

    if (issues.some((i) => i.includes('未能在'))) {
      suggestions.push('建议提供 DOI 或更完整的文献信息以便验证')
    }

    return suggestions.length > 0 ? suggestions.join('; ') : undefined
  }
}

/**
 * 便捷函数：创建内存数据库适配器（用于测试）
 */
export function createMemoryCitationAdapter(records: DatabaseRecord[]): CitationDatabaseAdapter {
  return {
    name: 'memory',
    async lookupByDoi(doi: string) {
      return records.find((r) => r.doi === doi) ?? null
    },
    async lookupByTitle(title: string, authors?: string[]) {
      return (
        records.find((r) => {
          const titleMatch = r.title.toLowerCase().includes(title.toLowerCase())
          const authorMatch =
            !authors ||
            authors.length === 0 ||
            r.authors.some((ra) => authors.some((a) => ra.toLowerCase().includes(a.toLowerCase())))
          return titleMatch && authorMatch
        }) ?? null
      )
    },
  }
}
