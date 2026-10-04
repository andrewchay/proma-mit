import { describe, expect, test } from 'bun:test'
import { suggestChannelName } from './channel-name'

describe('suggestChannelName', () => {
  test('官方供应商自动命名', () => {
    expect(suggestChannelName('anthropic', 'https://api.anthropic.com')).toBe('Anthropic')
    expect(suggestChannelName('openai-codex', '')).toBe('ChatGPT 订阅 (Codex)')
  })

  test('第三方端点按域名区分，未填完整时回退到供应商', () => {
    expect(suggestChannelName('openai', 'https://gateway.example.com/v1')).toBe('OpenAI · gateway.example.com')
    expect(suggestChannelName('openai', 'https://')).toBe('OpenAI')
  })

  test('自定义配置按域名识别', () => {
    expect(suggestChannelName('custom', 'https://www.example.com/v1')).toBe('example.com')
    expect(suggestChannelName('custom', '')).toBe('自定义配置')
  })
})
