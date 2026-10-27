import { expect, test } from 'bun:test'
import type { OwnerExecutionPreparationView, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getOwnerExecutionEditor } from './project-owner-execution-atoms'
import { ownerDollarsToMicros, ownerExecutionPeopleReady, ownerExecutionSetupSuggestion, ownerMicrosToDollars } from './owner-execution-setup'

const plan: ProjectOwnerPlanDraft = {
  projectId: 'p', schemaVersion: 1, revision: 1, planVersion: 1, goalRevision: 1, goalVersion: 1,
  state: 'confirmed', actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '确认',
  contextFingerprint: 'ctx', planFingerprint: 'plan', sources: { project: { id: 'p', title: '项目', description: '' }, roles: [] },
  proposal: { projectId: 'p', goalVersion: 1, mode: 'proposal_only', summary: '计划', assumptions: [], risks: [], steps: [{ key: 's', title: '调研', outcome: '报告', acceptanceCriteria: ['证据'], roleKey: 'research', dependencies: [] }] },
}
const employee = { id: 'e', name: '执行', roleTemplateId: 'research', executionProfile: 'controlled', workspaceIds: ['w'], channelId: 'c', modelId: 'm', runtime: 'ai-sdk' }
const view: OwnerExecutionPreparationView = {
  choices: { employees: [employee, { ...employee, id: 'r', roleTemplateId: 'reviewer' }], workspaces: [{ id: 'w', name: '工作区' }], knowledgeSources: [], workspaceCapabilities: [] },
  workspaceRecommendation: { source: 'owner_binding', workspaceId: 'w' }, executionConfigurationRecommendation: { source: 'owner_binding', channelId: 'c', modelId: 'm', runtime: 'ai-sdk' }, executionConfigurationRecommendationState: 'current',
  revision: 0, policyRevision: null, preparation: null, status: 'none', blockers: [],
}
const editor = () => ({ ...getOwnerExecutionEditor(new Map(), { projectId: 'p' }), view, loaded: true })
test('Given 美元文本 When 换算 Then 精确到微美元且拒绝指数、溢出和隐式汇率', () => {
  for (const [dollars, micros] of [['0.000001', '1'], ['1.000001', '1000001'], ['15', '15000000'], ['9007199254.740991', '9007199254740991']]) {
    expect(ownerDollarsToMicros(dollars!)).toBe(micros!)
    expect(ownerMicrosToDollars(micros!)).toBe(dollars!)
  }
  for (const text of ['15人民币', '1e6', '-1', '01', '1.0000001', '9007199254.740992', ' 1', '1.', '']) expect(ownerDollarsToMicros(text)).toBe('')
})
test('Given 本项目唯一有效岗位 When 准备 Then 复用而不推测Reviewer或预算', () => {
  expect(ownerExecutionSetupSuggestion(view, plan, editor())).toEqual({ workspaceId: 'w', selectedStepKeys: ['s'], roleAssignments: { research: 'e' } })
  expect(editor().reviewerEmployeeId).toBe('')
  expect(editor().maxCostMicrosText).toBe('')
})
test('Given 模板歧义、Owner载体、其他模型或工作区 When 推荐 Then 不使用首项或全局回退', () => {
  for (const employees of [[employee, { ...employee, id: 'e2' }], [{ ...employee, isOwnerCarrier: true }], [{ ...employee, modelId: 'other' }], [{ ...employee, workspaceIds: ['other'] }]]) {
    expect(ownerExecutionSetupSuggestion({ ...view, choices: { ...view.choices, employees } }, plan, editor()).roleAssignments).toEqual({})
  }
})
test('Given 已有明确选择 When 推荐 Then 不覆盖用户选择或缩小步骤', () => {
  const draft = { ...editor(), roleAssignments: { research: 'chosen' }, selectedStepKeys: ['s'], workspaceId: 'chosen-workspace' }
  expect(ownerExecutionSetupSuggestion(view, plan, draft)).toEqual({ workspaceId: 'chosen-workspace', selectedStepKeys: ['s'], roleAssignments: { research: 'chosen' } })
})
test('Given 人员与配置完整 When 进入预算 Then 必须独立评审且来源仍有效', () => {
  const e = { ...editor(), selectedStepKeys: ['s'], workspaceId: 'w', roleAssignments: { research: 'e' }, reviewerEmployeeId: 'r' }
  expect(ownerExecutionPeopleReady(e, plan)).toBe(true)
  expect(ownerExecutionPeopleReady({ ...e, roleAssignments: {}, executorEmployeeId: 'e' }, plan)).toBe(true)
  for (const patch of [{ reviewerEmployeeId: 'e' }, { reviewerEmployeeId: '' }, { requiresReview: true }, { loaded: false }, { selectedStepKeys: [] }, { roleAssignments: { research: 'missing' } }]) expect(ownerExecutionPeopleReady({ ...e, ...patch }, plan)).toBe(false)
  expect(ownerExecutionPeopleReady({ ...e, view: { ...view, executionConfigurationRecommendationState: 'stale' } }, plan)).toBe(false)
  expect(ownerExecutionPeopleReady(e, { ...plan, proposal: { ...plan.proposal, steps: [{ ...plan.proposal.steps[0]!, dependencies: ['missing'] }] } })).toBe(false)
})
test('Given 覆盖Owner模型 When 未明确确认或员工间不一致 Then 阻止继续', () => {
  const e = { ...editor(), selectedStepKeys: ['s'], workspaceId: 'w', roleAssignments: { research: 'e' }, reviewerEmployeeId: 'r', view: { ...view, executionConfigurationRecommendation: { ...view.executionConfigurationRecommendation!, modelId: 'owner-model' } } }
  expect(ownerExecutionPeopleReady(e, plan)).toBe(false)
  expect(ownerExecutionPeopleReady({ ...e, acknowledgeOwnerConfigurationOverride: true }, plan)).toBe(true)
  expect(ownerExecutionPeopleReady({ ...e, acknowledgeOwnerConfigurationOverride: true, view: { ...e.view, choices: { ...view.choices, employees: [employee, { ...employee, id: 'r', modelId: 'different' }] } } }, plan)).toBe(false)
})
