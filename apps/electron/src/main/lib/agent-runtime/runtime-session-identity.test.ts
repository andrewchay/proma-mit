import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  assertRuntimeSessionIdentity,
  bindRuntimeSessionIdentity,
  matchesRuntimeSessionIdentity,
  revokeRuntimeSessionIdentity,
} from './runtime-session-identity'

const piIdentity = (overrides: Partial<{ sessionId: string; cwd: string; runtime: 'ai-sdk' | 'pi' | 'proma' }> = {}) => ({
  sessionId: 'session-1',
  cwd: '/tmp/work',
  runtime: 'pi' as const,
  ...overrides,
})

describe('runtime session identity', () => {
  test('Given 未绑定身份的会话对象 When 断言身份 Then 拒绝执行工具', () => {
    const owner = {}
    expect(() => assertRuntimeSessionIdentity(owner, piIdentity())).toThrow('Pi 会话身份不匹配，拒绝执行工具')
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(false)
  })

  test('Given 身份绑定成功 When 使用同一身份比对 Then 匹配且断言通过', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(true)
    expect(() => assertRuntimeSessionIdentity(owner, piIdentity())).not.toThrow()
  })

  test('Given 绑定时 cwd 为相对路径 When 用绝对路径比对 Then 归一后匹配', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity({ cwd: 'sub/dir' }))
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ cwd: resolve('sub/dir') }))).toBe(true)
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ cwd: resolve('.', 'sub', 'dir') }))).toBe(true)
  })

  test('Given 绑定的是 Pi 会话 When 用 AI SDK 或 Proma 身份比对 Then 不匹配且断言拒绝', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ runtime: 'ai-sdk' }))).toBe(false)
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ runtime: 'proma' }))).toBe(false)
    expect(() => assertRuntimeSessionIdentity(owner, piIdentity({ runtime: 'ai-sdk' }))).toThrow('AI SDK 会话身份不匹配，拒绝执行工具')
  })

  test('Given 绑定的是 Pi 会话 When 用其他 sessionId 或 cwd 比对 Then 不匹配且断言拒绝', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ sessionId: 'session-2' }))).toBe(false)
    expect(matchesRuntimeSessionIdentity(owner, piIdentity({ cwd: '/tmp/other' }))).toBe(false)
    expect(() => assertRuntimeSessionIdentity(owner, piIdentity({ sessionId: 'session-2' }))).toThrow('拒绝执行工具')
  })

  test('Given 身份已撤销 When 比对或重新绑定 Then 拒绝', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    revokeRuntimeSessionIdentity(owner)
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(false)
    expect(() => assertRuntimeSessionIdentity(owner, piIdentity())).toThrow('拒绝执行工具')
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity())).toThrow('Pi 会话身份已撤销')
  })

  test('Given 未绑定的对象 When 撤销 Then 不产生副作用且不抛错', () => {
    const owner = {}
    expect(() => revokeRuntimeSessionIdentity(owner)).not.toThrow()
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(false)
  })

  test('Given 活动会话已绑定 When 重复绑定同一身份 Then 幂等', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ cwd: resolve('/tmp/work') }))).not.toThrow()
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(true)
  })

  test('Given 活动会话已绑定 When 绑定其他 sessionId、cwd 或 runtime Then 拒绝改写', () => {
    const owner = {}
    bindRuntimeSessionIdentity(owner, piIdentity())
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ sessionId: 'session-2' }))).toThrow('Pi 活动会话不能重新绑定其他身份')
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ cwd: '/tmp/other' }))).toThrow('Pi 活动会话不能重新绑定其他身份')
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ runtime: 'proma' }))).toThrow('Pi 活动会话不能重新绑定其他身份')
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(true)
  })

  test('Given 身份字段为空 When 绑定 Then 报身份不完整', () => {
    const owner = {}
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ sessionId: '  ' }))).toThrow('Pi 会话身份不完整')
    expect(() => bindRuntimeSessionIdentity(owner, piIdentity({ cwd: '' }))).toThrow('Pi 会话身份不完整')
    expect(matchesRuntimeSessionIdentity(owner, piIdentity())).toBe(false)
  })

  test('Given 绑定跨 Runtime 同名身份 When 断言 Then 各自独立', () => {
    const piOwner = {}
    const promaOwner = {}
    bindRuntimeSessionIdentity(piOwner, piIdentity())
    bindRuntimeSessionIdentity(promaOwner, piIdentity({ runtime: 'proma' }))
    expect(matchesRuntimeSessionIdentity(piOwner, piIdentity({ runtime: 'proma' }))).toBe(false)
    expect(matchesRuntimeSessionIdentity(promaOwner, piIdentity({ runtime: 'proma' }))).toBe(true)
    revokeRuntimeSessionIdentity(promaOwner)
    expect(matchesRuntimeSessionIdentity(piOwner, piIdentity())).toBe(true)
  })
})
