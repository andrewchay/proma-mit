import { expect, test } from 'bun:test'
import { getEmployeeSaveIssues, employeeTemplateChanges, isEmployeeWorkspaceEligible } from './agent-employee-form'
import templates from '../../../../resources/employee-role-templates.json'
const workspaces = [{ id: 'managed', name: '托管' }, { id: 'local', name: '本地', rootPath: '/repo' }]
const channels = [{ id: 'channel', models: [{ id: 'model', enabled: true }, { id: 'disabled', enabled: false }] }]
const form = { name: '研究员', runtime: 'pi', channelId: 'channel', modelId: 'model', workspaceIds: ['managed'], executionProfile: 'controlled' as const, permissionMode: 'safe' as const, workflowId: '' }
test('非代码岗位允许托管工作区，研发限制仍存在且反馈原因', () => {
  expect(getEmployeeSaveIssues(form, channels, workspaces)).toEqual([])
  expect(isEmployeeWorkspaceEligible('development', workspaces[0]!)).toBe(false)
  expect(isEmployeeWorkspaceEligible('controlled', workspaces[0]!)).toBe(true)
  expect(getEmployeeSaveIssues({ ...form, executionProfile: 'development' }, channels, workspaces).join('')).toContain('研发')
})
test('缺项、停用模型、失效工作区、未知权限都有明确反馈', () => {
  expect(getEmployeeSaveIssues({ ...form, name: '', channelId: '', modelId: '', workspaceIds: [] }, channels, workspaces).length).toBe(4)
  for (const patch of [{ modelId: 'disabled' }, { workspaceIds: ['missing'] }, { workflowId: 'sop' }, { runtime: 'claude' }, { permissionMode: 'bypassPermissions' }]) expect(getEmployeeSaveIssues({ ...form, ...patch }, channels, workspaces).length).toBeGreaterThan(0)
})
test('旧普通员工不强加新模型/工作区要求', () => {
  expect(getEmployeeSaveIssues({ ...form, executionProfile: 'general', modelId: '', workspaceIds: [] }, channels, workspaces)).toEqual([])
})
test('20份模板保留完整规则，只预填安全岗位、不覆盖真实绑定', () => {
  expect(templates).toHaveLength(20)
  for (const template of templates) {
    const changes = employeeTemplateChanges(template)
    expect(changes).toMatchObject({ executionProfile: 'controlled', permissionMode: 'safe', workflowId: '' })
    expect(changes.systemPrompt).toContain('共通执行规则')
    expect(changes.systemPrompt).toContain('外发、发布、付款')
    expect(changes).not.toHaveProperty('workspaceIds')
    expect(changes).not.toHaveProperty('channelId')
    expect(changes).not.toHaveProperty('modelId')
  }
})
