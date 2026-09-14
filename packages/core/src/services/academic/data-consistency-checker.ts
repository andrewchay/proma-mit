/**
 * 数据一致性检查器 — 统计数字、图表与正文匹配
 *
 * 检查项：
 * - 数字一致性：正文中引用的数字与表格/图表中的数字是否一致
 * - 单位一致性：全文单位是否统一
 * - 引用完整性：正文引用的图表/表格是否实际存在
 * - 计算正确性：简单数学运算验证
 */

import type { DataConsistencyIssue } from '@gravitas/shared'

/** 提取的数据点 */
export interface DataPoint {
  value: number | string
  unit?: string
  context: string
  location: string
  type: 'text' | 'table' | 'figure'
}

/** 检查配置 */
export interface DataConsistencyConfig {
  /** 数值容差（百分比） */
  tolerancePercent: number
  /** 是否检查单位一致性 */
  checkUnits: boolean
  /** 是否验证计算 */
  verifyCalculations: boolean
}

const DEFAULT_CONFIG: DataConsistencyConfig = {
  tolerancePercent: 1,
  checkUnits: true,
  verifyCalculations: true,
}

// ============================================
// 数据一致性检查器
// ============================================

export class DataConsistencyChecker {
  private config: DataConsistencyConfig

  constructor(config?: Partial<DataConsistencyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 检查论文数据一致性
   */
  check(paper: {
    text: string
    tables?: Array<{ id: string; title: string; data: string }>
    figures?: Array<{ id: string; caption: string; data: string }>
  }): DataConsistencyIssue[] {
    const issues: DataConsistencyIssue[] = []

    // 1. 提取所有数据点
    const textData = this.extractDataFromText(paper.text)
    const tableData = this.extractDataFromTables(paper.tables ?? [])
    const figureData = this.extractDataFromFigures(paper.figures ?? [])

    // 2. 检查正文与表格一致性
    issues.push(...this.checkTextTableConsistency(textData, tableData))

    // 3. 检查正文与图表一致性
    issues.push(...this.checkTextFigureConsistency(textData, figureData))

    // 4. 检查单位一致性
    if (this.config.checkUnits) {
      issues.push(...this.checkUnitConsistency([...textData, ...tableData, ...figureData]))
    }

    // 5. 检查引用完整性（正文引用的表格/图表是否存在）
    issues.push(...this.checkReferenceIntegrity(paper.text, paper.tables ?? [], paper.figures ?? []))

    // 6. 验证简单计算
    if (this.config.verifyCalculations) {
      issues.push(...this.verifyCalculationsInText(paper.text))
    }

    return issues
  }

  // ============================================
  // 数据提取
  // ============================================

  private extractDataFromText(text: string): DataPoint[] {
    const points: DataPoint[] = []

    // 提取百分比
    const percentPattern = /(\d+\.?\d*)\s*%/g
    for (const match of text.matchAll(percentPattern)) {
      points.push({
        value: parseFloat(match[1]!),
        unit: '%',
        context: match[0]!,
        location: `text:${match.index}`,
        type: 'text',
      })
    }

    // 提取带单位的数字（如 3.5 kg, 100 mL）
    const unitPattern = /(\d+\.?\d*)\s*(kg|mg|g|mL|L|cm|mm|m|°C|h|min|s|MPa|kPa|Pa|W|kW|J|kJ|eV|nm|μm|Hz|kHz|MHz|GHz)/gi
    for (const match of text.matchAll(unitPattern)) {
      points.push({
        value: parseFloat(match[1]!),
        unit: match[2]!.toLowerCase(),
        context: match[0]!,
        location: `text:${match.index}`,
        type: 'text',
      })
    }

    // 提取纯数字（大于 10 的，避免误匹配年份）
    const numberPattern = /\b(\d{2,}(?:\.\d+)?)\b/g
    for (const match of text.matchAll(numberPattern)) {
      const num = parseFloat(match[1]!)
      if (num > 2000 || num < 1900) { // 排除年份
        points.push({
          value: num,
          context: match[0]!,
          location: `text:${match.index}`,
          type: 'text',
        })
      }
    }

    return points
  }

  private extractDataFromTables(tables: Array<{ id: string; title: string; data: string }>): DataPoint[] {
    const points: DataPoint[] = []

    for (const table of tables) {
      // 从表格内容中提取数字
      const numberPattern = /(\d+\.?\d*)\s*(%|kg|mg|g|mL|L|cm|mm|m|°C|h|min|s)?/gi
      for (const match of table.data.matchAll(numberPattern)) {
        points.push({
          value: parseFloat(match[1]!),
          unit: match[2] ? match[2].toLowerCase() : undefined,
          context: match[0]!,
          location: `table:${table.id}`,
          type: 'table',
        })
      }
    }

    return points
  }

  private extractDataFromFigures(figures: Array<{ id: string; caption: string; data: string }>): DataPoint[] {
    const points: DataPoint[] = []

    for (const figure of figures) {
      // 从图表标题和描述中提取数字
      const combined = figure.caption + ' ' + figure.data
      const numberPattern = /(\d+\.?\d*)\s*(%|kg|mg|g|mL|L|cm|mm|m|°C|h|min|s)?/gi
      for (const match of combined.matchAll(numberPattern)) {
        points.push({
          value: parseFloat(match[1]!),
          unit: match[2] ? match[2].toLowerCase() : undefined,
          context: match[0]!,
          location: `figure:${figure.id}`,
          type: 'figure',
        })
      }
    }

    return points
  }

  // ============================================
  // 一致性检查
  // ============================================

  private checkTextTableConsistency(textData: DataPoint[], tableData: DataPoint[]): DataConsistencyIssue[] {
    const issues: DataConsistencyIssue[] = []

    for (const textPoint of textData) {
      if (typeof textPoint.value !== 'number') continue

      // 在表格中查找相同或相近的值
      for (const tablePoint of tableData) {
        if (typeof tablePoint.value !== 'number') continue
        if (textPoint.unit && tablePoint.unit && textPoint.unit !== tablePoint.unit) continue

        const diff = Math.abs(textPoint.value - tablePoint.value)
        const maxVal = Math.max(Math.abs(textPoint.value), Math.abs(tablePoint.value))
        const percentDiff = maxVal === 0 ? 0 : (diff / maxVal) * 100

        // 如果数值接近但不完全相等（在容差范围内），可能是四舍五入差异
        if (percentDiff > 0 && percentDiff <= this.config.tolerancePercent) {
          // 容差内，不报告
          continue
        }

        // 如果数值差异较大但上下文相似，报告不匹配
        if (this.valuesMightReferToSameThing(textPoint, tablePoint)) {
          if (diff > 0.01) {
            issues.push({
              id: `dt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              type: 'number-mismatch',
              description: `正文数值 ${textPoint.value}${textPoint.unit ?? ''} 与表格数值 ${tablePoint.value}${tablePoint.unit ?? ''} 不一致`,
              location: `${textPoint.location} vs ${tablePoint.location}`,
              severity: 'error',
            })
          }
        }
      }
    }

    return issues
  }

  private checkTextFigureConsistency(textData: DataPoint[], figureData: DataPoint[]): DataConsistencyIssue[] {
    // 与表格检查逻辑类似
    const issues: DataConsistencyIssue[] = []

    for (const textPoint of textData) {
      if (typeof textPoint.value !== 'number') continue

      for (const figPoint of figureData) {
        if (typeof figPoint.value !== 'number') continue
        if (textPoint.unit && figPoint.unit && textPoint.unit !== figPoint.unit) continue

        if (this.valuesMightReferToSameThing(textPoint, figPoint)) {
          const diff = Math.abs(textPoint.value - figPoint.value)
          if (diff > 0.01) {
            issues.push({
              id: `df-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              type: 'number-mismatch',
              description: `正文数值 ${textPoint.value}${textPoint.unit ?? ''} 与图表数值 ${figPoint.value}${figPoint.unit ?? ''} 不一致`,
              location: `${textPoint.location} vs ${figPoint.location}`,
              severity: 'error',
            })
          }
        }
      }
    }

    return issues
  }

  private checkUnitConsistency(allData: DataPoint[]): DataConsistencyIssue[] {
    const issues: DataConsistencyIssue[] = []
    const unitGroups = new Map<string, DataPoint[]>()

    // 按单位分组
    for (const point of allData) {
      if (!point.unit) continue
      const group = unitGroups.get(point.unit) ?? []
      group.push(point)
      unitGroups.set(point.unit, group)
    }

    // 检查常见单位混用
    const unitAliases: Record<string, string[]> = {
      kg: ['g', 'mg'],
      m: ['cm', 'mm'],
      l: ['ml'],
    }

    for (const [baseUnit, aliases] of Object.entries(unitAliases)) {
      const baseGroup = unitGroups.get(baseUnit)
      if (!baseGroup) continue

      for (const alias of aliases) {
        const aliasGroup = unitGroups.get(alias)
        if (aliasGroup && aliasGroup.length > 0) {
          // 检查是否在同一上下文中混用
          issues.push({
            id: `unit-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
            type: 'unit-inconsistent',
            description: `单位混用: 同时出现 ${baseUnit} 和 ${alias}，建议统一`,
            location: `${baseGroup[0]!.location}, ${aliasGroup[0]!.location}`,
            severity: 'warning',
          })
        }
      }
    }

    return issues
  }

  private checkReferenceIntegrity(
    text: string,
    tables: Array<{ id: string; title: string; data: string }>,
    figures: Array<{ id: string; caption: string; data: string }>
  ): DataConsistencyIssue[] {
    const issues: DataConsistencyIssue[] = []

    // 检查正文引用的表格是否存在
    const tableRefs = Array.from(text.matchAll(/Table\s+(\d+)|表\s*(\d+)/gi))
    const referencedTableIds = new Set<string>()
    for (const match of tableRefs) {
      const num = match[1] || match[2]
      if (num) referencedTableIds.add(`table-${num}`)
    }

    const existingTableIds = new Set(tables.map((t) => t.id))
    for (const refId of referencedTableIds) {
      if (!existingTableIds.has(refId)) {
        const tableNum = refId.replace('table-', '')
        issues.push({
          id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'missing-reference',
          description: `正文引用了 Table ${tableNum}，但该表格未找到`,
          location: `text`,
          severity: 'error',
        })
      }
    }

    // 检查正文引用的图表是否存在
    const figureRefs = Array.from(text.matchAll(/Figure\s+(\d+)|图\s*(\d+)/gi))
    const referencedFigureIds = new Set<string>()
    for (const match of figureRefs) {
      const num = match[1] || match[2]
      if (num) referencedFigureIds.add(`figure-${num}`)
    }

    const existingFigureIds = new Set(figures.map((f) => f.id))
    for (const refId of referencedFigureIds) {
      if (!existingFigureIds.has(refId)) {
        const figureNum = refId.replace('figure-', '')
        issues.push({
          id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'missing-reference',
          description: `正文引用了 Figure ${figureNum}，但该图表未找到`,
          location: `text`,
          severity: 'error',
        })
      }
    }

    return issues
  }

  private verifyCalculationsInText(text: string): DataConsistencyIssue[] {
    const issues: DataConsistencyIssue[] = []

    // 检查常见的计算模式："A + B = C" 或 "C = A + B"
    const calcPattern = /(\d+\.?\d*)\s*\+\s*(\d+\.?\d*)\s*=\s*(\d+\.?\d*)/g
    for (const match of text.matchAll(calcPattern)) {
      const a = parseFloat(match[1]!)
      const b = parseFloat(match[2]!)
      const c = parseFloat(match[3]!)
      const expected = a + b
      const diff = Math.abs(c - expected)
      if (diff > 0.01) {
        issues.push({
          id: `calc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'number-mismatch',
          description: `计算错误: ${a} + ${b} = ${expected}，但文中写为 ${c}`,
          location: `text:${match.index}`,
          severity: 'error',
        })
      }
    }

    // 检查百分比计算："X of Y is Z%"
    const percentCalcPattern = /(\d+\.?\d*)\s+of\s+(\d+\.?\d*)\s+is\s+(\d+\.?\d*)\s*%/gi
    for (const match of text.matchAll(percentCalcPattern)) {
      const part = parseFloat(match[1]!)
      const total = parseFloat(match[2]!)
      const statedPercent = parseFloat(match[3]!)
      const expectedPercent = (part / total) * 100
      const diff = Math.abs(statedPercent - expectedPercent)
      if (diff > 0.5) { // 百分比容差 0.5%
        issues.push({
          id: `calc-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          type: 'number-mismatch',
          description: `百分比计算错误: ${part} of ${total} = ${expectedPercent.toFixed(1)}%，但文中写为 ${statedPercent}%`,
          location: `text:${match.index}`,
          severity: 'error',
        })
      }
    }

    return issues
  }

  // ============================================
  // 辅助方法
  // ============================================

  private valuesMightReferToSameThing(a: DataPoint, b: DataPoint): boolean {
    // 简单启发式：如果数值接近（差异 < 20%）且单位相同，可能指向同一数据
    if (typeof a.value !== 'number' || typeof b.value !== 'number') return false
    if (a.unit && b.unit && a.unit !== b.unit) return false

    const maxVal = Math.max(Math.abs(a.value), Math.abs(b.value))
    if (maxVal === 0) return true

    const diff = Math.abs(a.value - b.value)
    return (diff / maxVal) < 0.2
  }
}
