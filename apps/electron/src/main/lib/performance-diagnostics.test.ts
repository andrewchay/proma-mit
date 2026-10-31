import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startPerformanceDiagnostic } from './performance-diagnostics'
import { assertNoWritableHardlinks } from './agent-runtime/tool-impls/bash-sandbox'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-perf-test-'))
const log = join(temp, 'diagnostics.jsonl')
afterAll(() => { delete process.env.GRAVITAS_PERF_DIAGNOSTICS_PATH; delete process.env.PROMA_TEST_CONFIG_DIR; rmSync(temp, { recursive: true, force: true }) })

test('Given 未启用诊断 When 开始测量 Then 不产生记录', () => {
  delete process.env.GRAVITAS_PERF_DIAGNOSTICS_PATH
  expect(startPerformanceDiagnostic('test')).toBeUndefined()
  expect(existsSync(log)).toBe(false)
})

test('Given 启用诊断 When 扫描目录 Then 记录开始、结束和计数而不记录路径', async () => {
  process.env.GRAVITAS_PERF_DIAGNOSTICS_PATH = log
  const root = join(temp, 'private-root')
  mkdirSync(root)
  writeFileSync(join(root, 'private-file'), 'content')
  await assertNoWritableHardlinks({ writableRoots: [root], writableLiterals: [], denyRoots: [], denyWriteRoots: [], allowAfterDenyRoots: [], finalDenyWriteRoots: [], finalDenyWriteLiterals: [] })
  const text = readFileSync(log, 'utf8')
  const records = text.trim().split('\n').map((line) => JSON.parse(line))
  expect(records).toHaveLength(2)
  expect(records[0]).toMatchObject({ operation: 'bash-hardlinks-reject', event: 'start' })
  expect(records[1]).toMatchObject({ operation: 'bash-hardlinks-reject', event: 'end', status: 'ok', visited: 2, directories: 1, hardlinks: 0 })
  expect(records[0].id).toBe(records[1].id)
  expect(text).not.toContain('private-root')
  expect(text).not.toContain('private-file')
  expect(text).not.toContain('content')
})

test('Given 项目目录不可用 When 扫描失败 Then 仍记录失败且不写入路径', async () => {
  process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config')
  process.env.GRAVITAS_PERF_DIAGNOSTICS_PATH = log
  const { scanProjectFileChanges } = await import('./project-file-changes')
  await expect(scanProjectFileChanges('fixture', join(temp, 'missing-private-root'))).rejects.toThrow()
  const text = readFileSync(log, 'utf8')
  const records = text.trim().split('\n').map((line) => JSON.parse(line))
  const end = records.find((record) => record.operation === 'project-file-scan' && record.event === 'end')
  expect(end).toMatchObject({ status: 'error', files: 0 })
  expect(text).not.toContain('missing-private-root')
})
