import { expect, test } from 'bun:test'
import { accumulateRetainedCandidates, describeSpecificationDrift, narrowStepScope, resolveRetainedStepReuse } from './project-owner-retained-step-reuse'

const step = (overrides: Partial<Parameters<typeof resolveRetainedStepReuse>[0][number]> = {}) => ({
  key: 'spec',
  title: '形成规格',
  outcome: '输出可执行的规格说明',
  acceptanceCriteria: ['覆盖全部角色', '包含验收标准'],
  roleKey: 'planner',
  deliveryKind: 'text' as const,
  ...overrides,
})

test('Given新方案仍列出已验收步骤且规格一致 When解析复用 Then只复用该步骤', () => {
  const result = resolveRetainedStepReuse(
    [step(), step({ key: 'build', title: '实现页面', roleKey: 'engineer' })],
    [{ taskId: 'task-spec', stepKey: 'spec', projection: step() }],
  )
  expect(result.reuse).toEqual([{ stepKey: 'spec', taskId: 'task-spec' }])
  expect(result.changed).toEqual([])
})

test('Given新方案收紧了验收标准 When解析复用 Then拒绝复用并说明原因', () => {
  const result = resolveRetainedStepReuse(
    [step({ acceptanceCriteria: ['覆盖全部角色', '包含验收标准', '附回归用例'] })],
    [{ taskId: 'task-spec', stepKey: 'spec', projection: step() }],
  )
  expect(result.reuse).toEqual([])
  expect(result.changed).toEqual([{ stepKey: 'spec', reason: '验收标准已变化' }])
})

test('Given验收标准顺序不同但内容一致 When解析复用 Then仍复用', () => {
  const result = resolveRetainedStepReuse(
    [step({ acceptanceCriteria: ['包含验收标准', '覆盖全部角色'] })],
    [{ taskId: 'task-spec', stepKey: 'spec', projection: step() }],
  )
  expect(result.reuse).toEqual([{ stepKey: 'spec', taskId: 'task-spec' }])
})

test('Given新方案未选中旧步骤 When解析复用 Then既不模拟复用也不报变化', () => {
  const result = resolveRetainedStepReuse(
    [step({ key: 'build', title: '实现页面', roleKey: 'engineer' })],
    [{ taskId: 'task-spec', stepKey: 'spec', projection: step() }],
  )
  expect(result).toEqual({ reuse: [], changed: [] })
})

test('Given岗位或交付类型变化 When解析复用 Then拒绝复用', () => {
  expect(resolveRetainedStepReuse([step({ roleKey: 'engineer' })], [{ taskId: 't', stepKey: 'spec', projection: step() }]).changed)
    .toEqual([{ stepKey: 'spec', reason: '岗位由 planner 变为 engineer' }])
  expect(resolveRetainedStepReuse([step({ deliveryKind: 'development' })], [{ taskId: 't', stepKey: 'spec', projection: step() }]).changed)
    .toEqual([{ stepKey: 'spec', reason: '交付类型已变化' }])
})

test('Given规格完全一致 When比对 Then返回null', () => {
  expect(describeSpecificationDrift(step(), step())).toBeNull()
})

test('Given已验收步骤仍在新方案 When收窄范围 Then只留下需要重做的步骤', () => {
  const result = narrowStepScope(
    [
      { ...step(), dependencies: [] },
      { ...step({ key: 'build', title: '实现页面' }), dependencies: ['spec'] },
    ],
    [{ stepKey: 'spec', taskId: 'task-spec' }],
  )
  expect(result.steps.map((item) => item.key)).toEqual(['build'])
  // 依赖已验收成果被移除，否则材料化会因「依赖不在本次闭包」拒绝。
  expect(result.steps[0]!.dependencies).toEqual([])
  expect(result.reused).toEqual([{ stepKey: 'spec', taskId: 'task-spec' }])
})

test('Given全部步骤都已验收 When收窄范围 Then不剩任何待做步骤', () => {
  const result = narrowStepScope([{ ...step(), dependencies: [] }], [{ stepKey: 'spec', taskId: 'task-spec' }])
  expect(result.steps).toEqual([])
})

test('Given没有任何复用 When收窄范围 Then范围与依赖都不变', () => {
  const incoming = [{ ...step(), dependencies: [] }, { ...step({ key: 'build' }), dependencies: ['spec'] }]
  expect(narrowStepScope(incoming, [])).toEqual({ steps: incoming, reused: [] })
})

// 连续恢复时同一步骤可能在多个旧批次里都有验收记录。
// 后批次的成果必须覆盖前批次，否则下游会拿到过期正文。
test('Given同一步骤有多份候选 When解析复用 Then采用最后一份', () => {
  const result = resolveRetainedStepReuse(
    [step()],
    [
      { taskId: 'task-old', stepKey: 'spec', projection: step() },
      { taskId: 'task-new', stepKey: 'spec', projection: step() },
    ],
  )
  expect(result.reuse).toEqual([{ stepKey: 'spec', taskId: 'task-new' }])
  expect(result.changed).toEqual([])
})

// ===== P1-2：新任务未通过验收必须使旧候选失效 =====

const occurrence = (overrides: Partial<Parameters<typeof accumulateRetainedCandidates>[0][number][number]> = {}) => ({
  taskId: 'task-old', stepKey: 'spec', accepted: true,
  title: '形成规格', outcome: '输出规格', acceptanceCriteria: ['范围明确'], roleKey: 'planner',
  deliveryKind: 'text' as const,
  ...overrides,
})

test('Given旧批次已验收且新批次同名步骤失败 When累积 Then该步骤不可复用', () => {
  const result = accumulateRetainedCandidates([
    [occurrence()],
    [occurrence({ taskId: 'task-retry', accepted: false })],
  ])
  expect(result).toEqual([])
})

test('Given旧批次已验收且新批次同名步骤也通过 When累积 Then采用新任务', () => {
  const result = accumulateRetainedCandidates([
    [occurrence()],
    [occurrence({ taskId: 'task-retry', accepted: true })],
  ])
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ taskId: 'task-retry', stepKey: 'spec' })
  // 投影只保留交付要求字段，不含任务身份。
  expect(result[0]!.projection).not.toHaveProperty('taskId')
})

test('Given不同步骤互不影响 When累积 Then各自保留', () => {
  const result = accumulateRetainedCandidates([
    [occurrence()],
    [occurrence({ taskId: 'task-build', stepKey: 'build', accepted: false })],
  ])
  expect(result.map(item => item.stepKey)).toEqual(['spec'])
})

test('Given新批次只含部分步骤 When累积 Then未出现的步骤保持原候选', () => {
  const result = accumulateRetainedCandidates([
    [occurrence(), occurrence({ taskId: 'task-b', stepKey: 'build' })],
    [occurrence({ taskId: 'task-b2', stepKey: 'build', accepted: false })],
  ])
  // spec 不在新批次里，说明它没有被重新执行，仍可复用。
  expect(result.map(item => item.stepKey)).toEqual(['spec'])
})

test('Given全部批次都未验收 When累积 Then没有候选', () => {
  expect(accumulateRetainedCandidates([[occurrence({ accepted: false })]])).toEqual([])
})

test('Given没有任何批次 When累积 Then没有候选', () => {
  expect(accumulateRetainedCandidates([])).toEqual([])
})
