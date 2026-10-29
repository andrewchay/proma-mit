import { describe, test, expect } from 'bun:test'
import { McpClientManager, sanitizeMcpToolName } from './mcp-client'

describe('MCP 客户端', () => {
  test('sanitizeMcpToolName 保留合法 ASCII 工具名', () => {
    expect(sanitizeMcpToolName('mcp__server__tool')).toBe('mcp__server__tool')
  })

  test('sanitizeMcpToolName 将非法字符替换为下划线并保留 mcp__ 前缀', () => {
    expect(sanitizeMcpToolName('mcp__我的 server__tool.name')).toBe('mcp_____server__tool_name')
    expect(sanitizeMcpToolName('mcp__我的 server__tool.name')).toStartWith('mcp__')
  })

  test('sanitizeMcpToolName 将斜杠与点号替换为下划线', () => {
    expect(sanitizeMcpToolName('mcp__server/path__tool.name')).toBe('mcp__server_path__tool_name')
  })

  test('sanitizeMcpToolName 超长名称会截断并附加哈希后缀', () => {
    const longName = 'mcp__' + 'a'.repeat(80) + '__tool'
    const result = sanitizeMcpToolName(longName)
    expect(result.length).toBeLessThanOrEqual(64)
    expect(result).toMatch(/^[a-zA-Z0-9_-]+$/)
    expect(result).toStartWith('mcp__')
  })
})

describe('MCP 工具调用的结果判定', () => {
  const ctx = { cwd: '/tmp', sessionId: 'mcp-outcome-session' }

  function managerWith(callTool: () => Promise<unknown>) {
    const manager = new McpClientManager({}, '/tmp')
    // 只注入一个假服务器，避免真实拉起进程；executeTool 只用到 client.callTool。
    ;(manager as unknown as { servers: unknown[] }).servers = [{ name: 'demo', client: { callTool }, transport: {} }]
    return manager
  }

  test('Given 连接在调用后关闭 When 执行工具 Then 结果未知且禁止自动重试', async () => {
    const manager = managerWith(() => Promise.reject(new Error('Connection closed')))
    const result = await manager.executeTool('demo', 'create_issue', {}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('结果未知')
    expect(result.content).toContain('禁止自动重试')
    expect(result.content).toContain('demo__create_issue')
  })

  test('Given 服务端报告参数错误 When 执行工具 Then 不能推断动作未生效', async () => {
    const manager = managerWith(() => Promise.reject(Object.assign(new Error('Invalid params: path'), { code: -32602 })))
    const result = await manager.executeTool('demo', 'read_file', {}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('结果未知')
    expect(result.content).toContain('禁止自动重试')
    expect(result.content).not.toContain('未执行')
  })

  test('Given 服务端内部错误 When 执行工具 Then 保守判为结果未知', async () => {
    const manager = managerWith(() => Promise.reject(Object.assign(new Error('internal error'), { code: -32603 })))
    const result = await manager.executeTool('demo', 'send_mail', {}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('结果未知')
    expect(result.content).toContain('核对目标系统的实际状态')
  })

  test('Given 服务返回工具错误 When 执行 Then 保持未知并阻止重试', async () => {
    let calls = 0
    const manager = managerWith(() => { calls += 1; return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'failed after dispatch' }] }) })
    const input = { ...ctx, sessionId: 'mcp-outcome-tool-error' }
    expect((await manager.executeTool('demo', 'do_work', {}, input)).content).toContain('结果未知')
    expect((await manager.executeTool('demo', 'do_work', {}, input)).isError).toBe(true)
    expect(calls).toBe(1)
  })

  test('Given 服务器未连接 When 执行工具 Then 保持明确未执行的文案', async () => {
    const manager = new McpClientManager({}, '/tmp')
    const result = await manager.executeTool('missing', 'read_file', {}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('MCP 服务器未连接')
  })

  test('Given 调用成功 When 执行工具 Then 不出现未知提示', async () => {
    const manager = managerWith(() => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] }))
    const result = await manager.executeTool('demo', 'read_file', {}, { ...ctx, sessionId: 'mcp-outcome-success' })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ok')
    expect(result.content).not.toContain('结果未知')
  })
})

describe('MCP 未知结果的执行约束', () => {
  test('Given 上次调用结果未知 When 同参数再调 Then 不触达服务端', async () => {
    let calls = 0
    const manager = new McpClientManager({}, '/tmp')
    ;(manager as unknown as { servers: unknown[] }).servers = [
      {
        name: 'demo',
        client: {
          callTool: () => {
            calls += 1
            return Promise.reject(new Error('Connection closed'))
          },
        },
        transport: {},
      },
    ]
    const ctx = { cwd: '/tmp', sessionId: 'mcp-block-e2e' }
    const first = await manager.executeTool('demo', 'create_issue', { title: 'x' }, ctx)
    expect(first.content).toContain('结果未知')
    expect(calls).toBe(1)

    const second = await manager.executeTool('demo', 'create_issue', { title: 'x' }, ctx)
    expect(second.content).toContain('拒绝执行')
    expect(calls).toBe(1)

    // 参数不同是另一次调用，可以继续（它自己的结果也可能未知）。
    const other = await manager.executeTool('demo', 'create_issue', { title: 'y' }, ctx)
    expect(other.content).toContain('结果未知')
    expect(calls).toBe(2)
  })
})
