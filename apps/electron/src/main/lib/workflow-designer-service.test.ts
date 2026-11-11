import { expect, mock, test } from 'bun:test'

let records: unknown[] = []
mock.module('./agent-session-manager', () => ({ createAgentSession: () => ({ id: 'test-session' }), getAgentSessionSDKMessages: () => records }))
let response = ''
let completeWithoutMessages = false
let stoppedByUser = false
mock.module('./agent-service', () => ({ runAgentHeadless: async (_input: unknown, callbacks: { onComplete: (messages: unknown[], result: { stoppedByUser: boolean }) => void }) => callbacks.onComplete(completeWithoutMessages ? [] : [{ role: 'assistant', content: response }], { stoppedByUser }) }))
const { proposeWorkflowPatches } = await import('./workflow-designer-service')
const definition = { name: 'test', workspaceId: 'workspace' } as Parameters<typeof proposeWorkflowPatches>[0]

test('Given 模型二次编码设计结果 When 提出 patch Then 返回经过校验的结果', async () => {
  response = JSON.stringify(JSON.stringify({ reply: '需要更多信息', patches: [] }))
  expect(await proposeWorkflowPatches(definition, '设计流程', 'channel')).toMatchObject({ reply: '需要更多信息', patches: [], designerSessionId: 'test-session' })
})

test('Given 二次编码的无效 patch When 提出方案 Then 仍拒绝不安全结果', async () => {
  response = JSON.stringify(JSON.stringify({ reply: 'ok', patches: [{ op: 'unknown' }] }))
  await expect(proposeWorkflowPatches(definition, '设计流程', 'channel')).rejects.toThrow('不安全或无效')
})

test('Given 完成回执没有消息 When 会话包含 SDK 格式回复 Then 读取最后一条文本', async () => {
  completeWithoutMessages = true
  records = [{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '思考' }, { type: 'text', text: JSON.stringify({ reply: '会话回复', patches: [] }) }] } }]
  expect(await proposeWorkflowPatches(definition, '设计流程', 'channel')).toMatchObject({ reply: '会话回复', patches: [] })
})

test('Given SDK 助手正文为字符串 When 读取会话 Then 返回设计结果', async () => {
  records = [{ type: 'assistant', message: { content: JSON.stringify({ reply: '字符串正文', patches: [] }) } }]
  expect(await proposeWorkflowPatches(definition, '设计流程', 'channel')).toMatchObject({ reply: '字符串正文', patches: [] })
})

test('Given 用户停止运行 When 会话已有部分回复 Then 不返回方案', async () => {
  stoppedByUser = true
  await expect(proposeWorkflowPatches(definition, '设计流程', 'channel')).rejects.toThrow('已停止')
})
