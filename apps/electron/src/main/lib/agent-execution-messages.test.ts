import { expect, test } from 'bun:test'
import { currentExecutionMessages, normalizeExecutionMessages } from './agent-execution-messages'

test('SDK 文本块与旧格式统一提取，工具结果和推理不冒充交付', () => {
  expect(normalizeExecutionMessages([
    { type: 'assistant', uuid: 'sdk-1', message: { content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '修改完成' }, { type: 'tool_use', name: 'Read' }] } },
    { role: 'assistant', id: 'old-1', content: '旧格式', createdAt: 1 },
    { type: 'result', result: '统计' },
  ]).map((message) => [message.id, message.content])).toEqual([['sdk-1', '修改完成'], ['old-1', '旧格式']])
})
test('返工以 SDK uuid 排除历史，不会因缺少旧 id 过滤全部新消息', () => {
  const sdk = (uuid: string, text: string) => ({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } })
  const old = sdk('old', '上一轮')
  const ids = new Set(normalizeExecutionMessages([old]).map((message) => message.id).filter(Boolean))
  expect(currentExecutionMessages([old, sdk('new', '本轮')], ids).map((message) => message.content)).toEqual(['本轮'])
  expect(currentExecutionMessages([old], ids)).toEqual([])
})

test('历史无 uuid 的错误及普通回答不能冒充本轮空结果', () => {
  const error = { type: 'assistant', _errorCode: 'unknown_error', message: { content: [{ type: 'text', text: '网络失败' }] } }
  const legacy = { type: 'assistant', message: { content: [{ type: 'text', text: '历史结果' }] } }
  const ids = new Set(normalizeExecutionMessages([error, legacy]).map((message) => message.id))
  expect(normalizeExecutionMessages([error])).toEqual([])
  expect(currentExecutionMessages([error, legacy], ids)).toEqual([])
})
