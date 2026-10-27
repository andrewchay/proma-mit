import { expect, test } from 'bun:test'
import type { OwnerExecutionAssignmentProposal, OwnerExecutionPreparationView, ProjectOwnerPlanDraft } from '@gravitas/shared'
import { getOwnerExecutionEditor } from './project-owner-execution-atoms'
import { ownerDollarsToMicros, ownerExecutionAssignmentEdit, ownerExecutionArrangementMatches, ownerExecutionSuggestedLimits, ownerExecutionPeopleReady, ownerExecutionSetupSuggestion, ownerMicrosToDollars } from './owner-execution-setup'

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
test('Given 本项目唯一有效岗位与评审角色 When 准备 Then Owner 自动安排人员但不填预算', () => {
  expect(ownerExecutionSetupSuggestion(view, plan, editor())).toEqual({ workspaceId: 'w', selectedStepKeys: ['s'], roleAssignments: { research: 'e' }, reviewerEmployeeId: 'r' })
  expect(editor().maxCostMicrosText).toBe('')
})
test('Given 评审角色缺失或不唯一 When Owner 安排 Then 保持阻塞而不猜人', () => {
  const reviewer = view.choices.employees[1]!
  for (const employees of [[], [reviewer, { ...reviewer, id: 'r2' }]]) {
    expect(ownerExecutionSetupSuggestion({ ...view, choices: { ...view.choices, employees: [employee, ...employees] } }, plan, editor()).reviewerEmployeeId).toBeUndefined()
  }
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

test('Given 已核验Owner安排和未保存预算 When 重建界面 Then 只建议运行边界，保留预算且冲突选人可识别', () => {
  const proposal: OwnerExecutionAssignmentProposal = { schemaVersion: 1, contextFingerprint: 'a'.repeat(64), selectedStepKeys: ['s'], scopeReason: '完整方案', workspaceId: 'w', workspaceReason: '已授权', executionKind: 'controlled', executionKindReason: '非代码', assignments: [{ roleKey: 'research', employeeId: 'e', reason: '适配' }], reviewerEmployeeId: 'r', reviewerReason: '独立' }
  const selected = { ...editor(), ...ownerExecutionAssignmentEdit(proposal), maxCostMicrosText: '7000000', knowledgeSourceIds: ['user-selected'] }
  expect(ownerExecutionArrangementMatches(selected, proposal)).toBe(true)
  expect(ownerExecutionArrangementMatches({ ...selected, roleAssignments: { research: 'other' } }, proposal)).toBe(false)
  const now = new Date('2026-10-19T08:30:00Z').getTime(), limits = ownerExecutionSuggestedLimits(1, now)
  expect(limits).toMatchObject({ maxRunsText: '12', maxReworkText: '1' })
  expect(limits).not.toHaveProperty('maxCostMicrosText')
  expect(limits).not.toHaveProperty('knowledgeSourceIds')
  expect(new Date(limits.expiresAtText!).getTime()).toBe(now + 86400000)
})


test('GivenOwner已选择适配的普通员工且无岗位模板 When投影同一对话执行边界 Then无需用户改profile或重新选人', () => {
  const generalView = { ...view, choices: { ...view.choices, employees: view.choices.employees.map(item => ({ ...item, executionProfile: 'general', roleTemplateId: undefined, ownerControlledCompatible: true as const })) } }
  const selected = { ...editor(), view: generalView, selectedStepKeys: ['s'], workspaceId: 'w', roleAssignments: { research: 'e' }, reviewerEmployeeId: 'r' }
  expect(ownerExecutionPeopleReady(selected, plan)).toBe(true)
  expect(ownerExecutionPeopleReady({ ...selected, view: { ...generalView, choices: { ...generalView.choices, employees: generalView.choices.employees.map(item => ({ ...item, ownerControlledCompatible: undefined })) } } }, plan)).toBe(false)
})


test('GivenOwner已选不同模型且后端都确认兼容 When进入执行边界 Then不要求用户统一模型或核对内部覆盖项', () => {
  const choices = { ...view.choices, employees: view.choices.employees.map(item => ({ ...item, ownerMixedRuntimeCompatible: true as const, ...(item.id === 'r' ? { channelId: 'other', modelId: 'review-model' } : {}) })) }
  const selected = { ...editor(), view: { ...view, choices }, selectedStepKeys: ['s'], workspaceId: 'w', roleAssignments: { research: 'e' }, reviewerEmployeeId: 'r' }
  expect(ownerExecutionPeopleReady(selected, plan)).toBe(true)
  expect(ownerExecutionPeopleReady({ ...selected, view: { ...view, choices: { ...choices, employees: choices.employees.map(item => ({ ...item, ownerMixedRuntimeCompatible: undefined })) } } }, plan)).toBe(false)
})
