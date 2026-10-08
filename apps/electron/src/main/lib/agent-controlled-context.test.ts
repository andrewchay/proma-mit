import { expect, test } from 'bun:test'
import { validateControlledConfiguration, validateControlledTarget } from './agent-controlled-context'
const input = { runtime: 'pi', channelId: 'channel', modelId: 'model', workspaceIds: ['managed'], permissionMode: 'safe' }
const facts = { getChannel: (id: string) => id === 'channel' ? { enabled: true, models: [{ id: 'model', enabled: true }] } : undefined, getWorkspace: (id: string) => ['managed', 'local'].includes(id) ? {} : undefined }
test('托管和本地工作区可保存；safe无Git要求', () => {
  expect(validateControlledTarget(input, undefined, facts)).toEqual({ workspaceId: 'managed', modelId: 'model', permissionMode: 'safe' })
  expect(() => validateControlledConfiguration({ ...input, workspaceIds: ['managed', 'local'], permissionMode: 'auto' }, facts)).not.toThrow()
})
test('多工作区要求任务明确目标且不越过绑定', () => {
  expect(() => validateControlledTarget({ ...input, workspaceIds: ['managed', 'local'] }, undefined, facts)).toThrow('明确选择')
  expect(validateControlledTarget({ ...input, workspaceIds: ['managed', 'local'] }, 'local', facts).workspaceId).toBe('local')
  expect(() => validateControlledTarget(input, 'local', facts)).toThrow('范围')
})
test('拒绝未绑定、过期、重复工作区与隐式模型/渠道回退', () => {
  for (const patch of [{ workspaceIds: [] }, { workspaceIds: ['unknown'] }, { workspaceIds: ['managed', 'managed'] }, { modelId: '' }, { modelId: 'disabled' }, { channelId: 'missing' }]) expect(() => validateControlledConfiguration({ ...input, ...patch }, facts)).toThrow()
  expect(() => validateControlledTarget(input, undefined, { ...facts, getWorkspace: () => undefined })).toThrow()
})
test('拒绝Workflow、旧Runtime和绕过审批权限', () => {
  for (const patch of [{ workflowId: 'sop' }, { runtime: 'proma' }, { runtime: 'claude' }, { permissionMode: 'bypassPermissions' }]) expect(() => validateControlledConfiguration({ ...input, ...patch }, facts)).toThrow()
})
