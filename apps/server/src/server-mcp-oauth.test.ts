import { describe, expect, test } from 'bun:test'
import { createMcpOAuthAuthorizationUrl } from './server-mcp-oauth.ts'

describe('服务端 MCP OAuth', () => {
  test('given a pending state then it creates a standards-compatible authorization-code redirect', () => {
    const url = new URL(createMcpOAuthAuthorizationUrl({ authorizationEndpoint: 'https://auth.example.com/authorize', clientId: 'client-a', redirectUri: 'https://proma.example.com/mcp/oauth/callback', scope: 'read write', state: 'state-a' }))
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('state-a')
    expect(url.searchParams.get('redirect_uri')).toBe('https://proma.example.com/mcp/oauth/callback')
  })
})
