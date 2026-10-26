import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-runtime-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 澄清新目标已保存但来源仍在加载 When 来源回读并且后续Run结束 Then 自动暂停准备一次并只读刷新终态，无模型启动', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerRuntimePanel} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerRuntimePanel.tsx'))};
import {getOwnerGoalEditor,ownerGoalEditorsAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import {getOwnerPlanEditor,ownerPlanEditorsAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-plan-atoms.ts'))};
import {getOwnerRuntimeEditor,ownerRuntimeEditorsAtom,ownerRuntimeApiAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-runtime-atoms.ts'))};
const store=createStore(),subject={projectId:'p'},key='["p",null]',ok=value=>({ok:true,value});
const questions=[{key:'audience',reasonType:'missing_information',question:'主要受众是谁？',why:'影响定位',options:[]}];
const goal={schemaVersion:1,revision:2,state:'draft',actor:'local-user',savedAt:2,goal:{...subject,goalVersion:2,objective:'形成定位建议',constraints:['Owner澄清答复（主要受众是谁？）：小团队'],acceptanceCriteria:[]}};
const context={goal,fingerprint:'new',sources:{project:{id:'p',title:'项目',description:''},roles:[]}};
const binding={schemaVersion:1,projectId:'p',revision:1,ownerRole:'project_owner',ownerName:'Owner',carrierId:'carrier',workspaceId:'workspace',channelId:'channel',modelId:'model',runtime:'ai-sdk',carrierFingerprint:'hash',actor:'local-user',savedAt:1,changeReason:'配置'};
const link={schemaVersion:1,id:'old-link',projectId:'p',requestId:'old-request',planningTaskId:'old-task',bindingRevision:1,goalRevision:1,goalVersion:1,planRevision:0,contextFingerprint:'old',carrierFingerprint:'hash',protocolVersion:'2',promptHash:'hash',purpose:'owner_planning',maxRequests:1,maxOutputTokens:8192,createdAt:1};
let runs=[{link,executions:[{id:'old-execution',sessionId:'old-session',status:'completed'}],receipts:[],outcomes:[{executionId:'old-execution',state:'needs_clarification',detail:'需确定受众',clarification:{...subject,goalVersion:1,contextFingerprint:'old',reason:'受众缺失',questions}}]}];
let reads=0,prepares=0,paidStarts=0,release;const pending=new Promise(resolve=>release=resolve);let delayed=true;
store.set(ownerGoalEditorsAtom,new Map([[key,{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:goal,objective:goal.goal.objective,constraintsText:goal.goal.constraints[0]}]]));
store.set(ownerPlanEditorsAtom,new Map([[key,{...getOwnerPlanEditor(new Map(),subject),loaded:true,context}]]));
store.set(ownerRuntimeEditorsAtom,new Map([[key,{...getOwnerRuntimeEditor(new Map(),subject),binding,context:{...context,goal:{...goal,revision:1}},runs}]]));
store.set(ownerRuntimeApiAtom,{
getOwnerRuntimeBinding:async()=>ok(binding),listOwnerPlanningRuns:async()=>ok(runs),
getOwnerPlanningContext:async()=>{reads++;if(delayed)await pending;return ok(context)},listEmployees:async()=>[],listWorkspaces:async()=>[],listWorkspaceBindings:async()=>[],
prepareOwnerPlanning:async({input})=>{prepares++;const next={...link,id:'new-link',requestId:input.requestId,planningTaskId:'new-task',goalRevision:2,goalVersion:2,contextFingerprint:'new',createdAt:2};runs=[{link:next,executions:[],outcomes:[],receipts:[]},...runs];return ok(next)}
});
window.electronAPI={paa:{agentEmployees:{startControlledTask:async()=>{paidStarts++;throw Error('禁止模型启动')}}}};
window.fixture={release:()=>{delayed=false;release()},facts:()=>({reads,prepares,paidStarts}),finishRun:()=>{
const next={...runs[0],executions:[{id:'new-execution',sessionId:'new-session',status:'running'}]};runs=[next,...runs.slice(1)];
store.set(ownerRuntimeEditorsAtom,new Map([[key,{...getOwnerRuntimeEditor(store.get(ownerRuntimeEditorsAtom),subject),runs}]]));
runs=[{...next,executions:[{...next.executions[0],status:'completed'}],outcomes:[{executionId:'new-execution',state:'needs_clarification',detail:'新的必要问题',clarification:{...subject,goalVersion:2,contextFingerprint:'new',reason:'新的必要问题',questions}}]},...runs.slice(1)];
}};
createRoot(document.getElementById('root')).render(<Provider store={store}><ProjectOwnerRuntimePanel {...subject} showConfiguration={false}/></Provider>);
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.waitForFunction('window.fixture?.facts().reads===1')
    expect(await page.evaluate<number>('window.fixture.facts().prepares')).toBe(0)
    await page.evaluate('window.fixture.release()')
    await page.getByRole('button', { name: '预检并开始', exact: true }).waitFor()
    expect(await page.evaluate<number>('window.fixture.facts().prepares')).toBe(1)
    await page.evaluate('window.fixture.finishRun()')
    await page.getByText('等待当前规划Run', { exact: true }).waitFor()
    await page.getByText('回答Owner的必要问题', { exact: true }).waitFor()
    expect(await page.evaluate<number>('window.fixture.facts().prepares')).toBe(1)
    expect(await page.evaluate<number>('window.fixture.facts().paidStarts')).toBe(0)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
