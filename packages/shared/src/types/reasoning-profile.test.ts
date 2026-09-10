import { describe, expect, test } from 'bun:test'
import {
  encodeReasoningEffort,
  inferReasoningTransport,
  normalizeReasoningCapabilityLevel,
  resolveReasoningProfile,
} from './reasoning-profile'

/**
 * 推理等级矩阵（reasoning profile）行为测试：
 *
 * - 模型 ID + transport 双重匹配才返回 profile（防止把 reasoning_effort 发错协议端点）
 * - 等级归一化：请求档位不可用时向高档靠拢、恒思考模型保守升 high
 * - effortMap 编码：每个产品等级映射到目标协议参数值
 */

describe('resolveReasoningProfile：模型 ID + transport 匹配', () => {
  test('DeepSeek v4 flash 在 anthropic-messages 命中，openai-completions 不命中', () => {
    expect(resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })?.id).toBe('deepseek-v4-flash')
    expect(resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'openai-completions' })).toBeUndefined()
  })

  test('K3 双协议都命中', () => {
    expect(resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'anthropic-messages' })?.id).toBe('kimi-k3')
    expect(resolveReasoningProfile({ modelId: 'k3-256k', transport: 'openai-completions' })?.id).toBe('kimi-k3')
  })

  test('GLM 5.3 不暴露 off；5.2 有 off', () => {
    const glm53 = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })
    expect(glm53?.levels.includes('off')).toBe(false)
    const glm52 = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages' })
    expect(glm52?.levels.includes('off')).toBe(true)
  })

  test('OpenAI reasoning 模型只在 openai transport 命中', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-5.2', transport: 'openai-completions' })?.id).toBe('openai-reasoning-standard')
    expect(resolveReasoningProfile({ modelId: 'gpt-5.2', transport: 'anthropic-messages' })).toBeUndefined()
    expect(resolveReasoningProfile({ modelId: 'gpt-5.6', transport: 'openai-responses' })?.id).toBe('openai-reasoning-max')
    expect(resolveReasoningProfile({ modelId: 'gpt-5.2-chat-latest', transport: 'openai-completions' })).toBeUndefined()
  })

  test('gpt-6-astra 命中 astra profile', () => {
    expect(resolveReasoningProfile({ modelId: 'gpt-6-astra', transport: 'openai-responses' })?.id).toBe('openai-reasoning-astra')
  })
})

describe('inferReasoningTransport：渠道归类', () => {
  test('OpenAI 系走 completions/responses，Anthropic 兼容走 anthropic-messages，google other', () => {
    expect(inferReasoningTransport('openai')).toBe('openai-completions')
    expect(inferReasoningTransport('openai-responses')).toBe('openai-responses')
    expect(inferReasoningTransport('deepseek')).toBe('anthropic-messages')
    expect(inferReasoningTransport('google')).toBe('other')
    expect(inferReasoningTransport(undefined)).toBe('anthropic-messages')
  })
})

describe('normalizeReasoningCapabilityLevel：档位归一化', () => {
  test('可用档位原样通过', () => {
    const profile = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    expect(normalizeReasoningCapabilityLevel(profile, 'max')).toBe('max')
  })

  test('未指定档位用 profile 默认档', () => {
    const profile = resolveReasoningProfile({ modelId: 'kimi-k3', transport: 'anthropic-messages' })
    expect(normalizeReasoningCapabilityLevel(profile, undefined)).toBe('high')
  })

  test('GLM-5.3 请求 off：恒思考模型归到最低可用档 low（不暴露 off）', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.3', transport: 'anthropic-messages' })
    expect(normalizeReasoningCapabilityLevel(profile, 'off')).toBe('low')
  })

  test('medium 归一到 DeepSeek v4 的可用档 high', () => {
    const profile = resolveReasoningProfile({ modelId: 'deepseek-v4-flash', transport: 'anthropic-messages' })
    const normalized = normalizeReasoningCapabilityLevel(profile, 'medium')
    expect(['low', 'high', 'xhigh', 'max']).toContain(normalized)
  })
})

describe('encodeReasoningEffort：effortMap 编码', () => {
  test('OpenAI 标准：off → none（否则默认 medium）', () => {
    const profile = resolveReasoningProfile({ modelId: 'gpt-5.2', transport: 'openai-completions' })
    expect(encodeReasoningEffort(profile!, 'openai-completions', 'off')).toBe('none')
    expect(encodeReasoningEffort(profile!, 'openai-completions', 'xhigh')).toBe('xhigh')
  })

  test('DeepSeek v4 pro：low 档映射为 high（官方映射）', () => {
    const profile = resolveReasoningProfile({ modelId: 'deepseek-v4-pro', transport: 'anthropic-messages' })
    expect(encodeReasoningEffort(profile!, 'anthropic-messages', 'low')).toBe('high')
    expect(encodeReasoningEffort(profile!, 'anthropic-messages', 'xhigh')).toBe('max')
  })

  test('GLM-5.2 anthropic：低档全部映射 high（不存在更低档）', () => {
    const profile = resolveReasoningProfile({ modelId: 'glm-5.2', transport: 'anthropic-messages' })
    expect(encodeReasoningEffort(profile!, 'anthropic-messages', 'low')).toBe('high')
    expect(encodeReasoningEffort(profile!, 'anthropic-messages', 'max')).toBe('max')
  })
})
