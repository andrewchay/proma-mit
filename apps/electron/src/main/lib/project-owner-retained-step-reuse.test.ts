import { expect, test } from 'bun:test'
import { describeSpecificationDrift, narrowStepScope, resolveRetainedStepReuse } from './project-owner-retained-step-reuse'

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
