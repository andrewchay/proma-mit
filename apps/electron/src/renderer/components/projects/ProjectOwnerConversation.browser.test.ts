import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

declare global {
  interface Window {
    ownerSetupFixture: {
      effects: { workspaces: number; employees: number; bindings: number; saves: number; prepares: number; paidStarts: number }
      remount(): void
      allowReads(): void
    }
  }
}
const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-conversation-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 新项目尚无员工或工作区 When 对话保存目标并确认选择 Then 原地准备且不调用付费出口，重开仍恢复', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { ProjectOwnerConversation } from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversation.tsx'))};
const ok = value => ({ok:true,value});
const effects = {workspaces:0,employees:0,bindings:0,saves:0,prepares:0,paidStarts:0};
let goal = null, binding = null, workspaces = [], employees = [], bindings = [], runs = [];
let failReads = new URLSearchParams(location.search).has('fail');
const savedGoal = input => ({schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{projectId:'project-a',goalVersion:1,objective:input.objective,constraints:input.constraints??[],acceptanceCriteria:input.acceptanceCriteria??[]}});
if(failReads) goal=savedGoal({objective:'保留已保存目标'});
const context = () => ({goal,sources:{project:{id:'project-a',title:'新项目',description:''},roles:[]},fingerprint:'context'});
const api = {
  getOwnerGoalDraft: async()=>ok(goal), saveOwnerGoalDraft: async({input})=>{goal=savedGoal(input);return ok(goal)},
  getOwnerPlanDraft: async()=>ok(null), getOwnerPlanningContext: async()=>ok(context()), listOwnerPlanHistory: async()=>ok([]),
  saveOwnerPlanDraft: async()=>{throw Error('禁止自动保存计划')}, confirmOwnerPlanDraft: async()=>{throw Error('禁止自动确认计划')},
  getOwnerRuntimeBinding: async()=>ok(binding), listOwnerPlanningRuns: async()=>ok(runs),
  saveOwnerRuntimeBinding: async({input,expectedRevision})=>{effects.saves++;binding={...input,schemaVersion:1,projectId:'project-a',revision:expectedRevision+1,ownerRole:'project_owner',channelId:'channel-a',modelId:'model-a',runtime:'ai-sdk',carrierFingerprint:'hash',actor:'local-user',savedAt:1};return ok(binding)},
  prepareOwnerPlanning: async({input})=>{effects.prepares++;const link={...input,id:'link-a',planningTaskId:'task-a',projectId:'project-a',goalRevision:1,bindingRevision:binding.revision,goalVersion:1,planRevision:0,contextFingerprint:'context',protocolVersion:'2',purpose:'owner_planning',maxRequests:1,maxOutputTokens:8192,promptHash:'hash',carrierFingerprint:'hash',createdAt:1};runs=[{link,executions:[],receipts:[],outcomes:[]}];return ok(link)}
};
window.electronAPI = {
  listChannels: async()=>{if(failReads)throw Error('模拟配置暂不可读');return [{id:'channel-a',name:'测试渠道',enabled:true,updatedAt:1,models:[{id:'model-a',name:'模型 A',enabled:true}]}]},
  listAgentWorkspaces: async()=>workspaces,
  createAgentWorkspace: async(name)=>{effects.workspaces++;const w={id:'workspace-a',name,slug:'workspace-a',createdAt:1,updatedAt:1};workspaces.push(w);return w},
  paa:{project:api,projectWorkspace:{listByProject:async()=>bindings,bind:async(projectId,workspaceId)=>{effects.bindings++;bindings.push({projectId,workspaceId,createdAt:1})}},agentEmployees:{list:async()=>employees,create:async(input)=>{effects.employees++;const e={...input,id:'employee-a',enabled:true,skills:[],totalTasks:0,completedTasks:0,failureCount:0,createdAt:1,updatedAt:1};employees.push(e);return e},startControlledTask:async()=>{effects.paidStarts++;throw Error('禁止发送付费请求')}}}
};
const app=createRoot(document.getElementById('root'));let generation=0;
const remount=()=>app.render(<Provider key={++generation} store={createStore()}><ProjectOwnerConversation projectId="project-a" /></Provider>);
window.ownerSetupFixture={effects,remount,allowReads:()=>{failReads=false}};remount();
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('希望达成的目标').fill('给小团队产出一份可评审的产品定位方案')
    await page.getByRole('button', { name: '保存目标，继续', exact: true }).click()
    await page.getByRole('button', { name: '测试渠道 · 模型 A', exact: true }).click()
    await page.getByRole('button', { name: /新建独立工作区/ }).click()
    expect(await page.getByRole('button', { name: '确认选择，准备规划', exact: true }).isEnabled()).toBe(false)
    await page.getByRole('checkbox', { name: /允许此项目使用新建的独立工作区/ }).check()
    await page.getByRole('button', { name: '确认选择，准备规划', exact: true }).click()
    await page.getByRole('button', { name: '预检并开始', exact: true }).waitFor()
    expect(await page.evaluate(() => window.ownerSetupFixture.effects)).toEqual({ workspaces: 1, employees: 1, bindings: 1, saves: 1, prepares: 1, paidStarts: 0 })
    await page.evaluate(() => window.ownerSetupFixture.remount())
    await page.getByRole('button', { name: '预检并开始', exact: true }).waitFor()
    expect(await page.getByText('给小团队产出一份可评审的产品定位方案', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('textbox', { name: '希望达成的目标' }).count()).toBe(0)
    expect(await page.getByText('用哪个模型规划？', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: '调整规划配置', exact: true }).count()).toBe(1)
    await page.getByRole('button', { name: '沿用配置，准备规划', exact: true }).click()
    expect((await page.evaluate(() => window.ownerSetupFixture.effects)).prepares).toBe(1)
    expect((await page.evaluate(() => window.ownerSetupFixture.effects)).paidStarts).toBe(0)
    await page.getByRole('button', { name: '调整目标', exact: true }).click()
    await page.getByLabel('希望达成的目标').fill('调整后的产品定位目标')
    await page.getByRole('button', { name: '保存目标，继续', exact: true }).click()
    await page.getByText('调整后的产品定位目标', { exact: true }).waitFor()
    expect(await page.getByRole('textbox', { name: '希望达成的目标' }).count()).toBe(0)
    await page.goto(`http://127.0.0.1:${server.port}/?fail=1`)
    await page.getByRole('button', { name: '重新读取可用配置', exact: true }).waitFor()
    await page.evaluate(() => window.ownerSetupFixture.allowReads())
    await page.getByRole('button', { name: '重新读取可用配置', exact: true }).click()
    await page.getByRole('button', { name: '测试渠道 · 模型 A', exact: true }).waitFor()
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
