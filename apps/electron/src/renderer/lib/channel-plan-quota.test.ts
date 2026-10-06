import { describe, expect, test } from 'bun:test'
import { supportsChannelPlanQuota } from './channel-plan-quota'

describe('supportsChannelPlanQuota', () => {
  test('OAuth 订阅渠道参与额度查询', () => {
    expect(supportsChannelPlanQuota({ provider: 'openai-codex', baseUrl: '' })).toBe(true)
    expect(supportsChannelPlanQuota({ provider: 'github-copilot', baseUrl: '' })).toBe(true)
  })

  test('普通渠道不查询，无关端点不误报', () => {
    expect(supportsChannelPlanQuota({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })).toBe(false)
    expect(supportsChannelPlanQuota({ provider: 'custom', baseUrl: 'https://example.com/v1' })).toBe(false)
  })
})
