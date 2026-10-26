import { expect, test } from 'bun:test'
import { deriveOwnerPlanningNextStep, shouldPrepareOwnerClarificationFollowUp, type OwnerPlanningFlowInput } from './project-owner-planning-flow'

const ready: OwnerPlanningFlowInput = {
  goal: { exists: true, dirty: false, requiresReview: false, conflict: false },
  binding: { exists: true, available: true },
  plan: { state: 'none', dirty: false, requiresReview: false, conflict: false },
  prepared: false,
  executionStatus: null,
  outcomeState: null,
}

test('Given 目标未保存或本地有修改 When 推导下一步 Then 只提示保存目标', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, goal: { ...ready.goal, exists: false } }).stage).toBe('save_goal')
  expect(deriveOwnerPlanningNextStep({ ...ready, goal: { ...ready.goal, dirty: true } }).stage).toBe('save_goal')
})

test('Given 目标冲突或载体缺失 When 推导下一步 Then 要先处理来源或配置而不准备', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, goal: { ...ready.goal, conflict: true } }).stage).toBe('resolve_goal')
  expect(deriveOwnerPlanningNextStep({ ...ready, binding: { exists: false, available: false } }).stage).toBe('configure_binding')
})

test('Given 计划来源需比较 When 推导下一步 Then 不进入规划准备', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, plan: { ...ready.plan, state: 'stale' } }).stage).toBe('review_plan')
  expect(deriveOwnerPlanningNextStep({ ...ready, plan: { ...ready.plan, dirty: true } }).stage).toBe('review_plan')
})

test('Given 目标与配置已保存且没有准备 When 推导下一步 Then 仅提示无费用准备', () => {
  const result = deriveOwnerPlanningNextStep(ready)
  expect(result).toEqual({ stage: 'prepare', title: '准备一次目标规划', detail: '准备只冻结当前目标与来源，不会调用模型或收费。' })
})

test('Given 已有准备但还没有Run When 推导下一步 Then 提示逐次费用确认', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true }).stage).toBe('confirm_cost')
})

test('Given Run运行中 When 推导下一步 Then 等待且不建议重试', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true, executionStatus: 'running' }).stage).toBe('waiting')
})

test('Given 模型提出必要澄清或计划 When 推导下一步 Then 分别提示答复或内容审阅', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true, outcomeState: 'needs_clarification' }).stage).toBe('answer_clarification')
  expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true, outcomeState: 'proposed' }).stage).toBe('review_proposal')
})

test('Given 费用/停止或Run终态未知 When 推导下一步 Then 先核查且不自动重试', () => {
  for (const outcomeState of ['failed', 'unknown', 'stopped', 'stale'] as const) {
    expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true, outcomeState }).stage).toBe('inspect')
  }
  expect(deriveOwnerPlanningNextStep({ ...ready, prepared: true, executionStatus: 'stale' }).stage).toBe('inspect')
})

test('Given 内容已确认且Run保留proposed事实 When 推导下一步 Then 说明规划内容完成但没有执行授权', () => {
  expect(deriveOwnerPlanningNextStep({ ...ready, outcomeState: 'proposed', plan: { ...ready.plan, state: 'confirmed' } }).stage).toBe('complete')
  expect(deriveOwnerPlanningNextStep({ ...ready, plan: { ...ready.plan, state: 'confirmed' } }).stage).toBe('complete')
})

test('Given 完整澄清答复已保存且来源仍匹配 When 检查续跑 Then 允许无费准备', () => {
  expect(shouldPrepareOwnerClarificationFollowUp({
    goal: { revision: 8, goalVersion: 4, constraints: ['Owner澄清答复（主要受众是谁？）：新用户', 'Owner澄清答复（交付形式是什么？）：方案报告'] },
    clarification: { goalRevision: 7, goalVersion: 3, planRevision: 2, bindingRevision: 5, questions: [{ question: '主要受众是谁？' }, { question: '交付形式是什么？' }] },
    planRevision: 2, bindingRevision: 5, context: { goalRevision: 8, fingerprint: 'new-context' }, runs: [{ goalRevision: 7, contextFingerprint: 'old-context' }],
  })).toBe(true)
})

test('Given 答复未保存、来源漂移或已续备 When 检查续跑 Then 不重复准备', () => {
  const base = {
    goal: { revision: 8, goalVersion: 4, constraints: ['Owner澄清答复（主要受众是谁？）：新用户'] },
    clarification: { goalRevision: 7, goalVersion: 3, planRevision: 2, bindingRevision: 5, questions: [{ question: '主要受众是谁？' }] },
    planRevision: 2, bindingRevision: 5, context: { goalRevision: 8, fingerprint: 'new-context' }, runs: [{ goalRevision: 7, contextFingerprint: 'old-context' }],
  }
  expect(shouldPrepareOwnerClarificationFollowUp({ ...base, goal: { ...base.goal, constraints: [] } })).toBe(false)
  expect(shouldPrepareOwnerClarificationFollowUp({ ...base, planRevision: 3 })).toBe(false)
  expect(shouldPrepareOwnerClarificationFollowUp({ ...base, context: { goalRevision: 7, fingerprint: 'old-context' } })).toBe(false)
  expect(shouldPrepareOwnerClarificationFollowUp({ ...base, runs: [...base.runs, { goalRevision: 8, contextFingerprint: 'new-context' }] })).toBe(false)
})
