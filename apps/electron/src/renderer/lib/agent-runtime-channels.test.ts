import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { getAgentRuntimeChannelIds, isAgentRuntimeChannelUsable } from './agent-runtime-channels'

function channel(id: string, provider: Channel['provider'], enabled = true, modelEnabled = true): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: 'https://example.com',
    apiKey: 'encrypted',
    enabled,
    createdAt: 1,
    updatedAt: 1,
    models: [{ id: `${id}-model`, name: `${id} model`, enabled: modelEnabled }],
  }
}

describe('agent runtime channel filtering', () => {
  test('given Claude runtime when channels are configured then only selected Claude-compatible channels are returned', () => {
    const channels = [
      channel('anthropic', 'anthropic'),
      channel('deepseek', 'deepseek'),
      channel('openai', 'openai'),
      channel('disabled', 'anthropic', false),
    ]

    expect(getAgentRuntimeChannelIds(channels, ['anthropic', 'openai', 'disabled'], 'claude')).toEqual(['anthropic'])
  })

  test('given Proma runtime when OpenAI-compatible channels exist then compatible enabled channels are returned without Claude whitelist', () => {
    const channels = [
      channel('anthropic', 'anthropic'),
      channel('openai', 'openai'),
      channel('deepseek', 'deepseek'),
      channel('kimi', 'kimi-api'),
      channel('kimi-coding', 'kimi-coding'),
      channel('qwen-disabled-model', 'qwen', true, false),
    ]

    expect(getAgentRuntimeChannelIds(channels, [], 'proma')).toEqual(['openai', 'deepseek', 'kimi', 'kimi-coding'])
  })

  test('given Pi runtime when compatible channels exist then enabled channels are returned without Claude whitelist', () => {
    const channels = [
      channel('openai', 'openai'),
      channel('anthropic', 'anthropic'),
      channel('disabled', 'google', false),
    ]

    expect(getAgentRuntimeChannelIds(channels, [], 'pi')).toEqual(['openai', 'anthropic'])
    expect(isAgentRuntimeChannelUsable(channels, 'openai', [], 'pi')).toBe(true)
  })

  test('given AI SDK runtime when compatible channels exist then enabled channels are returned without Claude whitelist', () => {
    const channels = [
      channel('anthropic', 'anthropic'),
      channel('openai', 'openai'),
      channel('google', 'google'),
      channel('minimax', 'minimax'),
      channel('disabled', 'openai', false),
      channel('model-disabled', 'custom', true, false),
    ]

    expect(getAgentRuntimeChannelIds(channels, [], 'ai-sdk')).toEqual(['anthropic', 'openai', 'google'])
    expect(isAgentRuntimeChannelUsable(channels, 'google', [], 'ai-sdk')).toBe(true)
  })
})
