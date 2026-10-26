import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOwnerRuntimeBrowserAssertions, setOwnerRuntimeBrowserRunner } from './owner-runtime-browser-verifier'

const root = mkdtempSync(join(tmpdir(), 'owner-runtime-verifier-'))
const outside = mkdtempSync(join(tmpdir(), 'owner-runtime-outside-'))

beforeAll(() => {
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'game.html'), '<html><body>game</body></html>')
  writeFileSync(join(root, 'sub', 'inner.html'), '<html></html>')
  writeFileSync(join(root, 'notes.txt'), 'plain')
  writeFileSync(join(outside, 'escape.html'), '<html></html>')
  symlinkSync(join(outside, 'escape.html'), join(root, 'link.html'))
})

afterAll(() => {
  setOwnerRuntimeBrowserRunner(null)
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

test('Given 工作区内 HTML When 执行验证 Then 交给执行器并按意图选择断言', async () => {
  const seen: string[] = []
  setOwnerRuntimeBrowserRunner(async (input) => {
    seen.push(...input.templates.map(template => template.id))
    return { checks: input.templates.map(template => ({ id: template.id, title: template.title, status: 'passed' as const, detail: 'ok' })), durationMs: 5, timedOut: false, relativePath: input.filePath }
  })
  const result = await runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'game.html', intents: ['棋盘'] })
  expect(seen).toEqual(['dom.board'])
  expect(result.relativePath).toBe('game.html')
  expect(result.checks.every(check => check.status === 'passed')).toBe(true)
})

test('Given 越界路径 When 验证 Then 拒绝且不调用执行器', async () => {
  let called = false
  setOwnerRuntimeBrowserRunner(async () => { called = true; throw new Error('不该被调用') })
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: '../escape.html', intents: [] })).rejects.toThrow('不在工作区内')
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: join(outside, 'escape.html'), intents: [] })).rejects.toThrow('只接受工作区内相对路径')
  expect(called).toBe(false)
})

test('Given 符号链接与非法扩展名 When 验证 Then 拒绝', async () => {
  setOwnerRuntimeBrowserRunner(async () => ({ checks: [], durationMs: 0, timedOut: false, relativePath: '' }))
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'link.html', intents: [] })).rejects.toThrow('符号链接')
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'notes.txt', intents: [] })).rejects.toThrow('只支持验证 HTML')
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'missing.html', intents: [] })).rejects.toThrow('不存在')
})

test('Given 子目录内 HTML When 验证 Then 允许且保留相对子路径', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({ checks: [{ id: 'html.loads', title: '加载', status: 'passed' as const, detail: 'ok' }], durationMs: 1, timedOut: false, relativePath: input.filePath }))
  const result = await runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: ['加载'] })
  expect(result.relativePath).toBe('sub/inner.html')
})
