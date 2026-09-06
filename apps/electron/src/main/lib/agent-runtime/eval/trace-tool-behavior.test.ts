import { describe, expect, it } from 'bun:test'
import { matchesToolTraceAssertion, readTraceToolCalls } from './trace-tool-behavior'

const trace = [
  JSON.stringify({ type: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'ma_generate_strategy', input: { brand: '茶里茶气', product: '健康低糖奶茶', budget: '100万', preferred_platforms: 'xiaohongshu,douyin' } }] } } }),
  JSON.stringify({ type: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok', is_error: false }] } } }),
  JSON.stringify({ type: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-2', name: 'ma_search_kols', input: { category: '美妆' } }] } } }),
  JSON.stringify({ type: 'message', msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-2', content: 'empty', is_error: true }] } } }),
].join('\n')

describe('评测 trace 工具行为断言', () => {
  it('关联 tool_use 与 tool_result，保留真实参数和错误状态', () => {
    const calls = readTraceToolCalls(trace)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'ma_generate_strategy', arguments: { brand: '茶里茶气' }, isError: false })
    expect(calls[1]).toMatchObject({ name: 'ma_search_kols', isError: true })
  })

  it('验证工具名、必填参数、精确参数和成功结果', () => {
    expect(matchesToolTraceAssertion(trace, {
      name: 'ma_generate_strategy',
      requiredArguments: ['brand', 'product', 'budget', 'preferred_platforms'],
      expectedArguments: { brand: '茶里茶气', budget: '100万' },
      result: 'success',
    })).toBe(true)
    expect(matchesToolTraceAssertion(trace, { name: 'ma_generate_strategy', expectedArguments: { brand: '错误品牌' } })).toBe(false)
  })

  it('验证错误结果和禁止调用，不能由输出关键词替代', () => {
    expect(matchesToolTraceAssertion(trace, { name: 'ma_search_kols', result: 'error' })).toBe(true)
    expect(matchesToolTraceAssertion(trace, { forbiddenNames: ['ma_audit_content'] })).toBe(true)
    expect(matchesToolTraceAssertion(trace, { forbiddenNames: ['ma_search_kols'] })).toBe(false)
  })
})
