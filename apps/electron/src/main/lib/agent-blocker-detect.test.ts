/**
 * Agent 卡点检测测试 — Agent Blocker Detect Test
 *
 * agent 自述无法完成（elicitation 信号）→ 识别卡点 → 任务转待人决策而非交付。
 */
import { describe, expect, test } from 'bun:test'
import { detectAgentBlocker } from './agent-employee-service'

describe('agent 卡点检测（elicitation 信号）', () => {
  test('Given 自述无法完成 When 检测 Then 命中卡点', () => {
    expect(detectAgentBlocker('任务无法完成，缺少数据库访问凭证')).toBe('无法完成')
    expect(detectAgentBlocker('我卡在等待 API 权限审批')).toBe('卡在')
    expect(detectAgentBlocker('需要您确认交付格式后再继续')).not.toBeNull()
    expect(detectAgentBlocker('权限不足，无法访问目标目录')).toBe('权限不足')
  })

  test('Given 正常完成说明 When 检测 Then 不误报', () => {
    expect(detectAgentBlocker('已完成数据分析，产出报告见 workspace-files/agents/a1/report.md')).toBeNull()
    expect(detectAgentBlocker('完成了代码重构，测试全部通过')).toBeNull()
    expect(detectAgentBlocker('执行完成（无摘要）')).toBeNull()
  })

  test('Given 空摘要 When 检测 Then 返回 null', () => {
    expect(detectAgentBlocker('')).toBeNull()
  })
})
