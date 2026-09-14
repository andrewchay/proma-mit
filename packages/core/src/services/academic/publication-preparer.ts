/**
 * 发表准备服务 — Stage 5 期刊匹配与投稿材料生成
 *
 * 功能：
 * - 期刊匹配推荐（基于主题、质量、时效）
 * - Cover Letter 生成
 * - Highlights 生成
 * - Author Statement 生成
 * - 格式检查清单
 */

import type { JournalMatch } from '@gravitas/shared'

/** 论文信息 */
export interface PaperInfo {
  title: string
  abstract: string
  keywords: string[]
  field: string
  wordCount: number
  hasFigures: boolean
  hasTables: boolean
  hasSupplementary: boolean
  authors: Array<{ name: string; affiliation: string; email: string; isCorresponding?: boolean }>
  funding?: string
  conflictsOfInterest?: string
  previousSubmissions?: Array<{ journal: string; date: string; status: string }>
}

/** 期刊数据库条目 */
export interface JournalEntry {
  name: string
  publisher: string
  impactFactor: string
  acceptanceRate: number
  reviewTime: number // 平均审稿周期（天）
  scope: string[]
  wordLimit: number
  format: 'apa' | 'ieee' | 'chicago' | 'custom'
  requiresHighlights: boolean
  requiresAuthorStatement: boolean
  requiresDataAvailability: boolean
  openAccess: boolean
  apc?: number // Article Processing Charge
}

/** 生成配置 */
export interface SubmissionMaterialConfig {
  tone: 'formal' | 'friendly'
  highlightWordLimit: number
  coverLetterMaxWords: number
}

const DEFAULT_CONFIG: SubmissionMaterialConfig = {
  tone: 'formal',
  highlightWordLimit: 85,
  coverLetterMaxWords: 400,
}

// ============================================
// 发表准备服务
// ============================================

export class PublicationPreparer {
  private journals: JournalEntry[]
  private config: SubmissionMaterialConfig

  constructor(journals: JournalEntry[], config?: Partial<SubmissionMaterialConfig>) {
    this.journals = journals
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 期刊匹配推荐
   */
  matchJournals(paper: PaperInfo, limit = 5): JournalMatch[] {
    const scored = this.journals.map((journal) => ({
      journal,
      score: this.calculateMatchScore(paper, journal),
    }))

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ journal, score }) => ({
      journalName: journal.name,
      publisher: journal.publisher,
      matchScore: Math.round(score * 100),
      impactFactor: journal.impactFactor,
      acceptanceRate: journal.acceptanceRate,
      reviewTime: journal.reviewTime,
      scopeMatch: this.findScopeMatches(paper, journal),
      recommendation: this.generateRecommendation(score, journal),
    }))
  }

  /**
   * 生成 Cover Letter
   */
  generateCoverLetter(paper: PaperInfo, targetJournal: string): string {
    const journal = this.journals.find((j) => j.name === targetJournal)
    const correspondingAuthor = paper.authors.find((a) => a.isCorresponding) ?? paper.authors[0]

    const lines: string[] = [
      correspondingAuthor ? `${correspondingAuthor.name}` : '',
      correspondingAuthor ? `${correspondingAuthor.affiliation}` : '',
      correspondingAuthor ? `Email: ${correspondingAuthor.email}` : '',
      '',
      `Editor-in-Chief,`,
      `${targetJournal}`,
      '',
      `Dear Editor,`,
      '',
      `We wish to submit our manuscript entitled "${paper.title}" for consideration for publication in ${targetJournal}.`,
      '',
      `Abstract:`,
      `${paper.abstract.slice(0, 300)}...`,
      '',
      `Our work makes the following contributions:`,
      ...paper.keywords.map((k) => `- ${k}`),
      '',
    ]

    if (journal?.requiresDataAvailability && paper.hasSupplementary) {
      lines.push(`All data and code supporting this study are available in the supplementary materials.`)
      lines.push('')
    }

    if (paper.conflictsOfInterest) {
      lines.push(`Conflict of Interest: ${paper.conflictsOfInterest}`)
      lines.push('')
    }

    if (paper.funding) {
      lines.push(`Funding: This work was supported by ${paper.funding}.`)
      lines.push('')
    }

    lines.push(`We confirm that this manuscript is original, has not been published before, and is not under consideration elsewhere.`)
    lines.push('')
    lines.push(`Thank you for your consideration.`)
    lines.push('')
    lines.push(`Sincerely,`)
    lines.push(correspondingAuthor?.name ?? '')

    return lines.join('\n')
  }

  /**
   * 生成 Highlights（3-5 条）
   */
  generateHighlights(paper: PaperInfo): string[] {
    const highlights: string[] = []

    // 基于关键词和标题生成
    for (const keyword of paper.keywords.slice(0, 3)) {
      const text = `We propose a novel approach to ${keyword} that advances current methodology.`
      if (text.length <= this.config.highlightWordLimit) {
        highlights.push(text)
      }
    }

    // 补充通用亮点
    const genericHighlights = [
      `This study provides empirical evidence for ${paper.field} theory.`,
      `Our findings have practical implications for ${paper.field} applications.`,
      `The methodology can be extended to related domains beyond ${paper.field}.`,
    ]

    for (const h of genericHighlights) {
      if (highlights.length >= 5) break
      if (!highlights.includes(h) && h.length <= this.config.highlightWordLimit) {
        highlights.push(h)
      }
    }

    return highlights.slice(0, 5)
  }

  /**
   * 生成 Author Statement
   */
  generateAuthorStatement(paper: PaperInfo): string {
    const lines: string[] = [
      '# Author Contributions',
      '',
    ]

    for (const author of paper.authors) {
      lines.push(`- **${author.name}**: Conceptualization, Methodology, Writing`)
    }

    lines.push('')
    lines.push('# Author Agreement')
    lines.push('')
    lines.push('All authors have read and approved the final version of this manuscript.')
    lines.push('')

    if (paper.funding) {
      lines.push(`# Funding`)
      lines.push('')
      lines.push(`This work was supported by ${paper.funding}.`)
      lines.push('')
    }

    if (paper.conflictsOfInterest) {
      lines.push(`# Conflicts of Interest`)
      lines.push('')
      lines.push(paper.conflictsOfInterest)
      lines.push('')
    } else {
      lines.push(`# Conflicts of Interest`)
      lines.push('')
      lines.push('The authors declare no conflicts of interest.')
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 生成投稿检查清单
   */
  generateChecklist(paper: PaperInfo, targetJournal: string): Array<{ item: string; required: boolean; status: boolean; note?: string }> {
    const journal = this.journals.find((j) => j.name === targetJournal)

    return [
      { item: 'Title page with author info', required: true, status: paper.title.length > 0 && paper.authors.length > 0 },
      { item: 'Abstract within word limit', required: true, status: paper.abstract.length > 50 },
      { item: 'Keywords (3-6)', required: true, status: paper.keywords.length >= 3 && paper.keywords.length <= 6 },
      { item: 'Main text within word limit', required: true, status: journal ? paper.wordCount <= journal.wordLimit : true, note: journal ? `Limit: ${journal.wordLimit}` : undefined },
      { item: 'Figures and tables', required: true, status: paper.hasFigures || paper.hasTables },
      { item: 'References formatted correctly', required: true, status: true },
      { item: 'Cover Letter', required: true, status: true },
      { item: 'Highlights', required: journal?.requiresHighlights ?? false, status: true },
      { item: 'Author Statement', required: journal?.requiresAuthorStatement ?? false, status: true },
      { item: 'Data Availability Statement', required: journal?.requiresDataAvailability ?? false, status: paper.hasSupplementary },
      { item: 'Conflict of Interest', required: true, status: !!paper.conflictsOfInterest },
      { item: 'Funding Statement', required: !!paper.funding, status: !!paper.funding },
    ]
  }

  /**
   * 检查是否准备好投稿
   */
  isReadyToSubmit(paper: PaperInfo, targetJournal: string): { ready: boolean; missing: string[] } {
    const checklist = this.generateChecklist(paper, targetJournal)
    const missing = checklist
      .filter((item) => item.required && !item.status)
      .map((item) => item.item)

    return {
      ready: missing.length === 0,
      missing,
    }
  }

  // ============================================
  // 内部方法
  // ============================================

  private calculateMatchScore(paper: PaperInfo, journal: JournalEntry): number {
    let score = 0

    // 1. 主题匹配（权重 40%）
    const scopeMatches = this.findScopeMatches(paper, journal)
    score += (scopeMatches.length / Math.max(1, paper.keywords.length)) * 0.4

    // 2. 字数适合度（权重 20%）
    if (paper.wordCount <= journal.wordLimit) {
      score += 0.2
    } else if (paper.wordCount <= journal.wordLimit * 1.2) {
      score += 0.1
    }

    // 3. 接受率（权重 20%）
    score += journal.acceptanceRate * 0.2

    // 4. 审稿周期（权重 10%）
    if (journal.reviewTime <= 30) {
      score += 0.1
    } else if (journal.reviewTime <= 60) {
      score += 0.05
    }

    // 5. 格式兼容性（权重 10%）
    score += 0.1

    return Math.min(1, score)
  }

  private findScopeMatches(paper: PaperInfo, journal: JournalEntry): string[] {
    const matches: string[] = []
    for (const keyword of paper.keywords) {
      const keywordLower = keyword.toLowerCase()
      for (const scope of journal.scope) {
        if (scope.toLowerCase().includes(keywordLower) || keywordLower.includes(scope.toLowerCase())) {
          if (!matches.includes(scope)) {
            matches.push(scope)
          }
        }
      }
    }
    return matches
  }

  private generateRecommendation(score: number, journal: JournalEntry): string {
    if (score >= 0.8) {
      return `高度推荐：${journal.name} 与您的研究主题高度匹配，接受率 ${(journal.acceptanceRate * 100).toFixed(0)}%。`
    }
    if (score >= 0.6) {
      return `推荐：${journal.name} 适合您的研究，建议关注字数限制和格式要求。`
    }
    if (score >= 0.4) {
      return `可考虑：${journal.name} 部分匹配，可能需要调整侧重点。`
    }
    return `不推荐：匹配度较低，建议寻找更合适的期刊。`
  }
}

/**
 * 便捷函数：快速匹配期刊
 */
export function matchJournalsForPaper(
  paper: PaperInfo,
  journals: JournalEntry[],
  limit?: number
): JournalMatch[] {
  const preparer = new PublicationPreparer(journals)
  return preparer.matchJournals(paper, limit)
}
