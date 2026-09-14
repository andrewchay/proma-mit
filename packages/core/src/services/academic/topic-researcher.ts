/**
 * 选题研究服务 — Stage 1 科研选题评估与可行性分析
 *
 * 功能：
 * - 选题创新性评估（与现有文献对比）
 * - 可行性分析（资源、时间、技术可行性）
 * - 研究价值评估（学术价值、应用价值）
 * - 文献空白识别
 * - 选题报告生成
 */

/** 研究选题 */
export interface ResearchTopic {
  id: string
  title: string
  description: string
  keywords: string[]
  field: string // 研究领域
  subField?: string
  proposedMethods: string[]
  expectedOutcomes: string[]
  timelineMonths: number
  requiredResources: string[]
}

/** 现有文献条目 */
export interface ExistingLiterature {
  title: string
  authors: string[]
  year: number
  journal?: string
  abstract: string
  keywords: string[]
  doi?: string
}

/** 选题评估结果 */
export interface TopicAssessment {
  topic: ResearchTopic
  novelty: {
    score: number // 0-10
    similarWorks: Array<{
      title: string
      similarity: number
      gap: string
    }>
    gaps: string[]
  }
  feasibility: {
    score: number
    resourceRisk: 'low' | 'medium' | 'high'
    timeRisk: 'low' | 'medium' | 'high'
    techRisk: 'low' | 'medium' | 'high'
    concerns: string[]
  }
  value: {
    academicScore: number
    applicationScore: number
    overallScore: number
  }
  recommendation: 'proceed' | 'refine' | 'pivot' | 'abandon'
  suggestions: string[]
}

/** 选题报告 */
export interface TopicResearchReport {
  topic: ResearchTopic
  assessment: TopicAssessment
  literatureReview: {
    totalReviewed: number
    keyFindings: string[]
    identifiedGaps: string[]
  }
  finalRecommendation: string
  nextSteps: string[]
}

// ============================================
// 选题研究服务
// ============================================

export class TopicResearcher {
  /**
   * 评估选题
   */
  assess(topic: ResearchTopic, existingLiterature: ExistingLiterature[]): TopicAssessment {
    const novelty = this.assessNovelty(topic, existingLiterature)
    const feasibility = this.assessFeasibility(topic)
    const value = this.assessValue(topic, novelty, feasibility)

    const { recommendation, suggestions } = this.generateRecommendation(novelty, feasibility, value)

    return {
      topic,
      novelty,
      feasibility,
      value,
      recommendation,
      suggestions,
    }
  }

  /**
   * 生成完整选题报告
   */
  generateReport(topic: ResearchTopic, existingLiterature: ExistingLiterature[]): TopicResearchReport {
    const assessment = this.assess(topic, existingLiterature)

    const keyFindings = this.extractKeyFindings(existingLiterature, topic.keywords)
    const identifiedGaps = assessment.novelty.gaps

    const nextSteps = this.generateNextSteps(assessment)

    const finalRecommendation = this.formatFinalRecommendation(assessment)

    return {
      topic,
      assessment,
      literatureReview: {
        totalReviewed: existingLiterature.length,
        keyFindings,
        identifiedGaps,
      },
      finalRecommendation,
      nextSteps,
    }
  }

  /**
   * 批量评估多个选题
   */
  assessBatch(topics: ResearchTopic[], existingLiterature: ExistingLiterature[]): TopicAssessment[] {
    return topics.map((t) => this.assess(t, existingLiterature))
  }

  /**
   * 导出报告为 Markdown
   */
  exportReportToMarkdown(report: TopicResearchReport): string {
    const a = report.assessment
    const lines: string[] = [
      `# 选题研究报告：${report.topic.title}`,
      '',
      `> 研究领域: ${report.topic.field} | 建议: ${this.recommendationLabel(a.recommendation)}`,
      '',
      '## 选题概述',
      '',
      report.topic.description,
      '',
      '**关键词**: ' + report.topic.keywords.join(', '),
      '',
      '**预期方法**: ' + report.topic.proposedMethods.join(', '),
      '',
      '## 创新性评估',
      '',
      `- **创新性评分**: ${a.novelty.score}/10`,
      `- **相似研究数量**: ${a.novelty.similarWorks.length}`,
      '',
    ]

    if (a.novelty.similarWorks.length > 0) {
      lines.push('### 相似研究', '')
      for (const sw of a.novelty.similarWorks.slice(0, 5)) {
        lines.push(`- **${sw.title}**（相似度: ${Math.round(sw.similarity * 100)}%）`)
        lines.push(`  差异点: ${sw.gap}`)
      }
      lines.push('')
    }

    if (a.novelty.gaps.length > 0) {
      lines.push('### 识别到的空白', '')
      for (const gap of a.novelty.gaps) {
        lines.push(`- ${gap}`)
      }
      lines.push('')
    }

    lines.push(
      '## 可行性分析',
      '',
      `- **可行性评分**: ${a.feasibility.score}/10`,
      `- **资源风险**: ${this.riskLabel(a.feasibility.resourceRisk)}`,
      `- **时间风险**: ${this.riskLabel(a.feasibility.timeRisk)}`,
      `- **技术风险**: ${this.riskLabel(a.feasibility.techRisk)}`,
      '',
    )

    if (a.feasibility.concerns.length > 0) {
      lines.push('### 主要顾虑', '')
      for (const concern of a.feasibility.concerns) {
        lines.push(`- ⚠️ ${concern}`)
      }
      lines.push('')
    }

    lines.push(
      '## 研究价值',
      '',
      `- **学术价值**: ${a.value.academicScore}/10`,
      `- **应用价值**: ${a.value.applicationScore}/10`,
      `- **综合评分**: ${a.value.overallScore}/10`,
      '',
    )

    lines.push('## 文献回顾', '')
    lines.push(`- **回顾文献数**: ${report.literatureReview.totalReviewed}`)
    lines.push('')

    if (report.literatureReview.keyFindings.length > 0) {
      lines.push('### 关键发现', '')
      for (const finding of report.literatureReview.keyFindings.slice(0, 5)) {
        lines.push(`- ${finding}`)
      }
      lines.push('')
    }

    lines.push('## 建议', '')
    for (const suggestion of a.suggestions) {
      lines.push(`- ${suggestion}`)
    }
    lines.push('')

    lines.push('## 下一步', '')
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`)
    }
    lines.push('')

    return lines.join('\n')
  }

  // ---------- 内部评估方法 ----------

  private assessNovelty(topic: ResearchTopic, literature: ExistingLiterature[]): TopicAssessment['novelty'] {
    const similarWorks: TopicAssessment['novelty']['similarWorks'] = []
    const topicKeywords = new Set(topic.keywords.map((k) => k.toLowerCase()))

    for (const paper of literature) {
      const paperKeywords = new Set(paper.keywords.map((k) => k.toLowerCase()))
      const intersection = new Set([...topicKeywords].filter((k) => paperKeywords.has(k)))
      const union = new Set([...topicKeywords, ...paperKeywords])
      const similarity = union.size > 0 ? intersection.size / union.size : 0

      if (similarity > 0.3) {
        const gap = this.identifyGap(topic, paper)
        similarWorks.push({
          title: paper.title,
          similarity: Math.round(similarity * 100) / 100,
          gap,
        })
      }
    }

    // 排序：相似度高的在前
    similarWorks.sort((a, b) => b.similarity - a.similarity)

    // 识别空白
    const gaps = this.identifyLiteratureGaps(topic, literature, similarWorks)

    // 创新性评分：相似度越低、空白越多 = 分越高
    const avgSimilarity = similarWorks.length > 0
      ? similarWorks.reduce((s, w) => s + w.similarity, 0) / similarWorks.length
      : 0
    const noveltyScore = Math.min(10, Math.round((10 - avgSimilarity * 9 + gaps.length * 0.3) * 10) / 10)

    return {
      score: Math.max(1, noveltyScore),
      similarWorks: similarWorks.slice(0, 10),
      gaps,
    }
  }

  private assessFeasibility(topic: ResearchTopic): TopicAssessment['feasibility'] {
    const concerns: string[] = []

    // 时间风险
    let timeRisk: TopicAssessment['feasibility']['timeRisk'] = 'low'
    if (topic.timelineMonths > 24) {
      timeRisk = 'high'
      concerns.push('研究周期超过 2 年，存在延期风险')
    } else if (topic.timelineMonths > 12) {
      timeRisk = 'medium'
      concerns.push('研究周期较长，需合理规划里程碑')
    }

    // 资源风险
    let resourceRisk: TopicAssessment['feasibility']['resourceRisk'] = 'low'
    if (topic.requiredResources.length > 5) {
      resourceRisk = 'high'
      concerns.push('所需资源种类较多，协调难度大')
    } else if (topic.requiredResources.length > 3) {
      resourceRisk = 'medium'
    }

    // 技术风险
    let techRisk: TopicAssessment['feasibility']['techRisk'] = 'low'
    const complexMethods = ['深度学习', '分布式', '实时系统', '量子计算', '大规模']
    const complexCount = topic.proposedMethods.filter((m) => complexMethods.some((c) => m.includes(c))).length
    if (complexCount >= 2) {
      techRisk = 'high'
      concerns.push('涉及多项复杂技术方法，技术实现风险较高')
    } else if (complexCount === 1) {
      techRisk = 'medium'
      concerns.push('涉及复杂技术方法，需确保团队具备相关能力')
    }

    // 可行性评分
    const riskScores = { low: 3, medium: 2, high: 1 }
    const feasibilityScore = Math.round(
      ((riskScores[timeRisk] + riskScores[resourceRisk] + riskScores[techRisk]) / 9) * 10 * 10
    ) / 10

    return {
      score: feasibilityScore,
      resourceRisk,
      timeRisk,
      techRisk,
      concerns,
    }
  }

  private assessValue(
    topic: ResearchTopic,
    novelty: TopicAssessment['novelty'],
    feasibility: TopicAssessment['feasibility']
  ): TopicAssessment['value'] {
    // 学术价值：创新性 + 方法严谨性
    const methodScore = topic.proposedMethods.length >= 2 ? 2 : 0
    const academicScore = Math.min(10, Math.round((novelty.score * 0.6 + methodScore + 3) * 10) / 10)

    // 应用价值：预期成果 + 领域热度
    const outcomeScore = topic.expectedOutcomes.length >= 2 ? 3 : topic.expectedOutcomes.length === 1 ? 1 : 0
    const applicationScore = Math.min(10, Math.round((outcomeScore + 5) * 10) / 10)

    // 综合：学术 50% + 应用 30% + 可行 20%
    const overallScore = Math.round(
      (academicScore * 0.5 + applicationScore * 0.3 + feasibility.score * 0.2) * 10
    ) / 10

    return {
      academicScore,
      applicationScore,
      overallScore,
    }
  }

  private generateRecommendation(
    novelty: TopicAssessment['novelty'],
    feasibility: TopicAssessment['feasibility'],
    value: TopicAssessment['value']
  ): { recommendation: TopicAssessment['recommendation']; suggestions: string[] } {
    const suggestions: string[] = []
    let recommendation: TopicAssessment['recommendation']

    if (novelty.score >= 7 && feasibility.score >= 6 && value.overallScore >= 7) {
      recommendation = 'proceed'
      suggestions.push('选题质量良好，建议推进')
    } else if (novelty.score < 4) {
      recommendation = 'pivot'
      suggestions.push('创新性不足，建议调整研究方向或聚焦更细分的空白领域')
    } else if (feasibility.score < 4) {
      recommendation = 'refine'
      suggestions.push('可行性偏低，建议缩小研究范围或延长周期')
      if (feasibility.timeRisk === 'high') suggestions.push('考虑将研究拆分为多个阶段')
      if (feasibility.resourceRisk === 'high') suggestions.push('寻找合作方或申请额外资源')
    } else if (value.overallScore < 5) {
      recommendation = 'refine'
      suggestions.push('研究价值不够突出，建议明确应用场景或理论贡献')
    } else {
      recommendation = 'proceed'
      suggestions.push('选题基本可行，但需关注薄弱环节')
    }

    if (novelty.gaps.length > 0) {
      suggestions.push(`聚焦文献空白: ${novelty.gaps[0]}`)
    }

    if (feasibility.concerns.length > 0) {
      suggestions.push('制定风险应对预案')
    }

    return { recommendation, suggestions }
  }

  // ---------- 辅助方法 ----------

  private identifyGap(topic: ResearchTopic, paper: ExistingLiterature): string {
    const gaps: string[] = []

    // 方法差异
    const methodOverlap = topic.proposedMethods.some((m) =>
      paper.abstract.toLowerCase().includes(m.toLowerCase())
    )
    if (!methodOverlap) {
      gaps.push('采用不同研究方法')
    }

    // 时间差异（较新的研究）
    if (paper.year < new Date().getFullYear() - 3) {
      gaps.push('该研究较旧，可能未覆盖最新进展')
    }

    // 范围差异
    if (topic.subField && !paper.abstract.toLowerCase().includes(topic.subField.toLowerCase())) {
      gaps.push('研究子领域不同')
    }

    return gaps.length > 0 ? gaps.join('；') : '研究角度或应用场景不同'
  }

  private identifyLiteratureGaps(
    topic: ResearchTopic,
    literature: ExistingLiterature[],
    similarWorks: TopicAssessment['novelty']['similarWorks']
  ): string[] {
    const gaps: string[] = []

    // 如果相似研究很少，说明领域较新
    if (similarWorks.length < 3) {
      gaps.push('该方向现有研究较少，属于新兴领域')
    }

    // 检查方法空白
    const coveredMethods = new Set<string>()
    for (const paper of literature) {
      for (const method of topic.proposedMethods) {
        if (paper.abstract.toLowerCase().includes(method.toLowerCase())) {
          coveredMethods.add(method)
        }
      }
    }
    const uncoveredMethods = topic.proposedMethods.filter((m) => !coveredMethods.has(m))
    if (uncoveredMethods.length > 0) {
      gaps.push(`现有文献未充分使用以下方法: ${uncoveredMethods.join(', ')}`)
    }

    // 检查近期文献
    const recentPapers = literature.filter((p) => p.year >= new Date().getFullYear() - 2)
    if (recentPapers.length < 5) {
      gaps.push('近期（2年内）相关研究较少')
    }

    // 检查预期成果空白
    for (const outcome of topic.expectedOutcomes) {
      const covered = literature.some((p) => p.abstract.toLowerCase().includes(outcome.toLowerCase().slice(0, 10)))
      if (!covered) {
        gaps.push(`预期成果「${outcome}」在现有文献中较少涉及`)
      }
    }

    return gaps.slice(0, 5)
  }

  private extractKeyFindings(literature: ExistingLiterature[], topicKeywords: string[]): string[] {
    const findings: string[] = []

    // 统计高频主题
    const keywordCount = new Map<string, number>()
    for (const paper of literature) {
      for (const kw of paper.keywords) {
        keywordCount.set(kw, (keywordCount.get(kw) ?? 0) + 1)
      }
    }

    const topKeywords = Array.from(keywordCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)

    if (topKeywords.length > 0) {
      findings.push(`领域热点: ${topKeywords.map(([k]) => k).join(', ')}`)
    }

    // 最新进展
    const latest = literature.filter((p) => p.year >= new Date().getFullYear() - 1)
    if (latest.length > 0) {
      findings.push(`近一年有 ${latest.length} 篇相关新发表文献`)
    }

    return findings
  }

  private generateNextSteps(assessment: TopicAssessment): string[] {
    const steps: string[] = []

    if (assessment.recommendation === 'proceed') {
      steps.push('撰写详细研究计划书')
      steps.push('确定导师/合作者')
      steps.push('申请所需资源')
    } else if (assessment.recommendation === 'refine') {
      steps.push('根据评估建议调整选题范围')
      steps.push('重新评估可行性后再次提交')
    } else if (assessment.recommendation === 'pivot') {
      steps.push('重新检索文献，寻找更细分的空白领域')
      steps.push('与导师讨论方向调整')
    }

    steps.push('建立文献管理库（Zotero / Mendeley）')
    steps.push('制定阅读计划，深入理解相关研究')

    return steps
  }

  private formatFinalRecommendation(assessment: TopicAssessment): string {
    const labels: Record<TopicAssessment['recommendation'], string> = {
      proceed: '建议推进',
      refine: '需要完善',
      pivot: '建议调整方向',
      abandon: '建议放弃',
    }

    return `${labels[assessment.recommendation]}（创新性: ${assessment.novelty.score}/10, 可行性: ${assessment.feasibility.score}/10, 综合价值: ${assessment.value.overallScore}/10）`
  }

  private recommendationLabel(rec: TopicAssessment['recommendation']): string {
    const labels: Record<TopicAssessment['recommendation'], string> = {
      proceed: '✅ 建议推进',
      refine: '⚠️ 需要完善',
      pivot: '🔄 建议调整方向',
      abandon: '❌ 建议放弃',
    }
    return labels[rec]
  }

  private riskLabel(risk: 'low' | 'medium' | 'high'): string {
    const labels = { low: '🟢 低', medium: '🟡 中', high: '🔴 高' }
    return labels[risk]
  }
}

/**
 * 便捷函数
 */
export function createTopicResearcher(): TopicResearcher {
  return new TopicResearcher()
}
