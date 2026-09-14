/**
 * 完整性检查服务 — Stage 2.5 整合器
 *
 * 整合：
 * - 引用验证器 (CitationVerifier)
 * - 数据一致性检查器 (DataConsistencyChecker)
 * - 逻辑漏洞扫描器 (LogicScanner)
 * - AI 使用披露声明生成器
 *
 * 输出：IntegrityReport
 */

import type {
  IntegrityReport,
  CitationCheckResult,
  DataConsistencyIssue,
  LogicGap,
} from '@gravitas/shared'

import {
  CitationVerifier,
  type CitationDatabaseAdapter,
  type ParsedCitation,
} from './citation-verifier'
import { DataConsistencyChecker } from './data-consistency-checker'
import { LogicScanner } from './logic-scanner'

/** 检查输入 */
export interface IntegrityCheckInput {
  paperId: string
  text: string
  tables?: Array<{ id: string; title: string; data: string }>
  figures?: Array<{ id: string; caption: string; data: string }>
  citations?: ParsedCitation[]
  aiAssistedSections?: string[]
}

/** 检查配置 */
export interface IntegrityCheckConfig {
  /** 是否启用引用验证 */
  enableCitationCheck: boolean
  /** 是否启用数据一致性检查 */
  enableDataCheck: boolean
  /** 是否启用逻辑扫描 */
  enableLogicScan: boolean
  /** 是否生成 AI 披露 */
  enableAiDisclosure: boolean
  /** 引用验证配置 */
  citationAdapters?: CitationDatabaseAdapter[]
}

const DEFAULT_CHECK_CONFIG: IntegrityCheckConfig = {
  enableCitationCheck: true,
  enableDataCheck: true,
  enableLogicScan: true,
  enableAiDisclosure: true,
}

// ============================================
// 完整性检查服务
// ============================================

export class IntegrityChecker {
  private config: IntegrityCheckConfig
  private citationVerifier?: CitationVerifier
  private dataChecker = new DataConsistencyChecker()
  private logicScanner = new LogicScanner()

  constructor(config?: Partial<IntegrityCheckConfig>) {
    this.config = { ...DEFAULT_CHECK_CONFIG, ...config }
    if (this.config.enableCitationCheck && this.config.citationAdapters) {
      this.citationVerifier = new CitationVerifier(this.config.citationAdapters)
    }
  }

  /**
   * 执行完整性检查
   */
  async check(input: IntegrityCheckInput): Promise<IntegrityReport> {
    const citations: CitationCheckResult[] = []
    const dataIssues: DataConsistencyIssue[] = []
    const logicGaps: LogicGap[] = []

    // 1. 引用验证
    if (this.config.enableCitationCheck && this.citationVerifier) {
      const toVerify = input.citations ?? this.citationVerifier.extractCitations(input.text)
      citations.push(...await this.citationVerifier.verifyCitations(toVerify))
    }

    // 2. 数据一致性检查
    if (this.config.enableDataCheck) {
      dataIssues.push(...this.dataChecker.check({
        text: input.text,
        tables: input.tables,
        figures: input.figures,
      }))
    }

    // 3. 逻辑漏洞扫描
    if (this.config.enableLogicScan) {
      logicGaps.push(...this.logicScanner.scan(input.text))
    }

    // 4. 生成 AI 披露声明
    const aiDisclosure = this.config.enableAiDisclosure
      ? this.generateAiDisclosure(input.aiAssistedSections ?? [])
      : ''

    // 5. 计算总体评分
    const overallScore = this.calculateScore(citations, dataIssues, logicGaps)
    const isSubmittable = overallScore >= 80 &&
      !citations.some((c) => !c.isValid) &&
      !dataIssues.some((d) => d.severity === 'error') &&
      !logicGaps.some((g) => g.severity === 'major')

    return {
      paperId: input.paperId,
      checkedAt: Date.now(),
      citations,
      dataIssues,
      logicGaps,
      aiDisclosure,
      overallScore,
      isSubmittable,
    }
  }

  /**
   * 生成 AI 使用披露声明
   */
  generateAiDisclosure(aiAssistedSections: string[]): string {
    if (aiAssistedSections.length === 0) {
      return '本研究未使用人工智能工具辅助撰写。'
    }

    const sections = aiAssistedSections.join('、')
    return [
      'AI 使用披露声明：',
      `在本文的撰写过程中，作者使用了人工智能工具辅助以下部分：${sections}。`,
      'AI 工具主要用于：文本润色、语法检查、格式整理。',
      '所有研究设计、数据分析、结论解释均由作者独立完成。',
      '作者对本文内容的准确性和完整性负全部责任。',
    ].join('\n')
  }

  // ============================================
  // 评分计算
  // ============================================

  private calculateScore(
    citations: CitationCheckResult[],
    dataIssues: DataConsistencyIssue[],
    logicGaps: LogicGap[]
  ): number {
    let score = 100

    // 引用扣分
    const invalidCitations = citations.filter((c) => !c.isValid).length
    score -= invalidCitations * 5

    // 数据问题扣分
    const dataErrors = dataIssues.filter((d) => d.severity === 'error').length
    const dataWarnings = dataIssues.filter((d) => d.severity === 'warning').length
    score -= dataErrors * 8
    score -= dataWarnings * 2

    // 逻辑漏洞扣分
    const majorGaps = logicGaps.filter((g) => g.severity === 'major').length
    const minorGaps = logicGaps.filter((g) => g.severity === 'minor').length
    score -= majorGaps * 6
    score -= minorGaps * 2

    return Math.max(0, Math.min(100, score))
  }
}

/**
 * 便捷函数：快速检查论文完整性
 */
export async function checkPaperIntegrity(
  input: IntegrityCheckInput,
  config?: Partial<IntegrityCheckConfig>
): Promise<IntegrityReport> {
  const checker = new IntegrityChecker(config)
  return checker.check(input)
}
