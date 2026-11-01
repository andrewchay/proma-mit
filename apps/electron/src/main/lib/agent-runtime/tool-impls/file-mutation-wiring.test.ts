/** Write / Edit 必须记账：成功结算、失败留原因、中断可对账。 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildElectronMock } from '../../testing/electron-mock'
import { bindTestToolContext } from '../../testing/bound-tool-context'

const configDir = mkdtempSync(join(tmpdir(), 'file-mutation-wiring-'))
process.env.PROMA_TEST_CONFIG_DIR = configDir
const previous = process.env.PROMA_TEST_CONFIG_DIR
const { mock } = await import('bun:test')
mock.module('electron', () => buildElectronMock())
const { executeWriteTool } = await import('./write-tool')
const { executeEditTool } = await import('./edit-tool')

let workDir = ''
beforeAll(async () => { await (await import('../../project-sqlite-store')).initProjectDb() })
afterAll(async () => {
  const store = await import('../../project-sqlite-store')
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(configDir, { recursive: true, force: true })
})

const ctx = () => bindTestToolContext({ cwd: workDir, sessionId: 'journal-session' })
const journal = () => {
  try { return readFileSync(join(configDir, 'file-mutations.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] }
}

describe('文件写入记账', () => {
  test('Given 写入成功 When 检查账本 Then 有意图与结算两条且状态 ok', async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'w-')))
    const result = await executeWriteTool({ file_path: 'a.txt', content: 'v1' }, ctx())
    expect(result.isError).toBeFalsy()
    const events = journal().filter(event => event.path.endsWith('a.txt'))
    expect(events.map(event => event.type)).toEqual(['intent', 'settled'])
    expect(events.at(-1)).toMatchObject({ status: 'ok' })
  })

  test('Given 写入被拒绝 When 检查账本 Then 保留失败原因', async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'w-')))
    mkdirSync(join(workDir, 'dir'), { recursive: true })
    const result = await executeWriteTool({ file_path: 'dir', content: 'x' }, ctx())
    expect(result.isError).toBe(true)
    const events = journal().filter(event => event.path.endsWith('/dir'))
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'error' })
  })

  test('Given 编辑成功 When 检查账本 Then 记录 Edit 与写入前摘要', async () => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'w-')))
    writeFileSync(join(workDir, 'b.txt'), 'old value')
    const result = await executeEditTool({ file_path: 'b.txt', old_string: 'old', new_string: 'new' }, ctx())
    expect(result.isError).toBeFalsy()
    const events = journal().filter(event => event.path.endsWith('b.txt'))
    expect(events[0]).toMatchObject({ type: 'intent', tool: 'Edit' })
    expect(events[0].preHash).toMatch(/^[a-f0-9]{64}$/)
    expect(events.at(-1)).toMatchObject({ type: 'settled', status: 'ok' })
  })
})
