import { expect, test } from 'bun:test'
import { runRegisteredHeadlessAgent, setHeadlessAgentRunner } from './agent-headless-runner-registry'

const input = { sessionId: 'pilot-handoff-test', channelId: 'fixture-channel', userMessage: 'fixture', triggeredBy: 'automation' as const }
const callbacks = { onError: () => {}, onComplete: () => {}, onTitleUpdated: () => {} }

test('Given runner 未注册 When 启动 Then 不写交接且不调用外部执行', async () => {
  let invoked = 0
  await expect(runRegisteredHeadlessAgent(input, { ...callbacks, onRunnerInvoke: () => { invoked++ } }))
    .rejects.toThrow('尚未初始化')
  expect(invoked).toBe(0)
})

test('Given 交接记录失败 When 准备调用 runner Then 不执行模型入口', async () => {
  let started = 0
  setHeadlessAgentRunner(async () => { started++ })
  await expect(runRegisteredHeadlessAgent(input, { ...callbacks, onRunnerInvoke: () => { throw new Error('audit failed') } }))
    .rejects.toThrow('audit failed')
  expect(started).toBe(0)
  await runRegisteredHeadlessAgent(input, { ...callbacks, onRunnerInvoke: () => { started++ } })
  expect(started).toBe(2)
})
