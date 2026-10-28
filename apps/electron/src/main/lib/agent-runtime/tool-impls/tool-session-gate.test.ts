import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeReadTool } from './read-tool'
import { executeWriteTool } from './write-tool'
import { executeEditTool } from './edit-tool'
import { executeBashToolOnPlatform } from './bash-tool'

const directory = mkdtempSync(join(tmpdir(), 'owner-tool-no-db-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
test('Given 权威项目账本不可用 When 直接调用工具 Then 拒绝读取、写入、编辑和执行', async () => {
  const path = join(directory, 'test.txt')
  writeFileSync(path, 'original')
  const context = { cwd: directory, sessionId: 'no-project-database' }
  const results = await Promise.all([
    executeReadTool({ file_path: 'test.txt' }, context),
    executeWriteTool({ file_path: 'test.txt', content: 'changed' }, context),
    executeEditTool({ file_path: 'test.txt', old_string: 'original', new_string: 'changed' }, context),
    executeBashToolOnPlatform({ command: 'echo changed > test.txt' }, context, 'darwin'),
  ])
  expect(results.every(result => result.isError && result.content.includes('数据库未初始化'))).toBe(true)
  expect(readFileSync(path, 'utf8')).toBe('original')
})
