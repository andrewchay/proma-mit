import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKMessage } from '@gravitas/shared'
import { getLiveTraceIndex } from './live-trace'

const thinking: SDKContentBlock = { type: 'thinking', thinking: '思考中' }
const tool: SDKContentBlock = { type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }
const partial = { type: 'assistant', parent_tool_use_id: null, _partial: true, message: { content: [thinking] } } as SDKMessage
const result = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } } as SDKMessage

describe('流式执行记录', () => {
  test('思考时展示最新思考，工具开始后切换到工具', () => {
    expect(getLiveTraceIndex([thinking], [partial], true)).toBe(0)
    expect(getLiveTraceIndex([thinking, tool], [partial], true)).toBe(1)
  })
  test('工具完成、开始正文或流式结束后不再单独展示', () => {
    expect(getLiveTraceIndex([thinking, tool], [partial, result], true)).toBeUndefined()
    expect(getLiveTraceIndex([thinking, tool, { type: 'text', text: '结果' }], [partial, result], true)).toBeUndefined()
    expect(getLiveTraceIndex([thinking], [partial], false)).toBeUndefined()
  })
})
