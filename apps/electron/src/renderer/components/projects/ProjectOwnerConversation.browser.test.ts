import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

declare global {
  interface Window {
    ownerSetupFixture: { effects: { workspaces: number; employees: number; bindings: number; saves: number; prepares: number; paidStarts: number; managementAuthorizations: number } }
  }
}
const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-conversation-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip

browserTest('Given 用户提交项目目标 When 对话更新 Then 不展示逐请求确认卡或技术明细', async () => {
  const entry = join(directory, 'entry.tsx')
  writeFileSync(entry, `
import React from 'react'; import {createRoot} from 'react-dom/client'; import {Provider,createStore} from 'jotai';
import {ProjectOwnerConversation} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerConversation.tsx'))};
const ok=value=>({ok:true,value}); const effects={workspaces:0,employees:0,bindings:0,saves:0,prepares:0,paidStarts:0,managementAuthorizations:0};
let createdEmployees=[];const workspace={id:'workspace-a',name:'项目资料空间',slug:'workspace-a',createdAt:1,updatedAt:1}; const expiredScenario=new URLSearchParams(location.search).has('expired'); const carrier={id:'owner-carrier',name:'Owner规划 · project-a',role:'项目规划',description:'Owner专属受控规划载体；业务执行仍需单独授权。',runtime:'ai-sdk',channelId:'channel-a',modelId:'model-a',workspaceIds:[workspace.id],executionProfile:'controlled',permissionMode:'safe',skills:[],enabled:true,totalTasks:0,completedTasks:0,failureCount:0,createdAt:1,updatedAt:1}; let goal=null,binding=expiredScenario?{schemaVersion:1,projectId:'project-a',revision:1,ownerRole:'project_owner',ownerName:'项目Owner',carrierId:carrier.id,workspaceId:workspace.id,channelId:'channel-a',modelId:'model-a',runtime:'ai-sdk',carrierFingerprint:'hash',actor:'system:owner-manager',savedAt:1,changeReason:'测试'}:null,plan=null,delegation=expiredScenario?{id:'grant-expired',projectId:'project-a',requestId:'expired-request',maxRequests:12,maxCostMicros:5000000,expiresAt:1,scopeHash:'scope',goalContentHash:'goal',previewHash:'preview',bindingRevision:1,goalRevision:1,modelId:'model-a',workspaceName:workspace.name,priceEvidenceId:'price',perRequestCeilingMicros:1,maxOutputTokens:8192,issuedAt:1}:null,runs=[];
const saved=input=>({schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{projectId:'project-a',goalVersion:1,objective:input.objective,constraints:input.constraints??[],acceptanceCriteria:input.acceptanceCriteria??[]}});
const context=()=>({goal,sources:{project:{id:'project-a',title:'项目',description:''},roles:[]},fingerprint:'context'});
const api={
getOwnerGoalDraft:async()=>ok(goal),saveOwnerGoalDraft:async({input})=>{goal=saved(input);return ok(goal)},
getOwnerManagement:async()=>ok({manager:null,messages:[],questions:[],pendingEvents:0}),getOwnerManagementDelegation:async()=>ok({delegation,state:expiredScenario?'expired':'none',usedRequests:0,reservedCostMicros:0,detail:expiredScenario?'管理委托已到期。':'尚无持续管理授权。'}),
previewOwnerManagementDelegation:async()=>{effects.managementAuthorizations++;throw Error('不得在规划前申请持续管理授权')},
getOwnerPlanDraft:async()=>ok(plan),getOwnerPlanningContext:async()=>ok(context()),listOwnerPlanHistory:async()=>ok([]),saveOwnerPlanDraft:async()=>{throw Error('不得自动保存计划')},confirmOwnerPlanDraft:async()=>{throw Error('不得自动确认计划')},
getOwnerRuntimeBinding:async()=>ok(binding),listOwnerPlanningRuns:async()=>ok(runs),saveOwnerRuntimeBinding:async({input,expectedRevision})=>{effects.saves++;binding={...input,schemaVersion:1,projectId:'project-a',revision:expectedRevision+1,ownerRole:'project_owner',channelId:'channel-a',modelId:createdEmployees.find(item=>item.id===input.carrierId)?.modelId??carrier.modelId,runtime:'ai-sdk',carrierFingerprint:'hash',actor:'local-user',savedAt:1};return ok(binding)},
prepareOwnerPlanning:async({input})=>{effects.prepares++;const link={...input,id:'link-a',planningTaskId:'task-a',projectId:'project-a',goalRevision:1,bindingRevision:binding.revision,goalVersion:1,planRevision:0,contextFingerprint:'context',protocolVersion:'2',purpose:'owner_planning',maxRequests:1,maxOutputTokens:8192,promptHash:'hash',carrierFingerprint:'hash',createdAt:1};runs=[{link,executions:[],receipts:[],outcomes:[]}];return ok(link)}
};
window.electronAPI={getSettings:async()=>({agentChannelId:'channel-a',agentModelId:'model-a'}),listChannels:async()=>[{id:'channel-a',name:'测试渠道',provider:'openai',enabled:true,updatedAt:1,models:[{id:'model-a',name:'模型 A',enabled:true},{id:'deepseek-flash',name:'DeepSeek Flash',enabled:true}]}],listAgentWorkspaces:async()=>[workspace],
paa:{project:api,projectWorkspace:{listByProject:async()=>[{projectId:'project-a',workspaceId:'workspace-a',createdAt:1}],bind:async()=>{effects.bindings++}},agentEmployees:{list:async()=>[...(expiredScenario?[carrier]:[]),...createdEmployees],create:async input=>{effects.employees++;const employee={...input,id:'employee-'+effects.employees,enabled:true,skills:[],totalTasks:0,completedTasks:0,failureCount:0,createdAt:1,updatedAt:1};createdEmployees.push(employee);return employee},getControlledTaskStartPreview:async()=>({taskId:'task-a',revision:1,previewHash:'preview',title:'Owner规划',description:'只生成本项目方案',employeeName:'Owner规划载体',workspaceName:'项目资料空间',channelName:'测试渠道',modelId:'model-a',runtime:'ai-sdk',permissionMode:'safe',requestedPermissions:[],expiresAt:Date.now()+60000,ownerPlanning:{purpose:'owner_planning',linkId:'link-a',ownerName:'项目Owner',bindingRevision:1,goalRevision:1,planRevision:0,contextFingerprint:'context',promptHash:'hash',protocolVersion:'2',maxRequests:1,maxOutputTokens:8192,systemPrompt:'隐藏指令',userPrompt:'本项目目标资料',context:context(),costs:'unknown_no_hard_cap'}}),startControlledTask:async()=>{effects.paidStarts++;throw Error('不得自动发送')}}}};
const rootNode=createRoot(document.getElementById('root'));rootNode.render(<Provider store={createStore()}><ProjectOwnerConversation projectId="project-a"/></Provider>);window.ownerSetupFixture={effects};
`)
  await build({ entryPoints: [entry], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  page.setDefaultTimeout(5000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByLabel('希望达成的目标').fill('为产品定位形成一份可评审方案')
    expect(await page.getByText('费用与持续管理设置（需要时再确认）', { exact: true }).count()).toBe(0)
    expect(await page.getByRole('checkbox', { name: /持续推进本项目/ }).count()).toBe(0)
    await page.getByRole('button', { name: '提交目标', exact: true }).click()
    await page.getByRole('button', { name: '调整目标' }).waitFor()
    expect(await page.getByLabel('希望达成的目标').count()).toBe(0)
    expect(await page.getByLabel('现阶段最需要关注').innerText()).toContain('项目目标')
    expect(await page.getByLabel('Owner当前工作台').count()).toBe(1)
    await page.getByText('Owner尚未开始规划：当前没有已确认的项目总模型费用额度。请在下方确认预算与有效期；确认后，Owner会在额度内自动整理方案并回到这里回应。', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '查看本次规划请求', exact: true }).count()).toBe(0)
    expect(await page.getByRole('checkbox', { name: '确认本次模型执行及费用' }).count()).toBe(0)
    expect(await page.getByText(/token|协议|发送资料|本次模型执行及费用/i).count()).toBe(0)
    expect(await page.getByText('隐藏指令', { exact: true }).count()).toBe(0)
    expect(await page.evaluate(() => window.ownerSetupFixture.effects.paidStarts)).toBe(0)
    expect(errors).toEqual([])

    await page.goto(`http://127.0.0.1:${server.port}/?expired`)
    await page.getByLabel('希望达成的目标').fill('续接已有项目与委托')
    await page.getByRole('button', { name: '提交目标', exact: true }).click()
    await page.getByRole('button', { name: '调整目标' }).waitFor()
    expect(await page.getByLabel('Owner管理委托').count()).toBe(1)
    // 已绑定配置不能隐藏更换入口；添加渠道不等于切换Owner。
    expect(await page.getByLabel('Owner规划模型').count()).toBe(0)
    await page.getByRole('button', { name: '更换 Owner 模型', exact: true }).click()
    await page.getByLabel('Owner规划模型').selectOption(JSON.stringify(['channel-a', 'deepseek-flash']))
    expect(await page.getByLabel('Owner管理委托').count()).toBe(0)
    expect(await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: '保存 Owner 模型', exact: true }).click()
    await page.getByText('当前 Owner 模型：deepseek-flash', { exact: true }).waitFor()
    await page.getByLabel('Owner管理委托').waitFor()
    expect(await page.getByLabel('Owner规划模型').count()).toBe(0)
    expect(await page.evaluate(() => window.ownerSetupFixture.effects.paidStarts)).toBe(0)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
