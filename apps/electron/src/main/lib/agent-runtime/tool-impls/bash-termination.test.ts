import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeBashTermination, runBashCommand, type BashTerminationEvidence } from './bash-termination'

const cwd = mkdtempSync(join(tmpdir(), 'bash-termination-'))
const sh = (command: string) => ['/bin/sh', '-c', command]

const run = (command: string, options: { timeout?: number; abortSignal?: AbortSignal } = {}) =>
  runBashCommand({ argv: sh(command), cwd, env: process.env, timeout: options.timeout ?? 10_000, abortSignal: options.abortSignal })

const killGroup = (pgid: number) => {
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // 已退出。
  }
}

describe('runBashCommand（终止证据）', () => {
  test('Given 正常命令 When 自行退出 Then 证据为 exited 且进程组已空', async () => {
    const result = await run('echo hello')
    expect(result.stdout.trim()).toBe('hello')
    expect(result.failure).toBeUndefined()
    expect(result.evidence.status).toBe('exited')
    expect(result.evidence.requestedBy).toBe('completion')
    expect(result.evidence.exitCode).toBe(0)
    expect(result.evidence.groupAlive).toBe(false)
    expect(result.evidence.signals).toEqual([])
    expect(describeBashTermination(result.evidence)).toBeUndefined()
  })

  test('Given 命令超时 When 到期 Then 整组终止且确认退出', async () => {
    const result = await run('sleep 30', { timeout: 200 })
    expect(result.failure?.isError).toBe(true)
    expect(result.failure?.message).toContain('超时')
    expect(result.evidence.requestedBy).toBe('timeout')
    expect(result.evidence.status).toBe('terminated')
    expect(result.evidence.groupAlive).toBe(false)
    expect(result.evidence.signals.map((s) => s.signal)).toContain('SIGTERM')
    expect(describeBashTermination(result.evidence)).toContain('已确认退出')
  })

  test('Given 会话中止 When 发出 abort Then 命令终止且标记为中止', async () => {
    const controller = new AbortController()
    const pending = run('sleep 30', { abortSignal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(result.failure?.isError).toBe(true)
    expect(result.failure?.message).toContain('中止')
    expect(result.evidence.requestedBy).toBe('abort')
    expect(result.evidence.status).toBe('terminated')
    expect(result.evidence.groupAlive).toBe(false)
  })

  test('Given 命令内部后台子进程 When 主命令退出 Then 不谎称已终止', async () => {
    const result = await run('sleep 20 & echo done')
    try {
      expect(result.stdout).toContain('done')
      expect(result.failure).toBeUndefined()
      // 主命令已结束，但进程组仍有成员存活：必须是 unconfirmed 而不是 exited。
      expect(result.evidence.status).toBe('unconfirmed')
      expect(result.evidence.groupAlive).toBe(true)
      expect(describeBashTermination(result.evidence)).toContain('终止未确认')
    } finally {
      killGroup(result.evidence.pgid)
    }
  })

  test('Given 后台进程忽略 SIGTERM When 超时 Then 升级 SIGKILL 并确认退出', async () => {
    const result = await run("trap '' TERM; sleep 30", { timeout: 200 })
    expect(result.evidence.requestedBy).toBe('timeout')
    expect(result.evidence.signals.map((s) => s.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result.evidence.status).toBe('terminated')
    expect(result.evidence.groupAlive).toBe(false)
  })

  test('Given 命令非零退出 When 执行 Then 标记失败并保留 stderr', async () => {
    const result = await run('echo boom >&2; exit 3')
    expect(result.failure?.isError).toBe(true)
    expect(result.failure?.message).toContain('退出码 3')
    expect(result.failure?.message).toContain('boom')
    // 非零退出属于"命令自己结束"，不是终止未确认。
    expect(result.evidence.status).toBe('exited')
  })

  test('Given 已中止的信号 When 启动前就是 aborted Then 不执行命令', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run('sleep 30', { abortSignal: controller.signal })
    expect(result.failure?.message).toContain('中止')
    expect(result.evidence.status).toBe('terminated')
    expect(result.stdout).toBe('')
  })
})

describe('describeBashTermination（文案）', () => {
  const base: BashTerminationEvidence = {
    requestedBy: 'completion',
    pgid: 4321,
    signals: [],
    groupAlive: false,
    status: 'exited',
    exitCode: 0,
    exitSignal: null,
    durationMs: 10,
  }

  test('Given 正常退出 When 描述 Then 无输出', () => {
    expect(describeBashTermination(base)).toBeUndefined()
  })

  test('Given 超时终止 When 描述 Then 含信号链与进程组', () => {
    const text = describeBashTermination({ ...base, requestedBy: 'timeout', status: 'terminated', signals: [{ signal: 'SIGTERM', at: 5 }] })
    expect(text).toContain('超时')
    expect(text).toContain('SIGTERM')
    expect(text).toContain('4321')
  })

  test('Given 未确认 When 描述 Then 明确不能视为已终止', () => {
    const text = describeBashTermination({ ...base, status: 'unconfirmed', groupAlive: true })
    expect(text).toContain('终止未确认')
    expect(text).toContain('不能视为已终止')
  })
})
