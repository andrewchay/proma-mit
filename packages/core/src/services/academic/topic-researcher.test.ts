/**
 * 选题研究服务测试
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import { TopicResearcher, createTopicResearcher } from './topic-researcher'
import type { ResearchTopic, ExistingLiterature } from './topic-researcher'

// ============================================
// 辅助函数
// ============================================

function createTopic(overrides?: Partial<ResearchTopic>): ResearchTopic {
  return {
    id: 'topic-1',
    title: '基于大语言模型的个性化学习助手研究',
    description: '探索如何利用 LLM 构建自适应学习系统',
    keywords: ['LLM', '个性化学习', '教育技术', '自适应系统'],
    field: '教育技术',
    subField: '智能 tutoring',
    proposedMethods: ['实验研究', '用户调研', '系统开发'],
    expectedOutcomes: ['学习效果提升 20%', '用户满意度 > 4.0'],
    timelineMonths: 18,
    requiredResources: ['GPU 服务器', '被试学生', '开发团队'],
    ...overrides,
  }
}

function createLiterature(count = 5): ExistingLiterature[] {
  const base: ExistingLiterature[] = [
    {
      title: 'A Survey on Large Language Models for Education',
      authors: ['Smith', 'Jones'],
      year: 2023,
      journal: 'Educational Technology',
      abstract: 'This paper surveys LLM applications in education, including tutoring and assessment.',
      keywords: ['LLM', 'education', 'survey'],
      doi: '10.1234/edu.2023.001',
    },
    {
      title: 'Personalized Learning with AI: A Case Study',
      authors: ['Wang', 'Li'],
      year: 2022,
      journal: 'AI in Education',
      abstract: 'Case study on using AI for personalized learning paths in K-12.',
      keywords: ['personalized learning', 'AI', 'K-12'],
      doi: '10.1234/aied.2022.045',
    },
    {
      title: 'Adaptive Systems for Higher Education',
      authors: ['Chen', 'Zhang'],
      year: 2021,
      journal: 'Higher Ed Tech',
      abstract: 'Review of adaptive learning systems in university settings.',
      keywords: ['adaptive systems', 'higher education'],
    },
    {
      title: 'ChatGPT in Classroom: Opportunities and Risks',
      authors: ['Brown', 'Davis'],
      year: 2024,
      journal: 'Digital Learning',
      abstract: 'Analysis of ChatGPT usage patterns among students.',
      keywords: ['ChatGPT', 'classroom', 'risks'],
      doi: '10.1234/dl.2024.012',
    },
    {
      title: 'Intelligent Tutoring Systems: A Meta-Analysis',
      authors: ['Miller', 'Wilson'],
      year: 2020,
      journal: 'Review of EdTech',
      abstract: 'Meta-analysis of ITS effectiveness across 50 studies.',
      keywords: ['intelligent tutoring', 'meta-analysis'],
    },
  ]
  return base.slice(0, count)
}

// ============================================
// TopicResearcher 测试
// ============================================

describe('TopicResearcher', () => {
  let researcher: TopicResearcher

  beforeEach(() => {
    researcher = new TopicResearcher()
  })

  // ---------- 创新性评估 ----------

  it('should assess novelty with similar works', () => {
    const topic = createTopic({ keywords: ['LLM', 'education', 'survey'] })
    const literature = createLiterature()

    const assessment = researcher.assess(topic, literature)

    expect(assessment.novelty.similarWorks.length).toBeGreaterThan(0)
    expect(assessment.novelty.score).toBeGreaterThan(0)
    expect(assessment.novelty.score).toBeLessThanOrEqual(10)
  })

  it('should identify literature gaps', () => {
    const topic = createTopic()
    const literature = createLiterature()

    const assessment = researcher.assess(topic, literature)

    expect(assessment.novelty.gaps.length).toBeGreaterThan(0)
  })

  it('should give higher novelty for unique topics', () => {
    const uniqueTopic = createTopic({
      title: '量子计算在诗歌生成中的应用',
      keywords: ['量子计算', '诗歌生成', 'NLP'],
      proposedMethods: ['量子算法', '生成模型'],
    })
    const literature = createLiterature()

    const assessment = researcher.assess(uniqueTopic, literature)
    // 与现有文献关键词重叠少，创新性应较高
    expect(assessment.novelty.score).toBeGreaterThanOrEqual(5)
  })

  // ---------- 可行性评估 ----------

  it('should assess feasibility', () => {
    const topic = createTopic()
    const literature = createLiterature()

    const assessment = researcher.assess(topic, literature)

    expect(assessment.feasibility.score).toBeGreaterThan(0)
    expect(assessment.feasibility.score).toBeLessThanOrEqual(10)
    expect(assessment.feasibility.timeRisk).toBeDefined()
    expect(assessment.feasibility.resourceRisk).toBeDefined()
    expect(assessment.feasibility.techRisk).toBeDefined()
  })

  it('should flag high time risk for long timelines', () => {
    const longTopic = createTopic({ timelineMonths: 30 })
    const assessment = researcher.assess(longTopic, [])

    expect(assessment.feasibility.timeRisk).toBe('high')
    expect(assessment.feasibility.concerns.some((c) => c.includes('周期'))).toBe(true)
  })

  it('should flag high resource risk for many resources', () => {
    const resourceHeavy = createTopic({
      requiredResources: ['A', 'B', 'C', 'D', 'E', 'F'],
    })
    const assessment = researcher.assess(resourceHeavy, [])

    expect(assessment.feasibility.resourceRisk).toBe('high')
  })

  it('should flag tech risk for complex methods', () => {
    const complexTopic = createTopic({
      proposedMethods: ['深度学习'], // only 1 complex method → medium
    })
    const assessment = researcher.assess(complexTopic, [])

    expect(assessment.feasibility.techRisk).toBe('medium')
    expect(assessment.feasibility.concerns.some((c) => c.includes('复杂'))).toBe(true)
  })

  // ---------- 价值评估 ----------

  it('should assess value', () => {
    const topic = createTopic()
    const literature = createLiterature()

    const assessment = researcher.assess(topic, literature)

    expect(assessment.value.academicScore).toBeGreaterThan(0)
    expect(assessment.value.applicationScore).toBeGreaterThan(0)
    expect(assessment.value.overallScore).toBeGreaterThan(0)
  })

  // ---------- 推荐 ----------

  it('should recommend proceed for good topics', () => {
    const goodTopic = createTopic({
      title: '全新领域研究',
      keywords: ['全新', '未探索', '前沿'],
      proposedMethods: ['实验', '分析'],
      timelineMonths: 12,
      requiredResources: ['实验室'],
    })
    const assessment = researcher.assess(goodTopic, [])

    expect(assessment.recommendation).toBe('proceed')
    expect(assessment.suggestions.length).toBeGreaterThan(0)
  })

  it('should recommend refine for low feasibility', () => {
    const hardTopic = createTopic({
      timelineMonths: 36,
      requiredResources: ['A', 'B', 'C', 'D', 'E', 'F'], // > 5 for high resourceRisk
      proposedMethods: ['深度学习', '分布式系统', '量子计算'],
    })
    const assessment = researcher.assess(hardTopic, [])

    expect(['refine', 'pivot', 'abandon']).toContain(assessment.recommendation)
  })

  it('should recommend pivot for low novelty', () => {
    const unoriginal = createTopic({
      title: 'A Survey on Large Language Models for Education',
      keywords: ['LLM', 'education', 'survey'],
    })
    const literature = createLiterature()
    const assessment = researcher.assess(unoriginal, literature)

    expect(assessment.recommendation).toBe('pivot')
  })

  // ---------- 报告生成 ----------

  it('should generate full report', () => {
    const topic = createTopic()
    const literature = createLiterature()

    const report = researcher.generateReport(topic, literature)

    expect(report.topic.id).toBe('topic-1')
    expect(report.assessment).toBeDefined()
    expect(report.literatureReview.totalReviewed).toBe(5)
    expect(report.literatureReview.keyFindings.length).toBeGreaterThan(0)
    expect(report.nextSteps.length).toBeGreaterThan(0)
    expect(report.finalRecommendation).toContain('/10')
  })

  // ---------- 批量评估 ----------

  it('should assess batch of topics', () => {
    const topics = [
      createTopic({ id: 't1', title: 'Topic A' }),
      createTopic({ id: 't2', title: 'Topic B' }),
    ]
    const literature = createLiterature()

    const results = researcher.assessBatch(topics, literature)
    expect(results.length).toBe(2)
    expect(results[0]!.topic.id).toBe('t1')
    expect(results[1]!.topic.id).toBe('t2')
  })

  // ---------- Markdown 导出 ----------

  it('should export report to markdown', () => {
    const topic = createTopic()
    const literature = createLiterature()
    const report = researcher.generateReport(topic, literature)
    const md = researcher.exportReportToMarkdown(report)

    expect(md).toContain('# 选题研究报告：')
    expect(md).toContain('## 选题概述')
    expect(md).toContain('## 创新性评估')
    expect(md).toContain('## 可行性分析')
    expect(md).toContain('## 研究价值')
    expect(md).toContain('## 文献回顾')
    expect(md).toContain('## 建议')
    expect(md).toContain('## 下一步')
  })

  // ---------- 便捷函数 ----------

  it('should work with createTopicResearcher helper', () => {
    const r = createTopicResearcher()
    const assessment = r.assess(createTopic(), createLiterature())
    expect(assessment.topic.id).toBe('topic-1')
  })
})
