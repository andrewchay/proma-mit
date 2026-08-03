import { describe, expect, test, mock } from 'bun:test'

// 拦截 electron 依赖（channel-manager 需要 safeStorage）
mock.module('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (buf: Buffer) => buf.toString('utf-8'),
  },
}))

const { isVisionRelayEligibleForModel } = await import('./vision-relay-service')

describe('isVisionRelayEligibleForModel', () => {
  test('DeepSeek V4 系列模型返回 true', () => {
    expect(isVisionRelayEligibleForModel('deepseek-v4-pro')).toBe(true)
    expect(isVisionRelayEligibleForModel('deepseek-v4-flash')).toBe(true)
    expect(isVisionRelayEligibleForModel('DEEPSEEK-V4-PRO')).toBe(true)
  })

  test('其他模型返回 false', () => {
    expect(isVisionRelayEligibleForModel('deepseek-v3')).toBe(false)
    expect(isVisionRelayEligibleForModel('deepseek-chat')).toBe(false)
    expect(isVisionRelayEligibleForModel('claude-sonnet-4-6')).toBe(false)
    expect(isVisionRelayEligibleForModel('gpt-4o')).toBe(false)
    expect(isVisionRelayEligibleForModel('')).toBe(false)
    expect(isVisionRelayEligibleForModel(undefined)).toBe(false)
  })
})
