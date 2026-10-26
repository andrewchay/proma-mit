import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setOwnerRuntimeBrowserRunner } from './owner-runtime-browser-verifier'
import { executeBrowserVerificationCommand, isBrowserVerificationCommand, parseBrowserVerificationCheckIds, selectBrowserVerificationTargets } from './owner-runtime-verification-command'

const root = mkdtempSync(join(tmpdir(), 'owner-browser-cmd-'))

beforeAll(() => {
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<html></html>')
  writeFileSync(join(root, 'dist', 'app.html'), '<html></html>')
  writeFileSync(join(root, 'readme.md'), '# x')
})

afterAll(() => {
  setOwnerRuntimeBrowserRunner(null)
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => setOwnerRuntimeBrowserRunner(null))

test('Given browser 前缀命令 When 判断来源 Then 只有该前缀算浏览器验证', () => {
  expect(isBrowserVerificationCommand('browser:html.loads')).toBe(true)
  expect(isBrowserVerificationCommand('node verify.cjs')).toBe(false)
})

test('Given 合法命令 When 解析断言 Then 按顺序返回标识', () => {
  expect(parseBrowserVerificationCheckIds('browser:html.loads+dom.board')).toEqual(['html.loads', 'dom.board'])
})

test('Given 空/重复/未知断言 When 解析 Then 一律报错而不是静默忽略', () => {
  expect(() => parseBrowserVerificationCheckIds('browser:')).toThrow('缺少断言标识')
  expect(() => parseBrowserVerificationCheckIds('browser:dom.board+dom.board')).toThrow('重复断言标识')
  expect(() => parseBrowserVerificationCheckIds('browser:not.exists')).toThrow('未知的运行验证断言标识')
})

test('Given 研发范围 When 挑选目标 Then 只取工作区内已存在的 HTML', () => {
  expect(selectBrowserVerificationTargets(root, ['index.html', 'dist/app.html', 'readme.md', 'missing.html', '../outside.html'])).toEqual(['index.html', 'dist/app.html'])
  expect(() => selectBrowserVerificationTargets(root, ['readme.md'])).toThrow('没有可验证的 HTML 目标文件')
})

test('Given 断言全部通过 When 执行命令 Then 退出码 0 且带输出摘要', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({
    checks: input.templates.map(template => ({ id: template.id, title: template.title, status: 'passed' as const, detail: 'ok' })),
    durationMs: 3,
    timedOut: false,
    relativePath: '',
  }))
  const outcome = await executeBrowserVerificationCommand({ workspaceRoot: root, targetPaths: ['index.html'], command: 'browser:html.loads+dom.board', timeoutMs: 30_000 })
  expect(outcome.exitCode).toBe(0)
  expect(outcome.checks.map(check => check.id)).toEqual(['html.loads', 'dom.board'])
  expect(outcome.rawOutputSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(outcome.rawOutputByteLength).toBeGreaterThan(0)
})

test('Given 断言失败 When 执行命令 Then 退出码非 0 供既有门禁判定', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({
    checks: input.templates.map((template, index) => ({ id: template.id, title: template.title, status: (index === 0 ? 'failed' : 'passed') as 'failed' | 'passed', detail: 'x' })),
    durationMs: 3,
    timedOut: false,
    relativePath: '',
  }))
  const outcome = await executeBrowserVerificationCommand({ workspaceRoot: root, targetPaths: ['index.html'], command: 'browser:dom.board', timeoutMs: 30_000 })
  expect(outcome.exitCode).toBe(1)
})

test('Given 超时 When 执行命令 Then 标记 timedOut 且退出码非 0', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({
    checks: input.templates.map(template => ({ id: template.id, title: template.title, status: 'passed' as const, detail: 'ok' })),
    durationMs: 1,
    timedOut: true,
    relativePath: '',
  }))
  const outcome = await executeBrowserVerificationCommand({ workspaceRoot: root, targetPaths: ['index.html'], command: 'browser:html.loads', timeoutMs: 30_000 })
  expect(outcome.timedOut).toBe(true)
  expect(outcome.exitCode).toBe(1)
})

test('Given 多目标 When 执行命令 Then 断言标识带文件前缀且仍按文件聚合', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({
    checks: input.templates.map(template => ({ id: template.id, title: template.title, status: 'passed' as const, detail: 'ok' })),
    durationMs: 2,
    timedOut: false,
    relativePath: '',
  }))
  const outcome = await executeBrowserVerificationCommand({ workspaceRoot: root, targetPaths: ['index.html', 'dist/app.html'], command: 'browser:html.loads', timeoutMs: 30_000 })
  expect(outcome.checks.map(check => check.id)).toEqual(['index.html#html.loads', 'dist/app.html#html.loads'])
  expect(outcome.exitCode).toBe(0)
})

test('Given 断言被跳过 When 执行命令 Then 不算通过（跳过不能凑绿）', async () => {
  setOwnerRuntimeBrowserRunner(async (input) => ({
    checks: input.templates.map((template, index) => ({ id: template.id, title: template.title, status: (index === 0 ? 'skipped' : 'passed') as 'skipped' | 'passed', detail: '不适用' })),
    durationMs: 2,
    timedOut: false,
    relativePath: '',
  }))
  const outcome = await executeBrowserVerificationCommand({ workspaceRoot: root, targetPaths: ['index.html'], command: 'browser:dom.board+storage.best-score', timeoutMs: 30_000 })
  expect(outcome.exitCode).toBe(1)
  expect(outcome.checks[0]?.status).toBe('skipped')
})
