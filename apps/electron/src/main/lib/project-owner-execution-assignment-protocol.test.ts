import { expect, test } from 'bun:test'
import type { OwnerExecutionAssignmentCandidate, OwnerExecutionAssignmentProposal } from '@gravitas/shared'
import { parseOwnerExecutionAssignmentProposal } from './project-owner-execution-assignment-protocol'

const executor: OwnerExecutionAssignmentCandidate = { id: 'researcher', name: '研究员甲', role: '研究', roleTemplateId: 'research', description: '资料研究与证据整理', skills: ['竞品研究'], totalTasks: 8, completedTasks: 7, failureCount: 1, avgDurationMs: 1000, executionProfile: 'controlled', workspaceIds: ['workspace'], channelId: 'channel', modelId: 'model', runtime: 'ai-sdk' }
const executor2: OwnerExecutionAssignmentCandidate = { ...executor, id: 'researcher2', name: '研究员乙', description: '用户研究' }
const designer: OwnerExecutionAssignmentCandidate = { ...executor, id: 'designer', roleTemplateId: 'design', role: '设计', skills: ['视觉设计'] }
const reviewer: OwnerExecutionAssignmentCandidate = { ...executor, id: 'reviewer', name: '评审员', role: '交付核验', roleTemplateId: 'reviewer', skills: ['独立核验'] }
const context = { contextFingerprint: 'a'.repeat(64), workspaces: [{ id: 'workspace', name: '项目工作区' }], executionKinds: ['controlled', 'development'] as const, ownerCarrierId: 'owner', steps: [{ key: 's1', dependencies: [], roleKey: 'research' }, { key: 's2', dependencies: ['s1'], roleKey: 'design' }], candidates: [executor, executor2, designer, reviewer] }
const response: OwnerExecutionAssignmentProposal = {
  schemaVersion: 1, contextFingerprint: context.contextFingerprint, selectedStepKeys: ['s1', 's2'], scopeReason: '步骤存在依赖，需一并安排。', workspaceId: 'workspace', workspaceReason: '该项目工作区和团队配置满足此次任务。', executionKind: 'controlled', executionKindReason: '计划不包含代码修改。',
  assignments: [{ roleKey: 'research', employeeId: 'researcher2', reason: '其用户研究技能与调研步骤更匹配。' }, { roleKey: 'design', employeeId: 'designer', reason: '其岗位与视觉成果要求一致。' }], reviewerEmployeeId: 'reviewer', reviewerReason: '评审岗位独立于执行岗位。',
}

test('Given 当前项目计划与候选 When Owner提案合法安排 Then 返回严格规范化安排与理由', () => {
  expect(parseOwnerExecutionAssignmentProposal(response, context)).toEqual(response)
})
test('Given 输出带有额外字段/未知岗位/候选外人员 When 解析 Then fail closed', () => {
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, budget: 100 }, context)).toThrow('格式')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, assignments: [...response.assignments, { roleKey: 'unknown', employeeId: 'researcher', reason: 'x' }] }, context)).toThrow('岗位')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, assignments: [{ ...response.assignments[0], employeeId: 'foreign' }, response.assignments[1]] }, context)).toThrow('候选')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, contextFingerprint: 'b'.repeat(64) }, context)).toThrow('来源')
})
test('Given 计划外步骤/缺依赖/重复步骤 When 解析 Then 拒绝非法范围', () => {
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, selectedStepKeys: ['missing'] }, context)).toThrow('计划之外')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, selectedStepKeys: ['s2'] }, context)).toThrow('依赖')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, selectedStepKeys: ['s1', 's1'] }, context)).toThrow('步骤范围')
})
test('Given 工作区或执行方式不在候选 When 解析 Then fail closed', () => {
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, workspaceId: 'other' }, context)).toThrow('工作区')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, executionKind: 'general' }, context)).toThrow('执行方式')
})
test('Given 岗位覆盖重复或缺失 When 解析 Then 拒绝不完整提案', () => {
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, assignments: [response.assignments[0], response.assignments[0]] }, context)).toThrow('岗位')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, assignments: [response.assignments[0]] }, context)).toThrow('岗位')
})
test('Given 评审人与执行人相同或评审身份不符合 Then 拒绝自评或越权', () => {
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, reviewerEmployeeId: 'designer' }, context)).toThrow('独立评审')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, reviewerEmployeeId: 'owner' }, context)).toThrow('候选')
})
test('Given 候选不满足工作区、执行方式或统一配置 When 解析 Then 拒绝跨配置安排', () => {
  const wrongWorkspace = { ...context, candidates: context.candidates.map(candidate => candidate.id === 'reviewer' ? { ...candidate, workspaceIds: ['other'] } : candidate) }
  expect(() => parseOwnerExecutionAssignmentProposal(response, wrongWorkspace)).toThrow('工作区')
  const wrongMode = { ...context, candidates: context.candidates.map(candidate => candidate.id === 'designer' ? { ...candidate, executionProfile: 'development' } : candidate) }
  expect(() => parseOwnerExecutionAssignmentProposal(response, wrongMode)).toThrow('执行方式')
  const mismatched = { ...context, candidates: context.candidates.map(candidate => candidate.id === 'designer' ? { ...candidate, modelId: 'other-model' } : candidate) }
  expect(() => parseOwnerExecutionAssignmentProposal(response, mismatched)).toThrow('一致渠道')
  const wrongRole = { ...context, candidates: context.candidates.map(candidate => candidate.id === 'researcher2' ? { ...candidate, roleTemplateId: 'design' } : candidate) }
  expect(() => parseOwnerExecutionAssignmentProposal(response, wrongRole)).toThrow('岗位不匹配')
})
test('Given Owner载体被选为执行或评审 When 解析 Then 拒绝使用规划载体承担业务人员职责', () => {
  const withOwner = { ...context, candidates: [...context.candidates, { ...reviewer, id: 'owner', isOwnerCarrier: true, roleTemplateId: 'research' }] }
  const assignedOwner = { ...response, assignments: [{ ...response.assignments[0], employeeId: 'owner' }, response.assignments[1]] }
  expect(() => parseOwnerExecutionAssignmentProposal(assignedOwner, withOwner)).toThrow('Owner载体')
})


test('Givenv2冻结能力资料而模板不同 WhenOwner给出岗位理由 Then可用现有员工但旧协议仍拒绝模板不匹配', () => {
  const candidates = context.candidates.map(employee => ({ ...employee, executionProfile: 'general', ownerControlledCompatible: true as const, roleTemplateId: undefined }))
  const current = { ...context, candidates, teamContractVersion: 2 as const }
  expect(parseOwnerExecutionAssignmentProposal(response, current)).toEqual(response)
  expect(() => parseOwnerExecutionAssignmentProposal(response, { ...context, candidates })).toThrow()
  expect(() => parseOwnerExecutionAssignmentProposal(response, { ...current, candidates: candidates.map(item => ({ ...item, ownerControlledCompatible: undefined })) })).toThrow('执行方式')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, reviewerEmployeeId: 'designer' }, current)).toThrow('独立')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, assignments: response.assignments.map(item => ({ ...item, employeeId: 'outside' })) }, current)).toThrow('候选之外')
})


test('Givenv3审核能力与不同执行评审模型 When安排 Then不要求统一模型但旧v2与缺价格适配仍拒绝', () => {
  const candidates = context.candidates.map(item => ({ ...item, ownerMixedRuntimeCompatible: true as const, ...(item.id === 'reviewer' ? { channelId: 'review-channel', modelId: 'review-model' } : {}) }))
  expect(parseOwnerExecutionAssignmentProposal(response, { ...context, candidates, teamContractVersion: 3 })).toEqual(response)
  expect(() => parseOwnerExecutionAssignmentProposal(response, { ...context, candidates, teamContractVersion: 2 })).toThrow('一致渠道')
  expect(() => parseOwnerExecutionAssignmentProposal(response, { ...context, teamContractVersion: 3, candidates: candidates.map(item => ({ ...item, ownerMixedRuntimeCompatible: undefined })) })).toThrow('价格适配')
})

test('Given controlled安排附空developmentScope When解析 Then视为未填写且非空研发范围仍拒绝', () => {
  expect(parseOwnerExecutionAssignmentProposal({ ...response, developmentScope: null }, context)).toEqual(response)
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, developmentScope: {} }, context)).toThrow('不得包含代码范围')
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, executionKind: 'development', developmentScope: null }, context)).toThrow()
})


test('Given controlled安排有全空范围占位 When解析 Then无损省略且任何非空路径命令或未知字段拒绝', () => {
  const empty = { targetPaths: [], allowedPaths: [], verificationCommands: [], reason: '受控文案任务不适用代码范围' }
  expect(parseOwnerExecutionAssignmentProposal({ ...response, developmentScope: empty }, context)).toEqual(response)
  for (const field of ['targetPaths', 'allowedPaths', 'verificationCommands']) {
    expect(() => parseOwnerExecutionAssignmentProposal({ ...response, developmentScope: { ...empty, [field]: ['nonempty'] } }, context)).toThrow('不得包含代码范围')
  }
  expect(() => parseOwnerExecutionAssignmentProposal({ ...response, developmentScope: { ...empty, write: true } }, context)).toThrow('未授权字段')
})
