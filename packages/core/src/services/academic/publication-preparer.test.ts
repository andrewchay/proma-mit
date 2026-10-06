/**
 * 发表准备服务测试
 */

import { describe, it, expect } from 'bun:test'
import { PublicationPreparer, matchJournalsForPaper } from './publication-preparer'
import type { PaperInfo, JournalEntry } from './publication-preparer'

const MOCK_JOURNALS: JournalEntry[] = [
  {
    name: 'Nature AI',
    publisher: 'Nature',
    impactFactor: '25.8',
    acceptanceRate: 0.08,
    reviewTime: 45,
    scope: ['artificial intelligence', 'machine learning', 'deep learning', 'neural networks'],
    wordLimit: 8000,
    format: 'custom',
    requiresHighlights: true,
    requiresAuthorStatement: true,
    requiresDataAvailability: true,
    openAccess: true,
    apc: 5000,
  },
  {
    name: 'Journal of ML Research',
    publisher: 'JMLR',
    impactFactor: '5.2',
    acceptanceRate: 0.25,
    reviewTime: 90,
    scope: ['machine learning', 'statistical learning', 'optimization'],
    wordLimit: 12000,
    format: 'apa',
    requiresHighlights: false,
    requiresAuthorStatement: false,
    requiresDataAvailability: false,
    openAccess: false,
  },
  {
    name: 'Applied AI Letters',
    publisher: 'Wiley',
    impactFactor: '3.1',
    acceptanceRate: 0.45,
    reviewTime: 20,
    scope: ['applied AI', 'industrial applications', 'case studies'],
    wordLimit: 5000,
    format: 'ieee',
    requiresHighlights: true,
    requiresAuthorStatement: false,
    requiresDataAvailability: false,
    openAccess: true,
    apc: 1500,
  },
]

function createPaper(overrides?: Partial<PaperInfo>): PaperInfo {
  return {
    title: 'Novel Deep Learning Approach for NLP',
    abstract: 'We propose a new method that improves accuracy by 20%.',
    keywords: ['deep learning', 'NLP', 'neural networks'],
    field: 'AI',
    wordCount: 6000,
    hasFigures: true,
    hasTables: true,
    hasSupplementary: true,
    authors: [
      { name: 'Alice Chen', affiliation: 'MIT', email: 'alice@mit.edu', isCorresponding: true },
      { name: 'Bob Smith', affiliation: 'Stanford', email: 'bob@stanford.edu' },
    ],
    funding: 'NSF Grant #12345',
    ...overrides,
  }
}

describe('PublicationPreparer', () => {
  const preparer = new PublicationPreparer(MOCK_JOURNALS)

  // ============================================
  // 期刊匹配
  // ============================================

  it('should match journals by topic', () => {
    const paper = createPaper()
    const matches = preparer.matchJournals(paper)

    expect(matches.length).toBeGreaterThan(0)
    expect(matches[0]!.matchScore).toBeGreaterThan(0)
  })

  it('should rank best matching journal first', () => {
    const paper = createPaper({ keywords: ['deep learning', 'neural networks'] })
    const matches = preparer.matchJournals(paper)

    // Nature AI 应该排在前面（scope 匹配度高）
    expect(matches[0]!.journalName).toBe('Nature AI')
  })

  it('should respect limit parameter', () => {
    const paper = createPaper()
    const matches = preparer.matchJournals(paper, 2)

    expect(matches.length).toBe(2)
  })

  it('should include scope matches', () => {
    const paper = createPaper()
    const matches = preparer.matchJournals(paper)

    expect(matches[0]!.scopeMatch.length).toBeGreaterThan(0)
  })

  it('should provide recommendation text', () => {
    const paper = createPaper()
    const matches = preparer.matchJournals(paper)

    expect(matches[0]!.recommendation).toBeDefined()
    expect(matches[0]!.recommendation.length).toBeGreaterThan(0)
  })

  it('should penalize word count exceeding limit', () => {
    const paper = createPaper({ wordCount: 15000 }) // 超过所有期刊限制
    const matches = preparer.matchJournals(paper)

    // 分数应该较低
    expect(matches.every((m) => m.matchScore < 80)).toBe(true)
  })

  // ============================================
  // Cover Letter
  // ============================================

  it('should generate cover letter', () => {
    const paper = createPaper()
    const letter = preparer.generateCoverLetter(paper, 'Nature AI')

    expect(letter).toContain('Alice Chen')
    expect(letter).toContain('Nature AI')
    expect(letter).toContain(paper.title)
    expect(letter).toContain('Dear Editor')
  })

  it('should include funding in cover letter', () => {
    const paper = createPaper({ funding: 'NSF Grant #12345' })
    const letter = preparer.generateCoverLetter(paper, 'Nature AI')

    expect(letter).toContain('NSF Grant #12345')
  })

  it('should include conflict of interest in cover letter', () => {
    const paper = createPaper({ conflictsOfInterest: 'No conflicts declared.' })
    const letter = preparer.generateCoverLetter(paper, 'Nature AI')

    expect(letter).toContain('No conflicts declared.')
  })

  it('should include data availability when required', () => {
    const paper = createPaper({ hasSupplementary: true })
    const letter = preparer.generateCoverLetter(paper, 'Nature AI')

    expect(letter).toContain('supplementary')
  })

  // ============================================
  // Highlights
  // ============================================

  it('should generate highlights', () => {
    const paper = createPaper()
    const highlights = preparer.generateHighlights(paper)

    expect(highlights.length).toBeGreaterThan(0)
    expect(highlights.length).toBeLessThanOrEqual(5)
    expect(highlights.every((h) => h.length <= 85)).toBe(true)
  })

  it('should include keyword-based highlights', () => {
    const paper = createPaper({ keywords: ['deep learning'] })
    const highlights = preparer.generateHighlights(paper)

    const keywordHighlight = highlights.find((h) => h.includes('deep learning'))
    expect(keywordHighlight).toBeDefined()
  })

  // ============================================
  // Author Statement
  // ============================================

  it('should generate author statement', () => {
    const paper = createPaper()
    const statement = preparer.generateAuthorStatement(paper)

    expect(statement).toContain('Author Contributions')
    expect(statement).toContain('Alice Chen')
    expect(statement).toContain('Bob Smith')
    expect(statement).toContain('Author Agreement')
  })

  it('should include funding in author statement', () => {
    const paper = createPaper({ funding: 'NSF Grant' })
    const statement = preparer.generateAuthorStatement(paper)

    expect(statement).toContain('NSF Grant')
  })

  it('should include conflicts of interest', () => {
    const paper = createPaper({ conflictsOfInterest: 'None.' })
    const statement = preparer.generateAuthorStatement(paper)

    expect(statement).toContain('None.')
  })

  it('should declare no conflicts when not provided', () => {
    const paper = createPaper({ conflictsOfInterest: undefined })
    const statement = preparer.generateAuthorStatement(paper)

    expect(statement).toContain('no conflicts of interest')
  })

  // ============================================
  // 投稿检查清单
  // ============================================

  it('should generate submission checklist', () => {
    const paper = createPaper()
    const checklist = preparer.generateChecklist(paper, 'Nature AI')

    expect(checklist.length).toBeGreaterThan(0)
    expect(checklist.some((item) => item.item === 'Cover Letter')).toBe(true)
    expect(checklist.some((item) => item.item === 'Highlights')).toBe(true)
  })

  it('should flag missing required items', () => {
    const paper = createPaper({
      title: '',
      authors: [],
      abstract: '',
      keywords: [],
    })
    const checklist = preparer.generateChecklist(paper, 'Nature AI')

    const failedItems = checklist.filter((item) => item.required && !item.status)
    expect(failedItems.length).toBeGreaterThan(0)
  })

  it('should check word limit', () => {
    const paper = createPaper({ wordCount: 10000 })
    const checklist = preparer.generateChecklist(paper, 'Applied AI Letters')

    const wordLimitItem = checklist.find((item) => item.item.includes('Main text'))
    expect(wordLimitItem!.status).toBe(false)
    expect(wordLimitItem!.note).toContain('5000')
  })

  // ============================================
  // 投稿准备状态
  // ============================================

  it('should report ready when all items complete', () => {
    const paper = createPaper({ conflictsOfInterest: 'No conflicts declared.' })
    const status = preparer.isReadyToSubmit(paper, 'Journal of ML Research')

    expect(status.ready).toBe(true)
    expect(status.missing.length).toBe(0)
  })

  it('should report not ready when items missing', () => {
    const paper = createPaper({
      hasFigures: false,
      hasTables: false,
      abstract: '',
    })
    const status = preparer.isReadyToSubmit(paper, 'Nature AI')

    expect(status.ready).toBe(false)
    expect(status.missing.length).toBeGreaterThan(0)
  })

  // ============================================
  // 便捷函数
  // ============================================

  it('should work with matchJournalsForPaper helper', () => {
    const paper = createPaper()
    const matches = matchJournalsForPaper(paper, MOCK_JOURNALS, 2)

    expect(matches.length).toBe(2)
    expect(matches[0]!.matchScore).toBeGreaterThan(0)
  })
})
