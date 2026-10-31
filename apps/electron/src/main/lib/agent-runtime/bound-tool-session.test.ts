import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from '../testing/electron-mock'
import { bindTestToolContext } from '../testing/bound-tool-context'
import { executeReadTool } from './tool-impls/read-tool'

const directory = mkdtempSync(join(tmpdir(), 'bound-tool-session-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('../agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('../project-sqlite-store')
const { assertBoundToolSession, resolveOwnerExecutionGateSession } = await import('../project-owner-execution-gates')
const { revokeRuntimeSessionIdentity } = await import('./runtime-session-identity')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

/** 构造运行时时已绑定身份的会话对象，并按适配器的方式自引用写入 boundSession。 */
function boundOwner(
  sessionId: string,
  cwd: string,
  runtime: 'ai-sdk' | 'pi' | 'proma' = 'ai-sdk',
): { sessionId: string; cwd: string; boundSession?: object; runtime?: 'ai-sdk' | 'pi' | 'proma' } {
  return bindTestToolContext({ sessionId, cwd }, runtime)
}

describe('bound tool session gate', () => {
  test('Given 已绑定的会话对象 When sessionId 与 cwd 均一致 Then 放行', () => {
    const ctx = boundOwner('session-1', '/tmp/work')
    expect(() => assertBoundToolSession(ctx)).not.toThrow()
  })

  test('Given 已绑定的会话对象 When 传入其他 sessionId Then 拒绝为身份与会话不一致', () => {
    const ctx = boundOwner('session-1', '/tmp/work')
    expect(() => assertBoundToolSession({ ...ctx, sessionId: 'session-2' })).toThrow('身份与会话不一致')
  })

  test('Given 已绑定的会话对象 When 传入其他 cwd Then 拒绝为工作目录不一致', () => {
    const ctx = boundOwner('session-1', '/tmp/work')
    expect(() => assertBoundToolSession({ ...ctx, cwd: '/tmp/other' })).toThrow('工作目录与会话身份不一致')
  })

  test('Given 会话身份已撤销 When 校验绑定 Then 拒绝为绑定已失效', () => {
    const ctx = boundOwner('session-1', '/tmp/work')
    revokeRuntimeSessionIdentity(ctx.boundSession!)
    expect(() => assertBoundToolSession(ctx)).toThrow('绑定已失效')
  })

  test('Given 普通会话未携带绑定对象 When 校验 Then 拒绝为缺少绑定身份', () => {
    const sessionId = randomUUID()
    expect(resolveOwnerExecutionGateSession(sessionId).kind).toBe('unrestricted')
    expect(() => assertBoundToolSession({ sessionId })).toThrow('缺少已绑定的会话身份')
  })

  test('Given 普通会话未携带绑定对象 When 直接调用 Read 工具 Then 拒绝执行', async () => {
    const sessionId = randomUUID()
    const cwd = mkdtempSync(join(directory, 'unbound-read-'))
    writeFileSync(join(cwd, 'note.txt'), 'hello\n')
    expect(resolveOwnerExecutionGateSession(sessionId).kind).toBe('unrestricted')
    const result = await executeReadTool({ file_path: 'note.txt' }, { sessionId, cwd })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('缺少已绑定的会话身份')
  })

  test('Given 同一普通会话已绑定身份 When 直接调用 Read 工具 Then 读取成功（对照）', async () => {
    const sessionId = randomUUID()
    const cwd = mkdtempSync(join(directory, 'bound-read-'))
    writeFileSync(join(cwd, 'note.txt'), 'hello\n')
    const result = await executeReadTool({ file_path: 'note.txt' }, bindTestToolContext({ sessionId, cwd }))
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('hello')
  })

  test('Given 伪造的未绑定对象 When 写入 boundSession 后校验 Then 拒绝为绑定已失效', () => {
    const ctx = { sessionId: randomUUID(), cwd: '/tmp/work', boundSession: {} }
    expect(resolveOwnerExecutionGateSession(ctx.sessionId).kind).toBe('unrestricted')
    expect(() => assertBoundToolSession(ctx)).toThrow('绑定已失效')
  })

  test('Given 绑定的是 Pi 会话 When 以 AI SDK 身份校验 Then 拒绝为 Runtime 不一致', () => {
    const ctx = boundOwner('session-pi', '/tmp/work', 'pi')
    expect(() => assertBoundToolSession({ ...ctx, runtime: 'ai-sdk' })).toThrow('Runtime 与会话绑定不一致')
    expect(() => assertBoundToolSession({ ...ctx, runtime: 'pi' })).not.toThrow()
  })

  test('Given 未声明 Runtime When 校验绑定 Then 只比对 sessionId 与 cwd', () => {
    const ctx = boundOwner('session-pi', '/tmp/work', 'pi')
    const { runtime: _runtime, ...withoutRuntime } = ctx
    expect(() => assertBoundToolSession(withoutRuntime)).not.toThrow()
  })
})
