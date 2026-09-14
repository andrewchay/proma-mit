/**
 * 同行评审模拟器测试
 */

import { describe, it, expect } from 'bun:test'
import { PeerReviewSimulator, simulatePeerReview } from './peer-review-simulator'
import type { PaperContent } from './peer-review-simulator'

function createPaper(overrides?: Partial<PaperContent>): PaperContent {
  return {
    title: 'Test Paper',
    abstract: 'This is a novel study about machine learning. We propose a new method.',
    sections: [
      { type: 'introduction', content: 'Related work [1] shows progress. However, there is a gap in current research.' },
      { type: 'method', content: 'We collected 100 samples. We used t-test for analysis. The control group was baseline.' },
      { type: 'results', content: 'The accuracy improved significantly by 15%.' },
      { type: 'discussion', content: 'Our method is better. Limitations include small sample size. Future work will extend this.' },
    ],
    wordCount: 3000,
    field: 'AI',
    ...overrides,
  }
}

describe('PeerReviewSimulator', () => {
  // ============================================
  // 基础功能
  // ============================================

  it('should generate a peer review report', () => {
    const simulator = new PeerReviewSimulator()
    const paper = createPaper()
    const report = simulator.simulate(paper)

    expect(report.paperId).toBeDefined()
    expect(report.generatedAt).toBeGreaterThan(0)
    expect(report.overallScore).toBeGreaterThanOrEqual(0)
    expect(report.overallScore).toBeLessThanOrEqual(100)
    expect(report.decision).toBeDefined()
    expect(report.comments.length).toBeGreaterThan(0)
    expect(report.dimensionScores).toBeDefined()
    expect(report.editorSummary).toBeDefined()
    expect(report.methodologyReview).toBeDefined()
  })

  it('should include all reviewer perspectives', () => {
    const simulator = new PeerReviewSimulator()
    const paper = createPaper()
    const report = simulator.simulate(paper)

    const reviewers = new Set(report.comments.map((c) => c.reviewer))
    expect(reviewers.has('editor')).toBe(true)
    expect(reviewers.has('expert-1')).toBe(true)
    expect(reviewers.has('expert-2')).toBe(true)
    expect(reviewers.has('expert-3')).toBe(true)
    expect(reviewers.has('devil-advocate')).toBe(true)
  })

  // ============================================
  // 评分与决策
  // ============================================

  it('should score high for good paper', () => {
    const paper = createPaper({
      abstract: 'This is a novel and significant study. We propose a new method with strong theoretical guarantees.',
      sections: [
        { type: 'introduction', content: 'Compared to [1] and [2], our method differs in three aspects. There is a clear gap [3][4][5].' },
        { type: 'method', content: 'We collected 500 samples. Power analysis showed n=500 achieves 95% power. We used ANOVA with Bonferroni correction. Control group was matched. Code available at github.com/example.' },
        { type: 'results', content: 'Figure 1 shows accuracy improved by 25% (p < 0.001, Cohen d = 0.8).' },
        { type: 'discussion', content: 'Alternative explanations include confounding factors X and Y, which we ruled out. Limitations: single domain. Future work: extend to multi-modal.' },
      ],
      wordCount: 5000,
    })

    const report = simulatePeerReview(paper)
    expect(report.overallScore).toBeGreaterThanOrEqual(65)
  })

  it('should score low for poor paper', () => {
    const paper = createPaper({
      abstract: 'Short abstract.',
      sections: [
        { type: 'introduction', content: 'Some text without citations.' },
        { type: 'method', content: 'We did experiments.' },
        { type: 'results', content: 'Results are good.' },
        { type: 'discussion', content: 'We are great.' },
      ],
      wordCount: 1000,
    })

    const report = simulatePeerReview(paper)
    expect(report.overallScore).toBeLessThan(65)
  })

  it('should map scores to correct decisions', () => {
    const simulator = new PeerReviewSimulator()

    // 通过配置控制严格度来测试不同决策
    const goodPaper = createPaper()
    const goodReport = simulatePeerReview(goodPaper, { strictness: 0.1 })
    expect(['accept', 'minor-revision']).toContain(goodReport.decision)

    const badPaper = createPaper({
      abstract: 'Short.',
      sections: [
        { type: 'introduction', content: 'No citations here.' },
        { type: 'method', content: 'No stats.' },
        { type: 'results', content: 'No figures.' },
        { type: 'discussion', content: 'No limitations.' },
      ],
    })
    const badReport = simulatePeerReview(badPaper, { strictness: 0.9 })
    expect(['major-revision', 'reject']).toContain(badReport.decision)
  })

  // ============================================
  // 主编评审
  // ============================================

  it('should flag missing novelty statement', () => {
    const paper = createPaper({
      abstract: 'This paper studies machine learning methods.',
    })
    const report = simulatePeerReview(paper)

    const editorComment = report.comments.find((c) => c.reviewer === 'editor' && c.category === 'originality')
    expect(editorComment).toBeDefined()
  })

  it('should flag short abstract', () => {
    const paper = createPaper({
      abstract: 'Short.',
    })
    const report = simulatePeerReview(paper)

    const editorComment = report.comments.find((c) => c.reviewer === 'editor' && c.category === 'significance')
    expect(editorComment).toBeDefined()
  })

  // ============================================
  // 方法论评审
  // ============================================

  it('should flag missing sample size', () => {
    const paper = createPaper({
      sections: [
        { type: 'method', content: 'We did experiments without specifying sample size.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const methodComment = report.comments.find((c) => c.reviewer === 'expert-1' && c.content.includes('样本量'))
    expect(methodComment).toBeDefined()
  })

  it('should flag missing statistical method', () => {
    const paper = createPaper({
      sections: [
        { type: 'method', content: 'We analyzed the data.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const methodComment = report.comments.find((c) => c.reviewer === 'expert-1' && c.content.includes('统计'))
    expect(methodComment).toBeDefined()
  })

  // ============================================
  // 领域评审
  // ============================================

  it('should flag insufficient citations', () => {
    const paper = createPaper({
      sections: [
        { type: 'introduction', content: 'This is a new field with little research.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const domainComment = report.comments.find((c) => c.reviewer === 'expert-2' && c.content.includes('引用'))
    expect(domainComment).toBeDefined()
  })

  it('should flag missing comparison', () => {
    const paper = createPaper({
      sections: [
        { type: 'introduction', content: 'Many studies exist [1][2][3][4][5]. Our work is different.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const domainComment = report.comments.find((c) => c.reviewer === 'expert-2' && c.content.includes('对比'))
    expect(domainComment).toBeDefined()
  })

  // ============================================
  // 魔鬼代言人
  // ============================================

  it('should flag missing alternative explanations', () => {
    const paper = createPaper({
      sections: [
        { type: 'discussion', content: 'Our method significantly improved results.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const devilComment = report.comments.find((c) => c.reviewer === 'devil-advocate' && c.content.includes('替代'))
    expect(devilComment).toBeDefined()
  })

  it('should flag missing limitations', () => {
    const paper = createPaper({
      sections: [
        { type: 'discussion', content: 'Our results are perfect and apply everywhere.' },
      ],
    })
    const report = simulatePeerReview(paper)

    const devilComment = report.comments.find((c) => c.reviewer === 'devil-advocate' && c.content.includes('局限'))
    expect(devilComment).toBeDefined()
  })

  // ============================================
  // 配置选项
  // ============================================

  it('should skip devil advocate when disabled', () => {
    const simulator = new PeerReviewSimulator({ enableDevilAdvocate: false })
    const paper = createPaper()
    const report = simulator.simulate(paper)

    const devilComment = report.comments.find((c) => c.reviewer === 'devil-advocate')
    expect(devilComment).toBeUndefined()
  })

  it('should be stricter for top-tier journals', () => {
    const paper = createPaper()
    const topReport = simulatePeerReview(paper, { targetJournalTier: 'top' })
    const generalReport = simulatePeerReview(paper, { targetJournalTier: 'general' })

    expect(topReport.overallScore).toBeLessThanOrEqual(generalReport.overallScore)
  })

  // ============================================
  // 方法论专项审查
  // ============================================

  it('should include methodology review section', () => {
    const report = simulatePeerReview(createPaper())
    expect(report.methodologyReview.score).toBeGreaterThanOrEqual(0)
    expect(report.methodologyReview.score).toBeLessThanOrEqual(100)
    expect(report.methodologyReview.issues.length).toBeGreaterThan(0)
    expect(report.methodologyReview.strengths.length).toBeGreaterThan(0)
  })

  // ============================================
  // 便捷函数
  // ============================================

  it('should work with simulatePeerReview helper', () => {
    const report = simulatePeerReview(createPaper())
    expect(report.overallScore).toBeDefined()
    expect(report.comments.length).toBeGreaterThan(0)
  })
})
