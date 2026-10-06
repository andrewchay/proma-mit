/**
 * 同行评审模拟器 — Stage 3 多视角评审
 *
 * 评审视角：
 * - 主编 (editor): 整体贡献、适合期刊、创新性
 * - 专家1 (expert-1): 方法论、实验设计、统计
 * - 专家2 (expert-2): 领域相关性、文献综述
 * - 专家3 (expert-3): 清晰度、写作、图表
 * - 魔鬼代言人 (devil-advocate): 挑刺、替代解释、局限
 *
 * 评分：0-100 分制
 * - ≥80: Accept
 * - 65-79: Minor Revision
 * - 50-64: Major Revision
 * - <50: Reject
 */

import type { PeerReviewReport, ReviewerComment } from '@gravitas/shared'

/** 论文结构 */
export interface PaperContent {
  title: string
  abstract: string
  sections: Array<{ type: string; content: string }>
  wordCount: number
  field?: string
}

/** 评审配置 */
export interface PeerReviewConfig {
  /** 是否启用魔鬼代言人 */
  enableDevilAdvocate: boolean
  /** 评审严格程度 (0-1, 越高越严格) */
  strictness: number
  /** 目标期刊级别 (top/mid/general) */
  targetJournalTier: 'top' | 'mid' | 'general'
}

const DEFAULT_CONFIG: PeerReviewConfig = {
  enableDevilAdvocate: true,
  strictness: 0.5,
  targetJournalTier: 'mid',
}

// ============================================
// 同行评审模拟器
// ============================================

export class PeerReviewSimulator {
  private config: PeerReviewConfig

  constructor(config?: Partial<PeerReviewConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 模拟同行评审
   */
  simulate(paper: PaperContent): PeerReviewReport {
    const comments: ReviewerComment[] = []

    // 1. 主编评审
    comments.push(...this.editorReview(paper))

    // 2. 专家1 — 方法论
    comments.push(...this.methodologyReview(paper))

    // 3. 专家2 — 领域相关
    comments.push(...this.domainReview(paper))

    // 4. 专家3 — 清晰度
    comments.push(...this.clarityReview(paper))

    // 5. 魔鬼代言人
    if (this.config.enableDevilAdvocate) {
      comments.push(...this.devilAdvocateReview(paper))
    }

    // 计算维度评分
    const dimensionScores = this.calculateDimensionScores(comments, paper)
    const overallScore = this.calculateOverallScore(dimensionScores)
    const decision = this.scoreToDecision(overallScore)

    // 生成方法论专项审查
    const methodologyReview = this.generateMethodologyReview(comments)

    // 生成主编总结
    const editorSummary = this.generateEditorSummary(comments, decision, overallScore)

    return {
      paperId: `paper-${Date.now()}`,
      generatedAt: Date.now(),
      overallScore,
      decision,
      dimensionScores,
      comments,
      editorSummary,
      methodologyReview,
    }
  }

  // ============================================
  // 各视角评审
  // ============================================

  private editorReview(paper: PaperContent): ReviewerComment[] {
    const comments: ReviewerComment[] = []

    // 检查创新性声明
    if (!paper.abstract.match(/novel|new|首次|首次提出|创新|原创/i)) {
      comments.push({
        id: `rev-${Date.now()}-e1`,
        reviewer: 'editor',
        reviewerName: '主编',
        category: 'originality',
        severity: 'minor',
        content: '摘要中未明确说明本研究的创新点或贡献，建议补充。',
        suggestion: '在摘要开头或结尾增加一句话概括本研究的核心贡献。',
        section: 'abstract',
      })
    }

    // 检查研究意义
    if (paper.abstract.length < 150) {
      comments.push({
        id: `rev-${Date.now()}-e2`,
        reviewer: 'editor',
        reviewerName: '主编',
        category: 'significance',
        severity: 'minor',
        content: '摘要较短，可能未能充分传达研究的重要性和影响。',
        suggestion: '扩展摘要至 200-250 词，增加研究意义和应用前景。',
        section: 'abstract',
      })
    }

    // 检查适合度
    const methodSection = paper.sections.find((s) => s.type === 'method')
    if (!methodSection || methodSection.content.length < 200) {
      comments.push({
        id: `rev-${Date.now()}-e3`,
        reviewer: 'editor',
        reviewerName: '主编',
        category: 'structure',
        severity: 'major',
        content: '方法部分描述不足，难以评估研究的可重复性。',
        suggestion: '详细描述实验设计、数据收集流程和分析方法。',
        section: 'method',
      })
    }

    return comments
  }

  private methodologyReview(paper: PaperContent): ReviewerComment[] {
    const comments: ReviewerComment[] = []
    const methodSection = paper.sections.find((s) => s.type === 'method')
    const methodText = methodSection?.content ?? ''

    // 检查样本量
    if (!methodText.match(/\d+\s*(samples?|participants?|subjects?)/i)) {
      comments.push({
        id: `rev-${Date.now()}-m1`,
        reviewer: 'expert-1',
        reviewerName: '方法论专家',
        category: 'methodology',
        severity: 'major',
        content: '未明确报告样本量或参与者数量，影响统计功效评估。',
        suggestion: '明确报告样本量，并说明样本量计算依据（power analysis）。',
        section: 'method',
      })
    }

    // 检查统计方法
    if (!methodText.match(/t-test|ANOVA|regression|chi-square|p\s*<|显著性|统计/i)) {
      comments.push({
        id: `rev-${Date.now()}-m2`,
        reviewer: 'expert-1',
        reviewerName: '方法论专家',
        category: 'methodology',
        severity: 'major',
        content: '未明确说明统计分析方法。',
        suggestion: '详细描述使用的统计检验方法、显著性水平和软件工具。',
        section: 'method',
      })
    }

    // 检查对照组
    if (!methodText.match(/control|对照|基线|baseline/i)) {
      comments.push({
        id: `rev-${Date.now()}-m3`,
        reviewer: 'expert-1',
        reviewerName: '方法论专家',
        category: 'methodology',
        severity: 'minor',
        content: '未明确说明是否设置对照组或基线比较。',
        suggestion: '如适用，请说明对照组设置和基线测量方法。',
        section: 'method',
      })
    }

    // 检查可重复性
    if (!methodText.match(/code|dataset|数据|代码|开源|github|available/i)) {
      comments.push({
        id: `rev-${Date.now()}-m4`,
        reviewer: 'expert-1',
        reviewerName: '方法论专家',
        category: 'methodology',
        severity: 'suggestion',
        content: '建议提供代码或数据链接以支持结果的可重复性。',
        suggestion: '在方法部分或附录中提供代码仓库和数据集链接。',
        section: 'method',
      })
    }

    return comments
  }

  private domainReview(paper: PaperContent): ReviewerComment[] {
    const comments: ReviewerComment[] = []
    const introSection = paper.sections.find((s) => s.type === 'introduction')
    const introText = introSection?.content ?? ''

    // 检查文献综述深度
    const citationCount = (introText.match(/\[\d+\]|\(\d{4}\)/g) ?? []).length
    if (citationCount < 5) {
      comments.push({
        id: `rev-${Date.now()}-d1`,
        reviewer: 'expert-2',
        reviewerName: '领域专家',
        category: 'originality',
        severity: 'major',
        content: `文献综述引用较少（仅 ${citationCount} 篇），可能未能充分定位研究在领域中的位置。`,
        suggestion: '增加近期相关文献引用（建议 15-30 篇），明确研究空白。',
        section: 'introduction',
      })
    }

    // 检查相关工作对比
    if (!introText.match(/compared?|对比|比较|vs\.|versus|差异|区别/i)) {
      comments.push({
        id: `rev-${Date.now()}-d2`,
        reviewer: 'expert-2',
        reviewerName: '领域专家',
        category: 'originality',
        severity: 'minor',
        content: '未明确与现有方法的对比分析。',
        suggestion: '增加与 2-3 个代表性方法的详细对比。',
        section: 'introduction',
      })
    }

    // 检查研究空白
    if (!introText.match(/gap|空白|不足|limitation|缺乏|few|little|no.*study/i)) {
      comments.push({
        id: `rev-${Date.now()}-d3`,
        reviewer: 'expert-2',
        reviewerName: '领域专家',
        category: 'significance',
        severity: 'minor',
        content: '未明确说明本研究要解决的具体问题或填补的研究空白。',
        suggestion: '在引言结尾明确陈述研究问题（research question）和动机。',
        section: 'introduction',
      })
    }

    return comments
  }

  private clarityReview(paper: PaperContent): ReviewerComment[] {
    const comments: ReviewerComment[] = []

    // 检查段落长度
    for (const section of paper.sections) {
      const paragraphs = section.content.split(/\n\s*\n/)
      for (const para of paragraphs) {
        if (para.length > 800) {
          comments.push({
            id: `rev-${Date.now()}-c1`,
            reviewer: 'expert-3',
            reviewerName: '写作专家',
            category: 'clarity',
            severity: 'suggestion',
            content: `${section.type} 部分存在过长段落，影响可读性。`,
            suggestion: '将长段落拆分为 3-5 句的短段落。',
            section: section.type,
          })
          break // 每节只报告一次
        }
      }
    }

    // 检查图表引用
    const fullText = paper.sections.map((s) => s.content).join(' ')
    const figureCount = (fullText.match(/Figure\s+\d+|图\s*\d+/gi) ?? []).length
    if (figureCount === 0 && paper.wordCount > 2000) {
      comments.push({
        id: `rev-${Date.now()}-c2`,
        reviewer: 'expert-3',
        reviewerName: '写作专家',
        category: 'structure',
        severity: 'suggestion',
        content: '论文较长但未使用图表辅助说明，可能影响理解。',
        suggestion: '考虑添加 1-2 张图表展示核心结果或流程。',
        section: 'all',
      })
    }

    // 检查缩写定义
    const undefinedAcronyms = this.detectUndefinedAcronyms(fullText)
    for (const acronym of undefinedAcronyms.slice(0, 3)) {
      comments.push({
        id: `rev-${Date.now()}-c3-${acronym}`,
        reviewer: 'expert-3',
        reviewerName: '写作专家',
        category: 'clarity',
        severity: 'minor',
        content: `缩写 "${acronym}" 首次出现时未给出全称。`,
        suggestion: `在首次使用 "${acronym}" 时提供完整名称。`,
        section: 'all',
      })
    }

    return comments
  }

  private devilAdvocateReview(paper: PaperContent): ReviewerComment[] {
    const comments: ReviewerComment[] = []
    const fullText = paper.sections.map((s) => s.content).join(' ')

    // 挑刺：替代解释
    if (fullText.match(/significant|显著|有效|improved|better/i) && !fullText.match(/alternative|替代|其他解释|confounding|混杂/i)) {
      comments.push({
        id: `rev-${Date.now()}-da1`,
        reviewer: 'devil-advocate',
        reviewerName: '魔鬼代言人',
        category: 'methodology',
        severity: 'major',
        content: '作者声称观察到显著效果，但未充分讨论可能的替代解释或混杂因素。',
        suggestion: '增加一节讨论替代解释，并说明为什么本研究的解释更合理。',
        section: 'discussion',
      })
    }

    // 挑刺：局限性
    if (!fullText.match(/limitation|局限|不足|限制|future|future work/i)) {
      comments.push({
        id: `rev-${Date.now()}-da2`,
        reviewer: 'devil-advocate',
        reviewerName: '魔鬼代言人',
        category: 'significance',
        severity: 'major',
        content: '论文未讨论研究局限性，影响结论的可信度。',
        suggestion: '增加局限性讨论，包括样本限制、方法约束和外部效度问题。',
        section: 'discussion',
      })
    }

    // 挑刺：边界条件
    if (!fullText.match(/boundary|边界|条件|适用|generaliz|推广/i)) {
      comments.push({
        id: `rev-${Date.now()}-da3`,
        reviewer: 'devil-advocate',
        reviewerName: '魔鬼代言人',
        category: 'significance',
        severity: 'minor',
        content: '未明确说明研究结果的适用边界条件。',
        suggestion: '讨论结果在何种条件下成立，以及何时可能不适用。',
        section: 'discussion',
      })
    }

    return comments
  }

  // ============================================
  // 评分计算
  // ============================================

  private calculateDimensionScores(
    comments: ReviewerComment[],
    paper: PaperContent
  ): PeerReviewReport['dimensionScores'] {
    const scores = {
      originality: 75,
      methodology: 75,
      significance: 75,
      clarity: 75,
      structure: 75,
    }

    // 根据评论调整分数
    for (const comment of comments) {
      const penalty = this.severityToPenalty(comment.severity)

      switch (comment.category) {
        case 'originality':
          scores.originality -= penalty
          break
        case 'methodology':
          scores.methodology -= penalty
          break
        case 'significance':
          scores.significance -= penalty
          break
        case 'clarity':
          scores.clarity -= penalty
          break
        case 'structure':
          scores.structure -= penalty
          break
      }
    }

    // 根据期刊级别调整基准
    const tierBonus = this.config.targetJournalTier === 'top' ? -10 : this.config.targetJournalTier === 'general' ? 5 : 0

    return {
      originality: Math.max(0, Math.min(100, scores.originality + tierBonus)),
      methodology: Math.max(0, Math.min(100, scores.methodology + tierBonus)),
      significance: Math.max(0, Math.min(100, scores.significance + tierBonus)),
      clarity: Math.max(0, Math.min(100, scores.clarity)),
      structure: Math.max(0, Math.min(100, scores.structure)),
    }
  }

  private severityToPenalty(severity: ReviewerComment['severity']): number {
    switch (severity) {
      case 'major':
        return 8
      case 'minor':
        return 4
      case 'suggestion':
        return 1
      default:
        return 0
    }
  }

  private calculateOverallScore(dimensions: PeerReviewReport['dimensionScores']): number {
    const weights = { originality: 0.25, methodology: 0.25, significance: 0.2, clarity: 0.15, structure: 0.15 }
    let score = 0
    for (const [key, value] of Object.entries(dimensions)) {
      score += value * weights[key as keyof typeof weights]!
    }
    return Math.round(score)
  }

  private scoreToDecision(score: number): PeerReviewReport['decision'] {
    if (score >= 80) return 'accept'
    if (score >= 65) return 'minor-revision'
    if (score >= 50) return 'major-revision'
    return 'reject'
  }

  // ============================================
  // 报告生成
  // ============================================

  private generateMethodologyReview(comments: ReviewerComment[]): PeerReviewReport['methodologyReview'] {
    const methodComments = comments.filter((c) => c.category === 'methodology')
    const issues = methodComments.filter((c) => c.severity === 'major').map((c) => c.content)
    const strengths = methodComments.filter((c) => c.severity === 'suggestion').map((c) => c.content)

    const score = Math.max(0, 75 - issues.length * 8 + strengths.length * 2)

    return {
      score: Math.min(100, score),
      issues: issues.length > 0 ? issues : ['未发现严重方法论问题'],
      strengths: strengths.length > 0 ? strengths : ['方法描述基本完整'],
    }
  }

  private generateEditorSummary(comments: ReviewerComment[], decision: string, score: number): string {
    const majorCount = comments.filter((c) => c.severity === 'major').length
    const minorCount = comments.filter((c) => c.severity === 'minor').length
    const suggestionCount = comments.filter((c) => c.severity === 'suggestion').length

    const decisionText: Record<string, string> = {
      accept: '建议直接接收',
      'minor-revision': '建议小修后接收',
      'major-revision': '建议大修后重新评审',
      reject: '建议拒稿',
    }

    return [
      `综合评分: ${score}/100`,
      `评审决定: ${decisionText[decision] ?? decision}`,
      ``,
      `评审意见统计:`,
      `- 重大问题: ${majorCount} 条`,
      `- 次要问题: ${minorCount} 条`,
      `- 建议: ${suggestionCount} 条`,
      ``,
      `主要关注点:`,
      ...this.extractTopConcerns(comments, 3),
    ].join('\n')
  }

  private extractTopConcerns(comments: ReviewerComment[], limit: number): string[] {
    const sorted = [...comments].sort((a, b) => {
      const severityOrder = { major: 0, minor: 1, suggestion: 2 }
      return severityOrder[a.severity] - severityOrder[b.severity]
    })

    return sorted.slice(0, limit).map((c) => `- [${c.reviewerName}] ${c.content.slice(0, 80)}...`)
  }

  // ============================================
  // 辅助方法
  // ============================================

  private detectUndefinedAcronyms(text: string): string[] {
    const acronyms: string[] = []
    const acronymPattern = /\b([A-Z]{2,5})\b/g
    const matches = text.matchAll(acronymPattern)

    for (const match of matches) {
      const acronym = match[1]!
      // 检查前面是否有全称定义（简单启发式：前面 200 字符内是否有小写版本）
      const pos = match.index ?? 0
      const context = text.slice(Math.max(0, pos - 200), pos)
      const hasDefinition = new RegExp(`\\b${acronym.toLowerCase().split('').join('[^\\s]{0,10}')}\\b`, 'i').test(context) ||
        context.includes('(' + acronym + ')')

      if (!hasDefinition && !['AI', 'ML', 'DL', 'NLP', 'CV', 'IoT', 'API', 'URL', 'DOI', 'PDF', 'HTML', 'CSS', 'JS', 'SQL', 'CPU', 'GPU', 'RAM', 'ROM', 'USB', 'HTTP', 'HTTPS', 'FTP', 'SSH', 'JSON', 'XML', 'CSV', 'USA', 'UK', 'EU', 'UN', 'NASA', 'IBM', 'MIT', 'IEEE', 'ACM', 'PhD', 'MD', 'CEO', 'CTO', 'CFO', 'COO', 'VIP', 'DIY', 'FAQ', 'Q&A', 'PPT', 'APP', 'GPS', 'LED', 'LCD', 'DVD', 'CD', 'TV', 'PC', 'IT', 'OK'].includes(acronym)) {
        if (!acronyms.includes(acronym)) {
          acronyms.push(acronym)
        }
      }
    }

    return acronyms
  }
}

/**
 * 便捷函数：快速模拟同行评审
 */
export function simulatePeerReview(paper: PaperContent, config?: Partial<PeerReviewConfig>): PeerReviewReport {
  const simulator = new PeerReviewSimulator(config)
  return simulator.simulate(paper)
}
