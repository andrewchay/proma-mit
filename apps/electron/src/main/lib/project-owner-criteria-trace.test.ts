import { expect, test } from 'bun:test'
import type { ProjectOwnerGoalBrief, ProjectOwnerPlanStep } from '@gravitas/shared'
import { assessCriteriaCoverage, parseCriteriaTrace } from './project-owner-criteria-trace'

function goal(overrides: Partial<ProjectOwnerGoalBrief> = {}): ProjectOwnerGoalBrief {
  return {
    projectId: 'p', goalVersion: 1,
    objective: '制作一份中文盘点工作单，打印后供志愿者现场使用',
    constraints: ['A4纸，四边15毫米'],
    acceptanceCriteria: ['打印后为一页', '四个书架逐架复点', '预留签字空间'],
    codeSourceAccess: 'none',
    ...overrides,
  }
}

function step(key: string): ProjectOwnerPlanStep {
  return { key, title: '标题', outcome: '成果', acceptanceCriteria: ['标准'], dependencies: [], roleKey: 'r' }
}

const steps = [step('sheet'), step('review')]

test('Given 硬要求逐条登记 When 解析追溯 Then 接受并保留来源与检验方式', () => {
  const trace = parseCriteriaTrace([
    { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: ['A4纸与四边15毫米边距'] },
    { key: 'c2', source: 'objective', sourceIndex: 0, sourceText: '志愿者现场使用', criticality: 'advisory', stepKey: 'review', verification: 'manual_review', assumptions: [] },
  ], goal(), steps)
  expect(trace).toHaveLength(2)
  expect(trace[0]).toMatchObject({ key: 'c1', source: 'acceptance', sourceIndex: 0, criticality: 'critical', stepKey: 'sheet', verification: 'automated' })
  expect(trace[0]!.assumptions).toEqual(['A4纸与四边15毫米边距'])
})

/** 满足「objective 必须被承接」的最小前缀，便于各用例聚焦自身校验。 */
const OBJECTIVE_ITEM = { key: 'c0', source: 'objective' as const, sourceIndex: 0, sourceText: '志愿者现场使用', criticality: 'critical' as const, stepKey: 'review', verification: 'manual_review' as const }

test('Given 模型虚构来源原文 When 解析追溯 Then 拒绝，不得凭空发明硬要求', () => {
  for (const sourceText of ['打印后为两页', '必须使用彩色打印', '']) {
    expect(() => parseCriteriaTrace([
      OBJECTIVE_ITEM,
      { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText, criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: [] },
    ], goal(), steps)).toThrow()
  }
})

test('Given 来源下标越界或指向不存在步骤 When 解析追溯 Then 拒绝', () => {
  const base = { key: 'c1', source: 'acceptance' as const, sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical' as const, verification: 'automated' as const, assumptions: [] }
  expect(() => parseCriteriaTrace([OBJECTIVE_ITEM, { ...base, sourceIndex: 9 }], goal(), steps)).toThrow()
  expect(() => parseCriteriaTrace([OBJECTIVE_ITEM, { ...base, stepKey: 'ghost' }], goal(), steps)).toThrow()
  // objective 只允许下标 0
  expect(() => parseCriteriaTrace([OBJECTIVE_ITEM, { ...base, source: 'objective', sourceIndex: 1, sourceText: '志愿者现场使用' }], goal(), steps)).toThrow()
})

test('Given 模型省略 assumptions When 解析追溯 Then 等价于空数组而非报错', () => {
  // 真实模型对没有默认条件的条目会直接不写该字段；这不算错误。
  const trace = parseCriteriaTrace([
    { key: 'c0', source: 'objective', sourceIndex: 0, sourceText: '制作一份中文盘点工作单', criticality: 'critical', stepKey: 'sheet', verification: 'manual_review' },
    { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'manual_review' },
  ], goal(), steps)
  expect(trace).toHaveLength(2)
  expect(trace[1]!.assumptions).toEqual([])
})

test('Given 目标正文没有任何步骤承接 When 解析追溯 Then 拒绝，计划未对准用户真正要的东西', () => {
  // 真实模型两次运行中曾漏掉 objective（「两名志愿者」），这条规则把漏项变成硬失败。
  expect(() => parseCriteriaTrace([
    { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: [] },
  ], goal(), steps)).toThrow('目标正文未被任何步骤承接')
  // 存在 objective 条目即放行，不要求覆盖整句。
  expect(() => parseCriteriaTrace([
    { key: 'c0', source: 'objective', sourceIndex: 0, sourceText: '志愿者现场使用', criticality: 'critical', stepKey: 'review', verification: 'manual_review', assumptions: [] },
  ], goal(), steps)).not.toThrow()
  // 目标正文为空白时不强制。
  expect(() => parseCriteriaTrace([
    { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: [] },
  ], goal({ objective: '   ' }), steps)).not.toThrow()
})

test('Given 追溯键重复或字段非法 When 解析追溯 Then 拒绝', () => {
  const item = { key: 'c1', source: 'acceptance' as const, sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical' as const, stepKey: 'sheet', verification: 'automated' as const, assumptions: [] }
  expect(() => parseCriteriaTrace([item, item], goal(), steps)).toThrow('重复')
  expect(() => parseCriteriaTrace([{ ...item, criticality: 'blocker' }], goal(), steps)).toThrow()
  expect(() => parseCriteriaTrace([{ ...item, verification: 'trust_me' }], goal(), steps)).toThrow()
  expect(() => parseCriteriaTrace([{ ...item, extra: 1 }], goal(), steps)).toThrow('未知字段')
  expect(() => parseCriteriaTrace([], goal(), steps)).toThrow()
})

test('Given 只登记部分硬要求 When 评估覆盖 Then 报告未覆盖项与关键缺口', () => {
  const trace = parseCriteriaTrace([
    OBJECTIVE_ITEM,
    { key: 'c1', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'unverified', assumptions: [] },
  ], goal(), steps)
  const coverage = assessCriteriaCoverage(goal(), trace)
  // constraint 与另外两条 acceptance 未承接；objective 已由 OBJECTIVE_ITEM 承接
  expect(coverage.uncovered.map((item) => `${item.source}:${item.sourceIndex}`).sort())
    .toEqual(['acceptance:1', 'acceptance:2', 'constraint:0'])
  expect(coverage.criticalUncovered).toBe(3)
  expect(coverage.unverified.map((item) => item.key)).toEqual(['c1'])
})

test('Given 全部硬要求已承接 When 评估覆盖 Then 无关键缺口，未验证项单独列出', () => {
  const trace = parseCriteriaTrace([
    { key: 'c0', source: 'objective', sourceIndex: 0, sourceText: '制作一份中文盘点工作单', criticality: 'critical', stepKey: 'sheet', verification: 'manual_review', assumptions: [] },
    { key: 'c1', source: 'constraint', sourceIndex: 0, sourceText: '四边15毫米', criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: [] },
    { key: 'c2', source: 'acceptance', sourceIndex: 0, sourceText: '打印后为一页', criticality: 'critical', stepKey: 'sheet', verification: 'automated', assumptions: [] },
    { key: 'c3', source: 'acceptance', sourceIndex: 1, sourceText: '四个书架逐架复点', criticality: 'critical', stepKey: 'review', verification: 'manual_review', assumptions: [] },
    { key: 'c4', source: 'acceptance', sourceIndex: 2, sourceText: '预留签字空间', criticality: 'advisory', stepKey: 'review', verification: 'unverified', assumptions: [] },
  ], goal(), steps)
  const coverage = assessCriteriaCoverage(goal(), trace)
  expect(coverage.uncovered).toEqual([])
  expect(coverage.criticalUncovered).toBe(0)
  expect(coverage.unverified.map((item) => item.key)).toEqual(['c4'])
})

test('Given 目标来源为空字符串 When 评估覆盖 Then 空白来源不计入基数', () => {
  const sparse = goal({ constraints: ['', '  '], acceptanceCriteria: [] })
  const coverage = assessCriteriaCoverage(sparse, [])
  expect(coverage.uncovered.map((item) => `${item.source}:${item.sourceIndex}`)).toEqual(['objective:0'])
})
