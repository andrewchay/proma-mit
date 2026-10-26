import { afterAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const original = process.env.PROMA_TEST_CONFIG_DIR
const directory = mkdtempSync(join(tmpdir(), 'owner-plan-browser-'))
process.env.PROMA_TEST_CONFIG_DIR = directory
afterAll(() => { if (original === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = original; rmSync(directory, { recursive: true, force: true }) })
/** 真实 Chromium/React 交互，计划 API 是确定性替身，不是 Electron/数据库验收。 */
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 计划替身 When 空态/修订确认/stale/冲突/晚到主体切换 Then 零生成且输入保护', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { ProjectOwnerPlanPanel } from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerPlanPanel.tsx'))};
import { getOwnerGoalEditor, ownerGoalEditorsAtom } from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import { ownerPlanApiAtom, loadOwnerPlanAtom } from ${JSON.stringify(join(renderer, 'atoms/project-owner-plan-atoms.ts'))};
const store = createStore();
function goal(projectId) { return { schemaVersion: 1, revision: 1, state: 'draft', actor: 'local-user', savedAt: 1, goal: { projectId, goalVersion: 1, objective: '目标', constraints: [], acceptanceCriteria: [] } }; }
function plan(projectId = 'a', revision = 1, state = 'proposed') { return { projectId, schemaVersion: 1, revision, planVersion: revision, goalRevision: 1, goalVersion: 1, state, actor: 'local-user', origin: 'manual', savedAt: 1, changeReason: '原依据', contextFingerprint: 'context', planFingerprint: 'p'+revision, sources: { project: { id: projectId, title: '项目'+projectId, description: '' }, roles: [{ key: 'research', name: '研究岗位', version: '1', sourceSha256: 's', rulesSha256: 'r' }] }, proposal: { projectId, goalVersion: 1, mode: 'proposal_only', summary: '计划'+projectId+revision, assumptions: ['假设'], risks: ['风险'], steps: [{ key: 's1', title: '研究', outcome: '报告', acceptanceCriteria: ['可评审'], dependencies: [], roleKey: 'research' }] } }; }
const saved = new Map(); const histories = new Map();
window.fixture = { writes: [], confirms: [], conflict: false, delayLoad: false, delaySave: false, resolveLoad: null, resolveSave: null };
store.set(ownerGoalEditorsAtom, new Map(['a','b'].map(projectId => [JSON.stringify([projectId,null]), { ...getOwnerGoalEditor(new Map(), {projectId}), loaded: true, snapshot: goal(projectId) }])));
store.set(ownerPlanApiAtom, {
 getOwnerPlanDraft: async s => { const value = saved.get(s.projectId) ?? null; if (window.fixture.delayLoad && s.projectId === 'a') { window.fixture.delayLoad = false; return new Promise(done => { window.fixture.resolveLoad = () => done({ ok:true, value }); }); } return { ok:true, value }; },
 getOwnerPlanningContext: async s => ({ ok:true, value: {goal:goal(s.projectId), sources:plan(s.projectId).sources, fingerprint:'context'} }),
 listOwnerPlanHistory: async s => ({ ok:true, value:histories.get(s.projectId) ?? [] }),
 saveOwnerPlanDraft: async r => { window.fixture.writes.push(r); if (window.fixture.conflict) { saved.set(r.projectId, plan(r.projectId, r.expectedRevision+1)); return {ok:false,error:{code:'conflict',message:'其他窗口更新'}}; } const value = {...plan(r.projectId,r.expectedRevision+1), proposal:{...plan(r.projectId).proposal,...r.input}, changeReason:r.input.changeReason}; saved.set(r.projectId,value); if (window.fixture.delaySave) { window.fixture.delaySave=false; return new Promise(done => {window.fixture.resolveSave = () => done({ok:true,value});}); } return {ok:true,value}; },
 confirmOwnerPlanDraft: async r => { window.fixture.confirms.push(r); const old=saved.get(r.projectId); histories.set(r.projectId, [old]); const value = {...old, revision:r.expectedRevision+1,state:'confirmed'}; saved.set(r.projectId,value); return {ok:true,value}; }
});
function App() { const [projectId,setProjectId] = useState('a'); return <Provider store={store}><div className="controls"><button onClick={() => { saved.set('a',plan()); saved.set('b',plan('b')); void store.set(loadOwnerPlanAtom,{projectId}); }}>准备已有计划</button><button onClick={() => { const old=saved.get(projectId); saved.set(projectId,{...old,state:'stale'}); void store.set(loadOwnerPlanAtom,{projectId}); }}>来源过期</button><button onClick={() => setProjectId(projectId==='a'?'b':'a')}>切换主体</button><span>主体 {projectId}</span></div><ProjectOwnerPlanPanel projectId={projectId}/></Provider>; }
createRoot(document.getElementById('root')).render(<App/>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  writeFileSync(join(directory, 'input.css'), '@tailwind base; @tailwind components; @tailwind utilities; :root { --background: 0 0% 100%; --foreground: 222 30% 15%; --card: 0 0% 100%; --muted: 220 15% 95%; --muted-foreground: 220 10% 40%; --primary: 230 60% 45%; --primary-foreground: 0 0% 100%; --destructive: 0 70% 40%; --ring: 230 60% 50%; } body { background:#f3f4f6; padding:12px; } .controls { display:flex; flex-wrap:wrap; gap:8px; }')
  execFileSync(process.execPath, [join(root, 'node_modules/tailwindcss/lib/cli.js'), '-i', join(directory, 'input.css'), '-o', join(directory, 'style.css'), '--content', join(renderer, 'components/projects/ProjectOwnerPlanPanel.tsx')], { cwd: root, env: process.env, stdio: 'pipe' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/entry.js' || path === '/style.css') return new Response(Bun.file(join(directory, path.slice(1))))
    return new Response('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } })
  } })
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage({ viewport: { width: 360, height: 480 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('尚无可审阅计划。', { exact: false }).waitFor()
    expect(await page.getByRole('button', { name: '保存计划新版本', exact: true }).count()).toBe(0)
    const counts = () => page.evaluate(() => { const f = (window as unknown as { fixture: { writes: unknown[]; confirms: unknown[] } }).fixture; return { writes: f.writes.length, confirms: f.confirms.length } })
    expect(await counts()).toEqual({ writes: 0, confirms: 0 })
    await page.getByRole('button', { name: '准备已有计划' }).click()
    const summary = page.getByLabel('计划摘要', { exact: true }); const reason = page.getByLabel('修订原因（必填）', { exact: true }); const save = page.getByRole('button', { name: '保存计划新版本', exact: true }); const confirm = page.getByRole('button', { name: '确认当前计划内容' })
    await summary.waitFor({ timeout: 5000 }).catch(async error => { console.error(await page.locator('body').innerText(), errors); throw error }); await summary.fill('人工修订的计划'); await reason.fill('补充最新证据')
    expect(await confirm.isDisabled()).toBe(true); await save.click(); await page.getByRole('status').filter({ hasText: '计划 v2' }).waitFor()
    expect(await summary.inputValue()).toBe('人工修订的计划'); await confirm.click(); await page.getByRole('status').filter({ hasText: '已确认内容' }).waitFor(); expect(await counts()).toEqual({ writes: 1, confirms: 1 })
    await page.getByRole('button', { name: '查看计划历史' }).click(); await page.getByLabel('计划历史', { exact: true }).waitFor()
    await page.getByRole('button', { name: '来源过期' }).click(); await page.getByRole('status').filter({ hasText: '已过期' }).waitFor(); expect(await confirm.isDisabled()).toBe(true)
    await reason.fill('按新来源重审'); await save.click(); await page.getByRole('status').filter({ hasText: '待审阅' }).waitFor(); expect(await confirm.isEnabled()).toBe(true)
    await page.evaluate(() => { (window as unknown as { fixture: { conflict: boolean } }).fixture.conflict = true })
    await summary.fill('冲突也要保留我的输入'); await reason.fill('我的修订'); await save.click(); await page.getByText('版本冲突：', { exact: false }).waitFor(); expect(await summary.inputValue()).toBe('冲突也要保留我的输入')
    await page.getByRole('button', { name: '重新加载计划（保留输入）' }).click(); await page.getByLabel('计划版本比较', { exact: true }).waitFor(); expect(await save.isDisabled()).toBe(true)
    await page.getByRole('button', { name: '已比较最新计划，保留我的输入继续编辑' }).click(); expect(await save.isEnabled()).toBe(true)
    await page.evaluate(() => { const f = (window as unknown as { fixture: { conflict: boolean; delaySave: boolean } }).fixture; f.conflict = false; f.delaySave = true })
    await save.click(); await page.getByRole('button', { name: '正在提交…' }).waitFor(); await summary.fill('保存期间继续编辑')
    await page.evaluate(() => { (window as unknown as { fixture: { resolveSave: () => void } }).fixture.resolveSave() }); await save.waitFor(); expect(await summary.inputValue()).toBe('保存期间继续编辑'); expect(await confirm.isDisabled()).toBe(true)
    await page.evaluate(() => { (window as unknown as { fixture: { delayLoad: boolean } }).fixture.delayLoad = true })
    await page.getByRole('button', { name: '重新加载计划（保留输入）' }).click(); await page.getByRole('status').filter({ hasText: '正在加载计划' }).waitFor(); await summary.fill('加载期间的新输入')
    await page.getByRole('button', { name: '切换主体' }).click(); await page.getByText('主体 b', { exact: true }).waitFor(); await page.getByRole('status').filter({ hasText: '计划 v1' }).waitFor(); expect(await summary.inputValue()).toBe('计划b1')
    await page.evaluate(() => { (window as unknown as { fixture: { resolveLoad: () => void } }).fixture.resolveLoad() }); expect(await summary.inputValue()).toBe('计划b1')
    await page.getByRole('button', { name: '切换主体' }).click(); await page.getByText('主体 a', { exact: true }).waitFor(); expect(await summary.inputValue()).toBe('加载期间的新输入')
    expect(await page.locator('body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const steps = page.getByLabel('计划步骤编辑', { exact: true }); expect(await steps.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    expect(await counts()).toEqual({ writes: 4, confirms: 1 }); expect(errors).toEqual([])
    const artifacts = process.env.GRAVITAS_OWNER_PLAN_UI_ARTIFACT_DIR
    if (artifacts) { mkdirSync(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, 'plan-small-window.png'), fullPage: true }); writeFileSync(join(artifacts, 'chromium-evidence.json'), JSON.stringify({ environment: 'Chromium + React + deterministic ProjectOwnerPlanApi fixture (not Electron/DB/Provider)', viewport: { width: 360, height: 480 }, counts: await counts(), pageErrors: errors, cases: ['empty zero write', 'edit-save-confirm', 'stale blocked and resaved', 'history read-only', 'conflict comparison', 'late save preserves input', 'late load and subject switch isolation', 'small viewport scroll'] }, null, 2)) }
  } finally { await browser?.close(); server.stop(true) }
}, 30000)
