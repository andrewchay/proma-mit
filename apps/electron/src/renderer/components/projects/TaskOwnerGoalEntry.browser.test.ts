import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'task-owner-goal-browser-'))
beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = directory })
afterAll(() => {
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

/** 隔离 Chromium 中的真实 React/Radix 组件交互；API 是确定性替身，不是 Electron IPC 验收。
 * 无已安装 Chromium 的环境明确跳过，不下载或安装浏览器。
 */
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 无员工/工作区任务 When 打开输入切任务保存重开 Then 懒加载、主体隔离且小窗不溢出', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { TaskOwnerGoalEntry } from ${JSON.stringify(join(renderer, 'components/projects/TaskOwnerGoalEntry.tsx'))};
import { ownerGoalApiAtom } from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
const store = createStore();
const saved = new Map();
window.fixture = { reads: [], writes: [] };
const key = s => JSON.stringify([s.projectId, s.taskId]);
store.set(ownerGoalApiAtom, {
  getOwnerGoalDraft: async subject => { window.fixture.reads.push(subject); return { ok: true, value: saved.get(key(subject)) ?? null }; },
  saveOwnerGoalDraft: async request => {
    window.fixture.writes.push(request);
    const revision = request.expectedRevision + 1;
    const value = { schemaVersion: 1, revision, state: 'draft', actor: 'local-user', savedAt: 1,
      goal: { projectId: request.projectId, taskId: request.taskId, goalVersion: revision, ...request.input } };
    saved.set(key(request), value); return { ok: true, value };
  }
});
function App() {
  const [taskId, setTaskId] = useState('a');
  const [projectId, setProjectId] = useState('fixture-project');
  return <Provider store={store}>
    <button onClick={() => setTaskId(taskId === 'a' ? 'b' : 'a')}>切换任务</button>
    <button onClick={() => setProjectId('another-project')}>切换项目</button>
    <TaskOwnerGoalEntry projectId={projectId} taskId={taskId} taskTitle={'长任务标题'.repeat(120)} />
    <TaskOwnerGoalEntry projectId={projectId} taskId="untouched" taskTitle="未打开的任务" />
  </Provider>;
}
createRoot(document.getElementById('root')).render(<App />);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true,
    platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root,
    nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')],
    alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  writeFileSync(join(directory, 'input.css'), '@tailwind base; @tailwind components; @tailwind utilities;')
  execFileSync(process.execPath, [join(root, 'node_modules/tailwindcss/lib/cli.js'),
    '-i', join(directory, 'input.css'), '-o', join(directory, 'style.css'), '--content',
    [join(renderer, 'components/projects/TaskOwnerGoalEntry.tsx'),
      join(renderer, 'components/projects/ProjectOwnerGoalPanel.tsx'),
      join(renderer, 'components/ui/dialog.tsx')].join(',')], { cwd: root, env: process.env, stdio: 'pipe' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/entry.js' || path === '/style.css') return new Response(Bun.file(join(directory, path.slice(1))))
    return new Response('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 360, height: 480 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}`)
    const trigger = page.getByRole('button', { name: '目标草案', exact: true }).first()
    await trigger.waitFor()
    const fixture = () => page.evaluate(() => (window as unknown as { fixture: { reads: Array<{ taskId: string }>; writes: Array<{ taskId: string; expectedRevision: number; input: { objective: string } }> } }).fixture)
    expect((await fixture()).reads).toHaveLength(0)
    await trigger.click()
    const objective = page.getByLabel('目标', { exact: true })
    await objective.waitFor()
    await page.getByRole('status').filter({ hasText: '尚未保存' }).waitFor()
    expect((await fixture()).reads.map(subject => subject.taskId)).toEqual(['a'])
    const text = '待保存的任务A目标'.repeat(100)
    await objective.fill(text)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '切换任务' }).click()
    await trigger.click()
    await page.getByRole('status').filter({ hasText: '尚未保存' }).waitFor()
    expect(await objective.inputValue()).toBe('')
    await objective.fill('任务B的独立目标')
    await page.getByRole('button', { name: '保存目标草案', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已保存草案' }).waitFor()
    expect((await fixture()).writes.map(request => request.taskId)).toEqual(['b'])
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await trigger.click()
    await page.getByRole('status').filter({ hasText: '已保存草案' }).waitFor()
    expect(await objective.inputValue()).toBe('任务B的独立目标')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '切换任务' }).click()
    await trigger.click()
    await page.getByRole('status').filter({ hasText: '有未保存更改' }).waitFor()
    expect(await objective.inputValue()).toBe(text)
    await page.getByText('必要约束与完成标准（可选）', { exact: true }).click()
    await page.getByLabel('必要约束', { exact: true }).fill('x'.repeat(2000))
    const bounds = await page.getByRole('dialog').boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(480)
    expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const scroll = page.getByRole('dialog').locator('div.overflow-y-auto')
    expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.getByRole('button', { name: '保存目标草案', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '已保存草案' }).waitFor()
    expect((await fixture()).writes).toHaveLength(2)
    expect((await fixture()).writes[1]).toMatchObject({ taskId: 'a', expectedRevision: 0, input: { objective: text } })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '切换项目' }).click()
    await trigger.click()
    await page.getByRole('status').filter({ hasText: '尚未保存' }).waitFor()
    expect(await objective.inputValue()).toBe('')
    expect((await fixture()).reads.some(subject => subject.taskId === 'untouched')).toBe(false)
    expect((await fixture()).writes).toHaveLength(2)
    expect(errors).toEqual([])
  } finally {
    await browser?.close()
    server.stop(true)
  }
}, 60000)
