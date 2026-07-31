import { describe, expect, test } from 'bun:test'
import { validateServerMcpConfig, validateServerMcpOAuthEndpoint } from './agent-runtime-server-mcp-policy'

const policy = { allowedOrigins: ['https://mcp.example.com'], maxTimeoutMs: 15_000 }

describe('服务端 MCP egress policy', () => {
  test('given approved HTTP MCP then clamps its timeout before a connection is created', () => {
    expect(validateServerMcpConfig('github', {
      type: 'http', enabled: true, url: 'https://mcp.example.com/api', timeout: 60,
    }, policy)).toEqual({ name: 'github', url: 'https://mcp.example.com/api', timeoutMs: 15_000, allowedOrigins: ['https://mcp.example.com'] })
  })

  test('given stdio or an unapproved origin then it is rejected by the API-worker boundary', () => {
    expect(() => validateServerMcpConfig('local', { type: 'stdio', enabled: true, command: 'node' }, policy)).toThrow('隔离 worker')
    expect(() => validateServerMcpConfig('other', { type: 'http', enabled: true, url: 'https://other.example.com/mcp' }, policy)).toThrow('allowlist')
  })

  test('given an OAuth endpoint outside the MCP egress allowlist then it is rejected', () => {
    const config = validateServerMcpConfig('github', {
      type: 'http', enabled: true, url: 'https://mcp.example.com/api',
    }, policy)

    expect(validateServerMcpOAuthEndpoint('github', 'https://mcp.example.com/oauth/token', config).toString()).toBe('https://mcp.example.com/oauth/token')
    expect(() => validateServerMcpOAuthEndpoint('github', 'http://169.254.169.254/latest/meta-data', config)).toThrow('allowlist')
  })
})
