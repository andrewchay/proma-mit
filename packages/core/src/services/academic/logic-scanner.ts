/**
 * 逻辑漏洞扫描器 — 论证链条完整性检查
 *
 * 检查项：
 * - 缺失前提：结论缺少必要的前提支撑
 * - 弱推理：从前提无法有效推出结论
 * - 未检验假设：隐含假设未明确说明
 * - 循环论证：结论被用作自己的前提
 * - 矛盾检测：前后文出现矛盾陈述
 */

import type { LogicGap } from '@gravitas/shared'

/** 论证段落 */
export interface ArgumentSegment {
  id: string
  text: string
  type: 'premise' | 'conclusion' | 'assumption' | 'evidence' | 'method'
}

/** 扫描配置 */
export interface LogicScannerConfig {
  /** 最小前提数量要求 */
  minPremisesForConclusion: number
  /** 是否检查循环论证 */
  checkCircularReasoning: boolean
  /** 是否检查矛盾 */
  checkContradictions: boolean
}

const DEFAULT_CONFIG: LogicScannerConfig = {
  minPremisesForConclusion: 1,
  checkCircularReasoning: true,
  checkContradictions: true,
}

// 逻辑连接词模式
const CONCLUSION_MARKERS = [
  '因此', '所以', '综上所述', '由此可知', '这表明', '这说明',
  'therefore', 'thus', 'hence', 'consequently', 'this suggests', 'this indicates',
  'in conclusion', 'we conclude', 'it follows that',
]

const PREMISE_MARKERS = [
  '因为', '由于', '基于', '根据', '鉴于',
  'because', 'since', 'given that', 'based on', 'as',
]

const ASSUMPTION_MARKERS = [
  '假设', '假定', '预设', '默认',
  'assume', 'assuming', 'suppose', 'presumably',
]

// ============================================
// 逻辑漏洞扫描器
// ============================================

export class LogicScanner {
  private config: LogicScannerConfig

  constructor(config?: Partial<LogicScannerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 扫描论文逻辑漏洞
   */
  scan(paperText: string): LogicGap[] {
    const gaps: LogicGap[] = []

    // 1. 将文本分割为段落
    const paragraphs = this.splitIntoParagraphs(paperText)

    // 2. 识别论证结构
    const segments = this.identifySegments(paragraphs)

    // 3. 检查缺失前提
    gaps.push(...this.checkMissingPremises(segments))

    // 4. 检查弱推理
    gaps.push(...this.checkWeakInference(segments))

    // 5. 检查未检验假设
    gaps.push(...this.checkUntestedAssumptions(segments))

    // 6. 检查循环论证
    if (this.config.checkCircularReasoning) {
      gaps.push(...this.checkCircularReasoning(segments))
    }

    // 7. 检查矛盾
    if (this.config.checkContradictions) {
      gaps.push(...this.checkContradictions(paragraphs))
    }

    return gaps
  }

  // ============================================
  // 文本分割与识别
  // ============================================

  private splitIntoParagraphs(text: string): Array<{ id: string; text: string }> {
    return text
      .split(/\n+/)
      .map((p, i) => ({ id: `para-${i}`, text: p.trim() }))
      .filter((p) => p.text.length > 10)
  }

  private identifySegments(paragraphs: Array<{ id: string; text: string }>): ArgumentSegment[] {
    const segments: ArgumentSegment[] = []

    for (const para of paragraphs) {
      const text = para.text

      // 检查是否是结论
      if (CONCLUSION_MARKERS.some((m) => text.includes(m))) {
        segments.push({ id: para.id, text, type: 'conclusion' })
        continue
      }

      // 检查是否是前提
      if (PREMISE_MARKERS.some((m) => text.includes(m))) {
        segments.push({ id: para.id, text, type: 'premise' })
        continue
      }

      // 检查是否是假设
      if (ASSUMPTION_MARKERS.some((m) => text.includes(m))) {
        segments.push({ id: para.id, text, type: 'assumption' })
        continue
      }

      // 检查是否是方法
      if (text.includes('方法') || text.includes('method') || text.includes('approach')) {
        segments.push({ id: para.id, text, type: 'method' })
        continue
      }

      // 默认作为证据
      segments.push({ id: para.id, text, type: 'evidence' })
    }

    return segments
  }

  // ============================================
  // 具体检查项
  // ============================================

  private checkMissingPremises(segments: ArgumentSegment[]): LogicGap[] {
    const gaps: LogicGap[] = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      if (seg.type !== 'conclusion') continue

      // 查找前面的前提
      let premiseCount = 0
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (segments[j]!.type === 'premise' || segments[j]!.type === 'evidence') {
          premiseCount++
        }
      }

      if (premiseCount < this.config.minPremisesForConclusion) {
        gaps.push({
          id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'missing-premise',
          description: `结论段落缺少充分的前提支撑（仅找到 ${premiseCount} 个支撑段落）`,
          location: seg.id,
          severity: 'major',
        })
      }
    }

    return gaps
  }

  private checkWeakInference(segments: ArgumentSegment[]): LogicGap[] {
    const gaps: LogicGap[] = []

    for (const seg of segments) {
      // 检查结论中是否使用了限定词（可能暗示推理不够强）
      const weakWords = ['可能', '也许', '大概', '或许', 'might', 'maybe', 'perhaps', 'possibly']
      const hasWeakWords = weakWords.some((w) => seg.text.includes(w))

      // 检查是否有量化证据支撑
      const hasQuantitativeEvidence = /\d+\.?\d*\s*%|\d+\.?\d*\s*(samples?|participants?|subjects?|p\s*[<>=]\s*\d?\.\d+)/i.test(seg.text)

      if (hasWeakWords && !hasQuantitativeEvidence) {
        gaps.push({
          id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'weak-inference',
          description: `结论使用模糊表述但缺乏量化证据支撑，推理强度不足`,
          location: seg.id,
          severity: 'minor',
        })
      }
    }

    return gaps
  }

  private checkUntestedAssumptions(segments: ArgumentSegment[]): LogicGap[] {
    const gaps: LogicGap[] = []

    // 收集所有显式假设
    const explicitAssumptions = segments
      .filter((s) => s.type === 'assumption')
      .map((s) => s.text)

    for (const seg of segments) {
      if (seg.type !== 'conclusion' && seg.type !== 'premise' && seg.type !== 'evidence') continue

      // 检测隐含的"代表性"假设
      const representativePatterns = [
        /样本.*代表.*总体/,
        /sample.*representative/,
        /结果.*推广/,
        /generalize/,
      ]

      for (const pattern of representativePatterns) {
        if (pattern.test(seg.text)) {
          // 检查是否有对应的假设说明
          const hasAssumption = explicitAssumptions.some((a) =>
            a.includes('代表') || a.includes('representative') || a.includes('generaliz')
          )

          if (!hasAssumption) {
            gaps.push({
              id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              type: 'untested-assumption',
              description: `文中提到代表性/推广性但未明确说明相关假设，建议补充代表性检验`,
              location: seg.id,
              severity: 'major',
            })
          }
        }
      }

      // 检测隐含的"因果"假设
      const causalPatterns = [
        /导致|引起|造成/,
        /lead to|cause|result in/,
      ]

      for (const pattern of causalPatterns) {
        if (pattern.test(seg.text)) {
          const hasCausalAssumption = explicitAssumptions.some((a) =>
            a.includes('因果') || a.includes('causal') || a.includes('confounding')
          )

          if (!hasCausalAssumption) {
            gaps.push({
              id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              type: 'untested-assumption',
              description: `文中做出因果推断但未明确说明因果假设，建议讨论混杂因素`,
              location: seg.id,
              severity: 'major',
            })
          }
        }
      }
    }

    return gaps
  }

  private checkCircularReasoning(segments: ArgumentSegment[]): LogicGap[] {
    const gaps: LogicGap[] = []

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      if (seg.type !== 'conclusion') continue

      // 检查前面的段落是否使用了相同的短语作为前提
      for (let j = Math.max(0, i - 3); j < i; j++) {
        const prevSeg = segments[j]!
        // 简单检查：计算结论与前提的字符重叠度
        const conclusionCore = seg.text
          .replace(/因此|所以|综上所述|由此可知|这表明|这说明|therefore|thus|hence|consequently/gi, '')
          .replace(/^[，。！？、；：“”''（）\[\]【】\s]+/, '')
          .trim()
          .slice(0, 60)

        // 提取结论中的中文字符（去除标点和空格）
        const conclusionChars = [...conclusionCore].filter((c) => /[\u4e00-\u9fa5a-zA-Z]/.test(c))
        const prevChars = [...prevSeg.text].filter((c) => /[\u4e00-\u9fa5a-zA-Z]/.test(c))

        // 计算重叠字符比例
        let overlapCount = 0
        for (const char of conclusionChars) {
          if (prevChars.includes(char)) overlapCount++
        }

        const overlapRatio = conclusionChars.length > 0 ? overlapCount / conclusionChars.length : 0

        if (conclusionChars.length >= 6 && overlapRatio >= 0.7 && prevSeg.type === 'premise') {
          gaps.push({
            id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            type: 'circular-reasoning',
            description: `可能存在循环论证: 结论的核心表述与前提高度重叠`,
            location: `${prevSeg.id} -> ${seg.id}`,
            severity: 'major',
          })
        }
      }
    }

    return gaps
  }

  private checkContradictions(paragraphs: Array<{ id: string; text: string }>): LogicGap[] {
    const gaps: LogicGap[] = []

    // 提取各段落中的数值断言
    const assertions: Array<{ id: string; value: number; unit?: string; isPositive: boolean }> = []

    for (const para of paragraphs) {
      // 检测"增加/减少"断言
      const increaseMatch = para.text.match(/(增加|提高|上升|增长|improved|increased|enhanced).*?(\d+\.?\d*)\s*(%)?/i)
      const decreaseMatch = para.text.match(/(减少|降低|下降|decreased|reduced|declined).*?(\d+\.?\d*)\s*(%)?/i)

      if (increaseMatch) {
        assertions.push({
          id: para.id,
          value: parseFloat(increaseMatch[2]!),
          unit: increaseMatch[3] || undefined,
          isPositive: true,
        })
      }
      if (decreaseMatch) {
        assertions.push({
          id: para.id,
          value: parseFloat(decreaseMatch[2]!),
          unit: decreaseMatch[3] || undefined,
          isPositive: false,
        })
      }
    }

    // 检查同一数值在不同段落中被同时描述为增加和减少
    for (let i = 0; i < assertions.length; i++) {
      for (let j = i + 1; j < assertions.length; j++) {
        const a = assertions[i]!
        const b = assertions[j]!

        if (a.value === b.value && a.unit === b.unit && a.isPositive !== b.isPositive) {
          gaps.push({
            id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            type: 'missing-premise',
            description: `矛盾检测: 同一数值 ${a.value}${a.unit ?? ''} 在不同段落中被同时描述为增加和减少`,
            location: `${a.id} vs ${b.id}`,
            severity: 'major',
          })
        }
      }
    }

    return gaps
  }
}
