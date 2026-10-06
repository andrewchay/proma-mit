import { describe, expect, test } from 'bun:test'
import { buildDevelopmentInstructions, validateDevelopmentTarget } from './agent-development-context'

const employee = { channelId: 'channel', modelId: 'model', workspaceId: 'workspace', runtime: 'pi' }
const facts = {
  getChannel: () => ({ enabled: true, models: [{ id: 'model', enabled: true }] }),
  getWorkspace: () => ({ rootPath: '/repo' }),
}

describe('研发员工配置与项目理解', () => {
  test('Given 显式有效配置 When 校验 Then 保留 Runtime 并默认只读', () => {
    expect(validateDevelopmentTarget(employee, undefined, facts)).toEqual({ workspaceId: 'workspace', modelId: 'model', permissionMode: 'safe' })
  })
  test('Given 缺工作区或模型 When 校验 Then 不回退到全局或渠道默认', () => {
    expect(() => validateDevelopmentTarget({ ...employee, workspaceId: undefined }, undefined, facts)).toThrow('工作区')
    expect(() => validateDevelopmentTarget({ ...employee, modelId: undefined }, undefined, facts)).toThrow('模型')
  })
  test('Given 停用渠道、未知权限或 Workflow When 校验 Then 明确拒绝', () => {
    expect(() => validateDevelopmentTarget(employee, undefined, { ...facts, getChannel: () => undefined })).toThrow('渠道')
    expect(() => validateDevelopmentTarget({ ...employee, permissionMode: 'bypassPermissions' }, undefined, facts)).toThrow('权限')
    expect(() => validateDevelopmentTarget({ ...employee, workflowId: 'wf' }, undefined, facts)).toThrow('Workflow')
  })
  test('Given 单工作区员工与任务指定同一工作区 When 校验 Then 使用任务指定值', () => {
    expect(validateDevelopmentTarget(employee, 'workspace', facts).workspaceId).toBe('workspace')
  })
  test('Given 多工作区员工未指定任务工作区 When 校验 Then 拒绝隐式选择', () => {
    expect(() => validateDevelopmentTarget({ ...employee, workspaceId: undefined, workspaceIds: ['workspace', 'other-workspace'] }, undefined, facts)).toThrow('明确选择')
  })
  test('Given 任务选择角色范围外工作区 When 校验 Then 拒绝跨项目路由', () => {
    expect(() => validateDevelopmentTarget({ ...employee, workspaceIds: ['workspace'] }, 'task-workspace', facts)).toThrow('可用工作区')
  })
  test('Given 项目与返工意见 When 生成指令 Then 包含来源学习、兼容与验证要求', () => {
    const prompt = buildDevelopmentInstructions({ title: 'Gravitas', description: '本地优先' }, '补充回归测试', ['测试通过'])
    for (const text of ['AGENTS.md', '本地优先', '补充回归测试', '测试通过', 'git diff', '未运行', '不可信']) expect(prompt).toContain(text)
  })
})
