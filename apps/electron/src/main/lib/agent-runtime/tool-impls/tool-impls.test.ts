/**
 * Agent Runtime 核心工具单元测试
 *
 * 验证 Read / Write / Edit / Bash / Grep 五个基础工具的正确性。
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeReadTool, createReadToolDefinition } from './read-tool'
import { executeWriteTool, createWriteToolDefinition } from './write-tool'
import { executeEditTool, createEditToolDefinition } from './edit-tool'
import { executeBashTool, createBashToolDefinition } from './bash-tool'
import { executeGrepTool, createGrepToolDefinition } from './grep-tool'

describe('Agent Runtime 核心工具', () => {
  let tempDir: string
  let sessionId: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'proma-agent-runtime-test-'))
    sessionId = `test-session-${Date.now()}`
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  test('Read 工具读取文件内容', async () => {
    const filePath = join(tempDir, 'hello.txt')
    writeFileSync(filePath, 'hello world\nline 2', 'utf-8')

    const result = await executeReadTool({ file_path: 'hello.txt' }, { cwd: tempDir, sessionId })

    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('hello world\nline 2')
  })

  test('Read 工具支持 offset 和 limit', async () => {
    const filePath = join(tempDir, 'multi.txt')
    writeFileSync(filePath, 'a\nb\nc\nd\ne', 'utf-8')

    const result = await executeReadTool({ file_path: 'multi.txt', offset: 1, limit: 2 }, { cwd: tempDir, sessionId })

    expect(result.content).toBe('b\nc')
  })

  test('Read 工具拒绝越界路径', async () => {
    const result = await executeReadTool({ file_path: '../etc/passwd' }, { cwd: tempDir, sessionId })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('路径越界')
  })

  test('Write 工具写入文件', async () => {
    const result = await executeWriteTool(
      { file_path: 'subdir/test.txt', content: 'new content' },
      { cwd: tempDir, sessionId },
    )

    expect(result.isError).toBeFalsy()
    expect(existsSync(join(tempDir, 'subdir/test.txt'))).toBe(true)
    expect(readFileSync(join(tempDir, 'subdir/test.txt'), 'utf-8')).toBe('new content')
  })

  test('Edit 工具替换文本', async () => {
    const filePath = join(tempDir, 'edit.txt')
    writeFileSync(filePath, 'foo bar baz', 'utf-8')

    const result = await executeEditTool(
      { file_path: 'edit.txt', old_string: 'bar', new_string: 'qux' },
      { cwd: tempDir, sessionId },
    )

    expect(result.isError).toBeFalsy()
    expect(readFileSync(filePath, 'utf-8')).toBe('foo qux baz')
  })

  test('Edit 工具拒绝不唯一匹配', async () => {
    const filePath = join(tempDir, 'dup.txt')
    writeFileSync(filePath, 'a a a', 'utf-8')

    const result = await executeEditTool(
      { file_path: 'dup.txt', old_string: 'a', new_string: 'b' },
      { cwd: tempDir, sessionId },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('必须唯一')
  })

  test('Bash 工具执行命令', async () => {
    const result = await executeBashTool({ command: 'echo hello' }, { cwd: tempDir, sessionId })

    expect(result.isError).toBeFalsy()
    expect(result.content?.trim()).toBe('hello')
  })

  test('Grep 工具搜索内容', async () => {
    writeFileSync(join(tempDir, 'a.txt'), 'target line\nother', 'utf-8')
    writeFileSync(join(tempDir, 'b.txt'), 'no match', 'utf-8')

    const result = await executeGrepTool({ regex: 'target' }, { cwd: tempDir, sessionId })

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('target line')
  })

  test('Grep 工具不存在 shell 注入', async () => {
    writeFileSync(join(tempDir, 'safe.txt'), 'hello', 'utf-8')
    const injectedPath = join(tempDir, 'injected_by_grep')

    const result = await executeGrepTool(
      { regex: '$(touch "' + injectedPath.replace(/"/g, '\\"') + '")' },
      { cwd: tempDir, sessionId },
    )

    // 无论搜索是否命中，都不应创建注入文件
    expect(existsSync(injectedPath)).toBe(false)
    expect(result.isError).toBeFalsy()
  })

  test('Read 工具拒绝 symlink 路径绕过', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'proma-agent-runtime-outside-'))
    const outsideFile = join(outsideDir, 'secret.txt')
    writeFileSync(outsideFile, 'outside-secret', 'utf-8')

    try {
      symlinkSync(outsideFile, join(tempDir, 'link.txt'))

      const result = await executeReadTool({ file_path: 'link.txt' }, { cwd: tempDir, sessionId })

      expect(result.isError).toBe(true)
      expect(result.content).toContain('路径越界')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('Write 工具拒绝 symlink 目录绕过', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'proma-agent-runtime-outside-'))

    try {
      symlinkSync(outsideDir, join(tempDir, 'linkdir'), 'dir')

      const result = await executeWriteTool(
        { file_path: 'linkdir/evil.txt', content: 'pwned' },
        { cwd: tempDir, sessionId },
      )

      expect(result.isError).toBe(true)
      expect(result.content).toContain('路径越界')
    } finally {
      rmSync(outsideDir, { recursive: true, force: true })
    }
  })

  test('工具定义符合预期', () => {
    expect(createReadToolDefinition().name).toBe('Read')
    expect(createWriteToolDefinition().name).toBe('Write')
    expect(createEditToolDefinition().name).toBe('Edit')
    expect(createBashToolDefinition().name).toBe('Bash')
    expect(createGrepToolDefinition().name).toBe('Grep')
  })
})
