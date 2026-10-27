import { expect, test } from 'bun:test'
import { resolveOwnerCommandSession } from './owner-command-session'
const command = { executionId: 'execution', taskId: 'task', employeeId: 'employee' }
const execution = { id: 'execution', projectId: 'project', entityType: 'task' as const, entityId: 'task', agentId: 'employee', sessionId: 'session' }
const session = { id: 'session', projectId: 'project', workspaceId: 'workspace', title: '执行会话' }
test('Given 精确Owner命令 When 打开会话 Then 使用所绑定执行，不猜测同Task最近会话', () => {
  expect(resolveOwnerCommandSession('project', command, [{ ...execution, id: 'other', sessionId: 'other' }, execution], [session])).toEqual(session)
})
test('Given 会话来源不匹配或尚未创建 When 打开 Then 拒绝错误项目、任务、员工、Workflow及空会话', () => {
  for (const patch of [{ projectId: 'other' }, { entityId: 'other' }, { agentId: 'other' }, { sessionId: '' }, { sessionId: 'workflow:x' }])
    expect(() => resolveOwnerCommandSession('project', command, [{ ...execution, ...patch }], [session])).toThrow()
  expect(() => resolveOwnerCommandSession('project', command, [execution], [{ ...session, projectId: 'other' }])).toThrow()
  expect(() => resolveOwnerCommandSession('project', { ...command, executionId: null }, [execution], [session])).toThrow()
})
