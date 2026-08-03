import { describe, expect, test } from 'bun:test'
import { isClaudeFamilyModel } from './model-family'

describe('isClaudeFamilyModel', () => {
  test('真实 Claude 家族模型返回 true', () => {
    expect(isClaudeFamilyModel('claude-sonnet-4-6')).toBe(true)
    expect(isClaudeFamilyModel('claude-3-5-sonnet-20241022')).toBe(true)
    expect(isClaudeFamilyModel('claude-opus-4-7')).toBe(true)
    expect(isClaudeFamilyModel('claude-sonnet-4-6-latest')).toBe(true)
    expect(isClaudeFamilyModel('CLAUDE-SONNET-4-6')).toBe(true)
  })

  test('代理别名/自定义 fork 含 claude 子串但非真实家族返回 false', () => {
    expect(isClaudeFamilyModel('gateway/claude-proxy')).toBe(false)
    expect(isClaudeFamilyModel('provider:claude-sonnet')).toBe(false)
    expect(isClaudeFamilyModel('my-claude-fork')).toBe(false)
    expect(isClaudeFamilyModel('anthropic/claude-sonnet-4-6')).toBe(false)
    expect(isClaudeFamilyModel('gateway/claude')).toBe(false)
  })

  test('非 Claude 模型返回 false', () => {
    expect(isClaudeFamilyModel('deepseek-v4-pro')).toBe(false)
    expect(isClaudeFamilyModel('deepseek-v4-flash')).toBe(false)
    expect(isClaudeFamilyModel('gpt-4o')).toBe(false)
    expect(isClaudeFamilyModel('kimi-k2')).toBe(false)
    expect(isClaudeFamilyModel('')).toBe(false)
    expect(isClaudeFamilyModel(undefined)).toBe(false)
    expect(isClaudeFamilyModel(null)).toBe(false)
  })
})
