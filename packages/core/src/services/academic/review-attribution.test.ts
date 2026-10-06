import { describe, expect, test } from 'bun:test'

/**
 * 审查来源归属测试（M7.3）：
 * - 模型建议强制降级（不得为 error），且必须记录模型与理由
 * - 规则检查必须给规则名与实测值（否则无法复核）
 * - 分组呈现不合并计数
 */

const {
  ResearchError,
  assertNoLlmErrors,
  findingSourceLabel,
  groupFindingsByKind,
  isAssertiveFinding,
  makeLlmFinding,
  makeRuleFinding,
  summarizeFindings,
} = await import('@gravitas/core/services/academic')

describe('规则检查发现', () => {
  test('必须提供规则名与实测值', () => {
    expect(() =>
      makeRuleFinding({ id: 'r1', message: '摘要过短', rule: '', measured: '132' }),
    ).toThrow('规则名与实测值')

    const finding = makeRuleFinding({
      id: 'r1', message: '摘要过短', rule: 'abstract-min-length',
      measured: '132 字符', expected: '≥150 字符', severity: 'warning',
    })
    expect(finding.kind).toBe('rule-lint')
    expect(isAssertiveFinding(finding)).toBe(true)
    expect(findingSourceLabel(finding)).toContain('abstract-min-length')
  })

  test('允许 error 严重度（确定性检查可断言）', () => {
    const finding = makeRuleFinding({
      id: 'r2', message: '引用 DOI 未解析', rule: 'citation-doi-resolvable',
      measured: 'unresolved', severity: 'error',
    })
    expect(finding.severity).toBe('error')
  })
})

describe('模型建议发现', () => {
  test('即使传入 error 也被强制降级为 warning', () => {
    const finding = makeLlmFinding({
      id: 'l1', message: '建议加强方法部分', model: 'gpt-x', rationale: '与同类研究相比缺少样本量论证',
      severity: 'error',
    })
    expect(finding.kind).toBe('llm-suggestion')
    expect(finding.severity).toBe('warning')
    // 模型意见不是确定性事实
    expect(isAssertiveFinding(finding)).toBe(false)
    expect(findingSourceLabel(finding)).toContain('未经复核')
  })

  test('缺模型或理由时拒绝（否则无法追溯）', () => {
    expect(() =>
      makeLlmFinding({ id: 'l2', message: 'x', model: '', rationale: 'r' }),
    ).toThrow('模型标识')
    expect(() =>
      makeLlmFinding({ id: 'l3', message: 'x', model: 'm', rationale: ' ' }),
    ).toThrow('理由')
  })

  test('断言批次中不存在被标为 error 的模型建议', () => {
    expect(() =>
      assertNoLlmErrors([
        makeRuleFinding({ id: 'r', message: 'm', rule: 'x', measured: 'y', severity: 'error' }),
      ]),
    ).not.toThrow()

    // 构造一条被篡改的发现（绕过工厂）应被断言拦下
    expect(() =>
      assertNoLlmErrors([
        {
          id: 'bad', kind: 'llm-suggestion', severity: 'error', message: 'x',
          basis: { model: 'm', rationale: 'r' }, createdAt: 'x',
        },
      ]),
    ).toThrow('不得标为 error')
  })
})

describe('分组与计数', () => {
  const findings = [
    makeRuleFinding({ id: 'r1', message: 'a', rule: 'x', measured: '1', severity: 'error' }),
    makeRuleFinding({ id: 'r2', message: 'b', rule: 'y', measured: '2', severity: 'warning' }),
    makeLlmFinding({ id: 'l1', message: 'c', model: 'm1', rationale: 'r' }),
    makeLlmFinding({ id: 'l2', message: 'd', model: 'm2', rationale: 'r', severity: 'warning' }),
  ]

  test('按来源分组，不混在一起', () => {
    const grouped = groupFindingsByKind(findings)
    expect(grouped.ruleLint).toHaveLength(2)
    expect(grouped.llmSuggestions).toHaveLength(2)
  })

  test('计数分别统计（不合成总数混淆来源）', () => {
    const summary = summarizeFindings(findings)
    expect(summary.ruleLint.error).toBe(1)
    expect(summary.ruleLint.warning).toBe(1)
    expect(summary.llmSuggestions).toBe(2)
  })

  test('错误类型为领域错误', () => {
    try {
      makeLlmFinding({ id: 'x', message: 'x', model: '', rationale: '' })
    } catch (err) {
      expect(err).toBeInstanceOf(ResearchError)
    }
  })
})
