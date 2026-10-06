import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCapability, hasCapability } from './entitlement-gate'
import { DEV_UNLOCK_ENV } from './dev-unlock'

/**
 * 权益门禁的调试放开行为测试。
 *
 * 放开开关的价值在于「不构造服务端签名快照也能调试付费能力」，但前提是
 * 未设置开关时门禁必须仍然是否决行为——否则这个开关就从调试工具变成了漏洞。
 */
describe('权益门禁 · 调试放开', () => {
  const originalEnv = { ...process.env }
  let tempDir: string

  function useIsolatedConfigDir(): void {
    tempDir = mkdtempSync(join(tmpdir(), 'entitlement-gate-unlock-'))
    process.env.PROMA_TEST_CONFIG_DIR = tempDir
    delete process.env[DEV_UNLOCK_ENV]
  }

  afterEach(() => {
    process.env = { ...originalEnv }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  test('未设置开关时仍然 fail-closed：无权益则拒绝', () => {
    useIsolatedConfigDir()
    expect(hasCapability('knowledge-pro')).toBe(false)
    expect(hasCapability('academic')).toBe(false)
    expect(() => assertCapability('knowledge-pro', '新建笔记')).toThrow()
  })

  test('设置开关后全部付费能力放行，且不要求权益快照', () => {
    useIsolatedConfigDir()
    process.env[DEV_UNLOCK_ENV] = '1'

    expect(hasCapability('knowledge-pro')).toBe(true)
    expect(hasCapability('academic')).toBe(true)
    expect(hasCapability('influencer')).toBe(true)
    expect(() => assertCapability('knowledge-pro', '新建笔记')).not.toThrow()
  })
})
