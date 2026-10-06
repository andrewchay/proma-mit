import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ALL_SUBSCRIPTION_CAPABILITIES } from '@gravitas/shared'
import {
  DEV_UNLOCK_ENV,
  __setBuildInjectedUnlockForTest,
  buildDevUnlockedSnapshot,
  describeDevUnlock,
  isDevUnlockEnabled,
} from './dev-unlock'

/**
 * 调试放开开关的行为测试。
 *
 * 这里要守住的核心断言是「默认不放开」：只有显式设置环境变量才生效，
 * 未设置时行为必须与放开功能引入前完全一致。
 */
describe('调试放开开关', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env[DEV_UNLOCK_ENV]
    __setBuildInjectedUnlockForTest(undefined)
  })

  afterEach(() => {
    __setBuildInjectedUnlockForTest(undefined)
    process.env = { ...originalEnv }
  })

  test('未设置环境变量时一律不放开', () => {
    expect(isDevUnlockEnabled()).toBe(false)
    expect(describeDevUnlock()).toBe('未配置')
  })

  test('环境变量不是精确的 1 时不放开，避免 true / yes 之类误开', () => {
    process.env[DEV_UNLOCK_ENV] = 'true'
    expect(isDevUnlockEnabled()).toBe(false)

    process.env[DEV_UNLOCK_ENV] = '0'
    expect(isDevUnlockEnabled()).toBe(false)
  })

  test('显式设为 1 且非打包环境时放开', () => {
    process.env[DEV_UNLOCK_ENV] = '1'
    expect(isDevUnlockEnabled()).toBe(true)
    expect(describeDevUnlock()).toBe('已生效')
  })

  test('放开快照授予全部能力，且不伪造成可验签的签名', () => {
    const now = new Date('2026-09-17T00:00:00.000Z')
    const snapshot = buildDevUnlockedSnapshot(now)

    expect(snapshot.planId).toBe('pro')
    expect(snapshot.status).toBe('active')
    expect(snapshot.lastVerifiedAt).toBe(now.toISOString())
    expect([...snapshot.capabilities].sort()).toEqual([...ALL_SUBSCRIPTION_CAPABILITIES].sort())
    // 不能被 isDevSignature 认成开发签名，也不能是看起来合法的服务端签名。
    // 一旦有人把它接到验签链路，必须失败而不是静默放行。
    expect(snapshot.signature.startsWith('dev.')).toBe(false)
    expect(snapshot.signature).not.toBe('')
  })

  test('构建期注入标记生效时不依赖环境变量', () => {
    __setBuildInjectedUnlockForTest(true)

    expect(isDevUnlockEnabled()).toBe(true)
    expect(describeDevUnlock()).toBe('已生效（构建期注入）')
  })

  test('构建期注入为 false 时不得回落到环境变量以外的东西', () => {
    __setBuildInjectedUnlockForTest(false)
    expect(isDevUnlockEnabled()).toBe(false)

    // 显式置 false 后仍应被运行时路径接管，否则本地调试会被误关
    process.env[DEV_UNLOCK_ENV] = '1'
    __setBuildInjectedUnlockForTest(undefined)
    expect(isDevUnlockEnabled()).toBe(true)
  })

  test('运行时路径可由调用方透传 isPackaged，不依赖进程真实打包状态', () => {
    process.env[DEV_UNLOCK_ENV] = '1'
    expect(isDevUnlockEnabled({ isPackaged: false })).toBe(true)
    expect(isDevUnlockEnabled({ isPackaged: true })).toBe(false)
  })

  test('构建期注入优先于打包状态', () => {
    __setBuildInjectedUnlockForTest(true)
    expect(isDevUnlockEnabled({ isPackaged: true })).toBe(true)
  })
})
