import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  writeFileSync(join(root, 'sub', 'app.js'), 'window.appLoaded = true')
  writeFileSync(join(root, 'sub', 'style.css'), 'body { color: black }')
  writeFileSync(join(outside, 'escape.html'), '<html></html>')
  symlinkSync(join(outside, 'escape.html'), join(root, 'link.html'))
  symlinkSync(join(outside, 'escape.html'), join(root, 'link.js'))
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

test('Given冻结范围中的页面及脚本样式 When验证 Then只向浏览器传递范围内的真实资源并拒绝越界和链接', async () => {
  let seen: readonly string[] = []
  setOwnerRuntimeBrowserRunner(async input => {
    seen = input.resourcePaths ?? []
    return { checks: [], durationMs: 0, timedOut: false, relativePath: input.filePath }
  })
  await runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: [], resourcePaths: ['sub/app.js', 'sub/style.css'] })
  expect(seen).toEqual([realpathSync(join(root, 'sub/app.js')), realpathSync(join(root, 'sub/style.css'))])
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: [], resourcePaths: ['../escape.js'] })).rejects.toThrow()
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: [], resourcePaths: ['link.js'] })).rejects.toThrow()
  await expect(runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: [], resourcePaths: ['notes.txt'] })).rejects.toThrow()
})

test('Given 两个项目同时申请浏览器验证 When 前一项失败 Then 后一项仅在槽位释放后开始', async () => {
  const order: string[] = []
  let finishFirst: () => void = () => {}
  const firstPending = new Promise<void>(resolve => { finishFirst = resolve })
  setOwnerRuntimeBrowserRunner(async (input) => {
    order.push(input.filePath.split('/').at(-1)!)
    if (order.length === 1) {
      await firstPending
      throw new Error('本次验证被中止')
    }
    return { checks: [], durationMs: 0, timedOut: false, relativePath: input.filePath }
  })
  const first = runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'game.html', intents: [] })
    .then(() => null, (error: unknown) => error)
  const second = runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'sub/inner.html', intents: [] })
  await Promise.resolve()
  expect(order).toEqual(['game.html'])
  finishFirst()
  expect(await first).toEqual(new Error('本次验证被中止'))
  expect((await second).relativePath).toBe('sub/inner.html')
  expect(order).toEqual(['game.html', 'inner.html'])
})

test('Given 验证进程资源超限 When 按进程连续采样 Then 识别持续过载且不继承旧进程的采样', async () => {
  const { createOwnerBrowserResourceLimit } = await import('./owner-runtime-browser-verifier')
  const limit = createOwnerBrowserResourceLimit()
  const metric = (seconds: number, memory: number, creationTime = 1): Electron.ProcessMetric => ({
    pid: 123, type: 'Tab', creationTime,
    cpu: { cumulativeCPUUsage: seconds, idleWakeupsPerSecond: 0, percentCPUUsage: 0 },
    memory: { workingSetSize: memory, peakWorkingSetSize: memory },
  })
  for (let index = 0; index < 4; index++) expect(limit(metric(index, 200 * 1024), index * 1000)).toBeNull()
  expect(limit(metric(4, 200 * 1024), 4000)).toContain('CPU')
  expect(limit(metric(0, 600 * 1024, 2), 5000)).toBeNull()
  expect(limit(metric(0.1, 600 * 1024, 2), 6000)).toContain('内存')
})

test('Given 浏览器验证排队期间授权变化 When 获得槽位 Then 开始前重验并跳过未经授权的页面', async () => {
  let finish: () => void = () => {}
  const running = new Promise<void>(resolve => { finish = resolve })
  const seen: string[] = []
  setOwnerRuntimeBrowserRunner(async input => {
    seen.push(input.filePath)
    await running
    return { checks: [], durationMs: 0, timedOut: false, relativePath: input.filePath }
  })
  let authorized = true
  const first = runOwnerRuntimeBrowserAssertions({ workspaceRoot: root, relativePath: 'game.html', intents: [] })
  const second = runOwnerRuntimeBrowserAssertions({
    workspaceRoot: root, relativePath: 'sub/inner.html', intents: [],
    beforeStart: () => { if (!authorized) throw new Error('授权已撤销') },
  }).then(() => null, (error: unknown) => error)
  await Promise.resolve()
  authorized = false
  finish()
  await first
  expect(await second).toEqual(new Error('授权已撤销'))
  expect(seen).toHaveLength(1)
})
