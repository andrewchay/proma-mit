import { expect, test } from 'bun:test'
import { AgentAskUserService } from './agent-ask-user-service'
const input = { questions: [{ question: '使用哪个颜色？', options: [] }] }
test('通知前登记pending，同步答复不会丢失', async () => {
  const service = new AgentAskUserService()
  const result = await service.handleAskUserQuestion('ordinary', input, new AbortController().signal, request => {
    expect(service.respondToAskUser(request.requestId, { color: '蓝' })).toBe('ordinary')
  })
  expect(result.behavior).toBe('allow')
  expect(service.getPendingRequests()).toHaveLength(0)
})
test('未知动作核对保留专用交互类型供安全确认界面识别', async () => {
  const service = new AgentAskUserService()
  let kind: string | undefined
  const pending = service.handleAskUserQuestion('session', {
    ...input,
    interactionType: 'unknown_action_resolution',
  }, new AbortController().signal, request => { kind = request.kind; service.respondToAskUser(request.requestId, {}) })
  expect((await pending).behavior).toBe('allow')
  expect(kind).toBe('unknown_action_resolution')
})
test('Owner接管后不发布员工横幅，原响应入口可继续员工', async () => {
  let requestId = ''
  const service = new AgentAskUserService({ route: request => { requestId = request.requestId; return true }, cancel: () => {} })
  const result = service.handleAskUserQuestion('employee', input, new AbortController().signal, () => { throw new Error('不应发给员工面板') })
  expect(service.respondToAskUser(requestId, { color: '蓝' })).toBeNull()
  expect(service.respondToOwnerAskUser(requestId, 'employee', { color: '蓝' }, '范围内')).toBe(true)
  expect((await result).behavior).toBe('allow')
})
test('已中止请求不触发路由，运行中取消会通知中介', async () => {
  let routed = 0, cancelled = 0
  const service = new AgentAskUserService({ route: () => { routed++; return true }, cancel: () => { cancelled++ } })
  const first = new AbortController(); first.abort()
  expect((await service.handleAskUserQuestion('employee', input, first.signal, () => {})).behavior).toBe('deny')
  expect(routed).toBe(0)
  const second = new AbortController()
  const pending = service.handleAskUserQuestion('employee', input, second.signal, () => {})
  second.abort()
  expect((await pending).behavior).toBe('deny')
  expect(cancelled).toBe(2)
})
test('路由失败拒绝而非降级为直接问用户', async () => {
  const service = new AgentAskUserService({ route: () => { throw new Error('Owner来源过期') }, cancel: () => {} })
  expect(await service.handleAskUserQuestion('employee', input, new AbortController().signal, () => { throw new Error('不应降级') })).toEqual({ behavior: 'deny', message: 'Owner来源过期' })
  expect(service.getPendingRequests()).toHaveLength(0)
})
