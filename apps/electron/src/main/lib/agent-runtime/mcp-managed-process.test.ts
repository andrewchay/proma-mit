import { describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startManagedMcpProcess } from './mcp-managed-process'

describe('受管 MCP 进程组', () => {
  test.skipIf(process.platform === 'win32')('Given 本地 stdio 服务 When 启动与停止 Then 透明传递输入输出且停止结果不伪称全树退出', async () => {
    const script = `process.stdin.on('data', chunk => process.stdout.write(chunk)); process.stdout.write('ready\\n')`
    const managed = await startManagedMcpProcess({ command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: { ...process.env } })
    try {
      const [first] = await once(managed.stdout, 'data')
      expect(String(first)).toContain('ready')
      const response = once(managed.stdout, 'data')
      managed.stdin.write('hello\n')
      expect(String((await response)[0])).toContain('hello')
    } finally {
      const result = await managed.close()
      expect(result.status).toBe('unconfirmed')
      expect(result.reason).toContain('脱离进程组')
    }
  }, 15_000)
  test.skipIf(process.platform === 'win32')('Given 同组后代计划写入 When 监督者停止 Then 后代不能继续执行', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-managed-'))
    const marker = join(directory, 'marker')
    const script = `const { spawn } = require('node:child_process'); spawn('/bin/sh', ['-c', 'sleep 2; touch "$1"', 'sh', ${JSON.stringify(marker)}]); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
    const managed = await startManagedMcpProcess({ command: process.execPath, args: ['-e', script], cwd: directory, env: { ...process.env } })
    try {
      await once(managed.stdout, 'data')
      await managed.close()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(existsSync(marker)).toBe(false)
    } finally {
      await managed.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test.skipIf(process.platform === 'win32')('Given 父侧控制通道意外断开 When 监督者仍存活 Then 停止同组后代', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-managed-disconnect-'))
    const marker = join(directory, 'marker')
    const script = `const { spawn } = require('node:child_process'); spawn('/bin/sh', ['-c', 'sleep 2; touch "$1"', 'sh', ${JSON.stringify(marker)}]); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`
    const managed = await startManagedMcpProcess({ command: process.execPath, args: ['-e', script], cwd: directory, env: { ...process.env } })
    try {
      await once(managed.stdout, 'data')
      const exited = once(managed.process, 'exit')
      managed.process.disconnect()
      await exited
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(existsSync(marker)).toBe(false)
      expect((await managed.close()).status).toBe('unconfirmed')
    } finally {
      await managed.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test.skipIf(process.platform === 'win32')('Given 应用侧 stdout 管道断开 When 服务继续输出 Then 监督者停止同组后代', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-managed-pipe-'))
    const marker = join(directory, 'marker')
    const script = `const { spawn } = require('node:child_process'); spawn('/bin/sh', ['-c', 'sleep 2; touch "$1"', 'sh', ${JSON.stringify(marker)}]); process.stdout.write('ready\\n'); setInterval(() => process.stdout.write('data\\n'), 20)`
    const managed = await startManagedMcpProcess({ command: process.execPath, args: ['-e', script], cwd: directory, env: { ...process.env } })
    try {
      await once(managed.stdout, 'data')
      managed.stdout.destroy()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      expect(existsSync(marker)).toBe(false)
    } finally {
      await managed.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)

  test.skipIf(process.platform === 'win32')('Given 目标命令不存在 When 启动 Then 返回错误而不声称连接成功', async () => {
    await expect(startManagedMcpProcess({ command: '/not-a-real-mcp-command', cwd: process.cwd(), env: { ...process.env } })).rejects.toThrow()
  }, 10_000)

})
