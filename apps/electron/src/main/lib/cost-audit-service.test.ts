import { describe, expect, test } from 'bun:test'
import { costAuditToText } from './cost-audit-service'
import type { CostAuditReport } from './cost-audit-service'

/**
 * PH2-C 费用审计文本化测试。
 * runCostAudit 依赖 token-usage-service（electron 依赖），在 bun 单测下不可加载；
 * 此处直接用合成 report 验证 costAuditToText 的格式与告警分支。
 */

function sampleReport(overrides: Partial<CostAuditReport> = {}): CostAuditReport {
  return {
    windowStart: 0,
    windowEnd: 86400000,
    totalCost: 1.25,
    totalTokens: 50000,
    previousTotalCost: 0.5,
    costChangeRatio: 2.5,
    byModel: [{ modelId: 'deepseek-v4-flash', costTotal: 1.0 }],
    byWorkspace: [{ workspaceId: 'ws-1', costTotal: 1.25 }],
    topSessions: [{ sessionId: 'session-abc', costTotal: 0.8 }],
    alerts: [],
    hasAlerts: false,
    ...overrides,
  }
}

describe('费用审计文本（PH2-C）', () => {
  test('正常报告生成可读文本', () => {
    const text = costAuditToText(sampleReport())
    expect(text).toContain('费用审计')
    expect(text).toContain('$1.250')
    expect(text).toContain('deepseek-v4-flash')
    expect(text).toContain('无异常告警')
  })

  test('有告警时展示告警列表', () => {
    const text = costAuditToText(sampleReport({
      alerts: ['费用环比增长 150%'],
      hasAlerts: true,
    }))
    expect(text).toContain('⚠ 告警')
    expect(text).toContain('费用环比增长 150%')
  })

  test('Top 会话与模型分布显示', () => {
    const text = costAuditToText(sampleReport())
    expect(text).toContain('Top 会话')
    expect(text).toContain('$0.800')
  })
})
