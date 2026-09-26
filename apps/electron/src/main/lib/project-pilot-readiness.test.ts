import { expect, test } from 'bun:test'
import type { AgentEmployee } from './project-types'
import type { PilotPolicy } from './project-pilot-policy'
import { evaluatePilotPolicyBindings } from './project-pilot-readiness'

const now = 1_000
const policy: PilotPolicy = {
  version: 1, projectId: 'project-a', revision: 2, state: 'paused', workspaceId: 'workspace-a',
  employeeIds: ['executor', 'reviewer'], executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer', channelId: 'channel-a', modelId: 'model-a',
  maxCostMicros: 1_000_000, maxRuns: 2, maxRework: 1, expiresAt: now + 100, updatedAt: now,
}
const employee = (id: string, role: string): AgentEmployee => ({
  id, name: id, role, description: '', runtime: 'proma', channelId: 'channel-a', modelId: 'model-a',
  workspaceIds: ['workspace-a'], executionProfile: 'development', permissionMode: 'safe',
  enabled: true, totalTasks: 0, completedTasks: 0, failureCount: 0, createdAt: now, updatedAt: now,
})
const facts = () => ({
  projectExists: true,
  workspace: { rootPath: '/fixture/repo' },
  gitMarkerExists: true,
  channel: { enabled: true, models: [{ id: 'model-a', enabled: true }] },
  employees: [employee('executor', '执行'), employee('reviewer', '技术评审')],
})

test('给定两名安全研发角色和一致的绑定，预检可通过但策略仍保持暂停', () => {
  const result = evaluatePilotPolicyBindings(policy.projectId, policy, facts(), now)
  expect(result).toEqual({ projectId: policy.projectId, policyRevision: 2, bindingsValid: true, blockers: [] })
  expect(policy.state).toBe('paused')
})

test('给定缺失草案或项目，预检明确阻塞', () => {
  expect(evaluatePilotPolicyBindings('project-a', null, { ...facts(), projectExists: false }, now).blockers)
    .toEqual(['项目不存在', '尚未保存 Pilot 策略草案'])
})

test('给定已过期策略、停用渠道和错误工作区，预检拒绝旧绑定', () => {
  const input = facts()
  input.workspace = { rootPath: '' }
  input.channel.enabled = false
  const result = evaluatePilotPolicyBindings(policy.projectId, policy, input, policy.expiresAt)
  expect(result.bindingsValid).toBe(false)
  expect(result.blockers).toContain('策略草案已过期')
  expect(result.blockers).toContain('首版研发 Pilot 需要可用的本地 Git 工作区')
  expect(result.blockers).toContain('渠道不存在或已停用')
})

test('给定普通员工旧执行路径、错工作区和错模型，预检逐项拒绝', () => {
  const input = facts()
  input.employees[0] = { ...employee('executor', '执行'), executionProfile: 'general', workspaceIds: ['other'], modelId: 'model-b' }
  const result = evaluatePilotPolicyBindings(policy.projectId, policy, input, now)
  expect(result.bindingsValid).toBe(false)
  expect(result.blockers).toContain('员工 executor 不适用于首版安全研发运行路径')
  expect(result.blockers).toContain('员工 executor 未绑定执行工作区')
  expect(result.blockers).toContain('员工 executor 的渠道或模型与策略草案不一致')
})

test('给定仅一名员工或没有明确职责绑定，预检拒绝宣称具备执行和评审分工', () => {
  const single = evaluatePilotPolicyBindings(policy.projectId, { ...policy, employeeIds: ['executor'] }, { ...facts(), employees: [employee('executor', '执行')] }, now)
  expect(single.blockers).toContain('首版至少需要执行者与技术评审者两名员工')
  expect(evaluatePilotPolicyBindings(policy.projectId, { ...policy, reviewerEmployeeId: undefined }, facts(), now).blockers)
    .toContain('必须明确绑定不同的执行员工与技术评审员工')
  expect(evaluatePilotPolicyBindings(policy.projectId, { ...policy, reviewerEmployeeId: 'executor' }, facts(), now).blockers)
    .toContain('必须明确绑定不同的执行员工与技术评审员工')
})

test('给定跨项目草案或错位员工记录，预检拒绝混用身份', () => {
  const input = facts()
  input.employees[1] = employee('other', '技术评审')
  const result = evaluatePilotPolicyBindings('project-b', policy, input, now)
  expect(result.bindingsValid).toBe(false)
  expect(result.blockers).toContain('策略草案与项目不匹配')
  expect(result.blockers).toContain('员工 reviewer 不存在或已停用')
})

test('给定路径已经失效的本地工作区，预检拒绝仅凭配置路径放行', () => {
  const result = evaluatePilotPolicyBindings(policy.projectId, policy, { ...facts(), gitMarkerExists: false }, now)
  expect(result.bindingsValid).toBe(false)
  expect(result.blockers).toContain('首版研发 Pilot 需要可用的本地 Git 工作区')
})

test('给定旧版草案无职责字段，预检阻塞但不改变原草案', () => {
  const legacy = { ...policy, executorEmployeeId: undefined, reviewerEmployeeId: undefined }
  const result = evaluatePilotPolicyBindings(policy.projectId, legacy, facts(), now)
  expect(result.bindingsValid).toBe(false)
  expect(result.blockers).toContain('必须明确绑定不同的执行员工与技术评审员工')
  expect(legacy.state).toBe('paused')
})
