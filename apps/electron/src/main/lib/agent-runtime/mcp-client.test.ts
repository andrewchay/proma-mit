import { describe, test, expect } from 'bun:test'
import { sanitizeMcpToolName } from './mcp-client'

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
