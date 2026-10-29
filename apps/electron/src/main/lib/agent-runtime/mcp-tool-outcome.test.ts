import { describe, expect, test } from 'bun:test'
import { classifyMcpToolFailure, describeMcpToolFailure } from './mcp-tool-outcome'

describe('classifyMcpToolFailure', () => {
  test('Given 协议明确方法不存在 When 分类 Then 未执行', () => {
    expect(classifyMcpToolFailure(Object.assign(new Error('method not found'), { code: -32601 })).outcome).toBe('not_applied')
  })

  test('Given 参数或输出校验错误 When 分类 Then 不推断工具未执行', () => {
    // SDK 也会在工具执行后校验输出，-32600/-32602 不能证明前置拒绝。
    for (const code of [-32600, -32602, -32603, -32000, -32001]) {
      expect(classifyMcpToolFailure(Object.assign(new Error('validation or internal error'), { code })).outcome).toBe('unknown')
    }
  })

  test('Given JSON-RPC 错误码存在 When 分类 Then 不再看文案', () => {
    // 错误文案恰好包含"未执行"也应服从错误码：-32603 说明服务端已处理。
    const error = Object.assign(new Error('工具未执行'), { code: -32603 })
    expect(classifyMcpToolFailure(error).outcome).toBe('unknown')
  })

  test('Given 超时或中止 When 分类 Then 结果未知', () => {
    const timeout = new Error('timed out')
    timeout.name = 'TimeoutError'
    expect(classifyMcpToolFailure(timeout).outcome).toBe('unknown')
    const aborted = new Error('aborted')
    aborted.name = 'AbortError'
    expect(classifyMcpToolFailure(aborted).outcome).toBe('unknown')
  })

  test('Given 传输层断连 When 分类 Then 结果未知', () => {
    for (const code of ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN']) {
      expect(classifyMcpToolFailure(Object.assign(new Error('x'), { code })).outcome).toBe('unknown')
    }
    for (const message of ['Connection closed', 'socket hang up', '连接已关闭']) {
      expect(classifyMcpToolFailure(new Error(message)).outcome).toBe('unknown')
    }
  })

  test('Given 派发后异常没有数字错误码 When 分类 Then 不按文案推断未执行', () => {
    for (const message of ['未连接', 'MCP 服务器未连接: filesystem', 'Method not found', 'Invalid params: path', '工具不存在']) {
      expect(classifyMcpToolFailure(new Error(message)).outcome).toBe('unknown')
    }
    expect(classifyMcpToolFailure(Object.assign(new Error('denied'), { code: 'EACCES' })).outcome).toBe('unknown')
  })

  test('Given 无法归类的异常 When 分类 Then 保守判为结果未知', () => {
    expect(classifyMcpToolFailure(new Error('unexpected')).outcome).toBe('unknown')
    expect(classifyMcpToolFailure(undefined).outcome).toBe('unknown')
    expect(classifyMcpToolFailure('boom').outcome).toBe('unknown')
  })

  test('Given 超长错误信息 When 分类 Then 理由被截断', () => {
    expect(classifyMcpToolFailure(new Error('x'.repeat(2000))).reason.length).toBeLessThanOrEqual(300)
  })
})

describe('describeMcpToolFailure', () => {
  test('Given 结果未知 When 生成文案 Then 禁止重试并要求核对目标系统', () => {
    const failure = describeMcpToolFailure('github__create_issue', new Error('Connection closed'))
    expect(failure.outcome).toBe('unknown')
    expect(failure.message).toContain('MCP 工具 github__create_issue 结果未知')
    expect(failure.message).toContain('禁止自动重试')
    expect(failure.message).toContain('核对目标系统的实际状态')
  })

  test('Given 未执行 When 生成文案 Then 允许修正后重试', () => {
    const failure = describeMcpToolFailure('fs__read', Object.assign(new Error('bad'), { code: -32601 }))
    expect(failure.outcome).toBe('not_applied')
    expect(failure.message).toContain('未执行')
    expect(failure.message).toContain('修正前置条件后可以重试')
    expect(failure.message).not.toContain('禁止自动重试')
  })

  test('Given JSON-RPC 内部错误 When 生成文案 Then 与归类结论一致', () => {
    // 文案必须走同一个归类实现，否则会出现"文案说未知、归来说未执行"的错位。
    const failure = describeMcpToolFailure('db__write', Object.assign(new Error('Invalid params'), { code: -32603 }))
    expect(failure.outcome).toBe('unknown')
    expect(failure.message).toContain('结果未知')
  })
})
