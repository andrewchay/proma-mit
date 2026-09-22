import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generatePairingCode,
  verifyPairingCode,
  issueToken,
  verifyToken,
  _resetForTest,
} from './companion-auth'

/**
 * Companion 认证模块测试（PROMA_TEST_CONFIG_DIR 隔离，不污染真实 ~/.gravitas/）
 */

const testDir = join(tmpdir(), `gravitas-companion-auth-test-${Date.now()}`)

afterEach(() => {
  _resetForTest()
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

describe('companion-auth 配对码', () => {
  test('生成可验证、单次有效、错误码拒绝', () => {
    const code = generatePairingCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(verifyPairingCode(code)).toBe(true)
    // 第二次验证同一码应失败（单次使用，防重放）
    expect(verifyPairingCode(code)).toBe(false)
    expect(verifyPairingCode('000000')).toBe(false)
  })

  test('未生成配对码时验证失败', () => {
    expect(verifyPairingCode('123456')).toBe(false)
  })
})

describe('companion-auth token', () => {
  test('签发后可通过 hash 校验，明文不落盘', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    mkdirSync(testDir, { recursive: true })
    const { token } = await issueToken()
    expect(token.length).toBe(64)
    expect(verifyToken(token)).toBe(true)
    expect(verifyToken('a'.repeat(64))).toBe(false)
    expect(verifyToken(undefined)).toBe(false)
    expect(verifyToken('')).toBe(false)
    // settings 里只允许出现 hash，不允许出现明文 token
    const { getSettings } = await import('./settings-service')
    const raw = JSON.stringify(getSettings())
    expect(raw.includes(token)).toBe(false)
  })

  test('连续签发的新 token 使旧 token 失效', async () => {
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    mkdirSync(testDir, { recursive: true })
    const first = await issueToken()
    const second = await issueToken()
    expect(verifyToken(first.token)).toBe(false)
    expect(verifyToken(second.token)).toBe(true)
  })
})
