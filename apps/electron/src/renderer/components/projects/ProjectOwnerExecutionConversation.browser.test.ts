import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'

const root = resolve(import.meta.dir, '../../../../../..')
const renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-execution-conversation-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 已确认计划 When 对话配置人员与预算 Then 暂停准备且保存失败可恢复、重开不重复询问', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {ProjectOwnerExecutionConversation} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerExecutionConversation.tsx'))};
import {ownerGoalEditorsAtom,getOwnerGoalEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import {ownerPlanEditorsAtom,getOwnerPlanEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-plan-atoms.ts'))};
const subject={projectId:'p'},key='["p",null]',ok=value=>({ok:true,value});
const goal={schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{...subject,goalVersion:1,objective:'产品定位',constraints:[],acceptanceCriteria:['报告']}};
const plan={...subject,schemaVersion:1,revision:1,planVersion:1,goalRevision:1,goalVersion:1,state:'confirmed',actor:'local-user',origin:'manual',savedAt:1,changeReason:'确认计划',contextFingerprint:'ctx',planFingerprint:'plan',sources:{project:{id:'p',title:'项目',description:''},roles:[]},proposal:{...subject,goalVersion:1,mode:'proposal_only',summary:'调研',assumptions:[],risks:[],steps:[{key:'s',title:'调研定位',outcome:'报告',acceptanceCriteria:['有证据'],dependencies:[],roleKey:'research'}]}};
const employee={id:'e',name:'调研员',roleTemplateId:'research',executionProfile:'controlled',workspaceIds:['w'],channelId:'c',modelId:'m',runtime:'ai-sdk'};
let view={workspaceRecommendation:{workspaceId:'w',source:'owner_binding'},executionConfigurationRecommendation:{channelId:'c',modelId:'m',runtime:'ai-sdk',source:'owner_binding'},executionConfigurationRecommendationState:'current',revision:0,policyRevision:null,preparation:null,status:'none',blockers:[],choices:{employees:[employee,{...employee,id:'r',name:'独立评审员',roleTemplateId:'reviewer'}],workspaces:[{id:'w',name:'项目工作区'}],workspaceCapabilities:[],knowledgeSources:[]}};
let previews=0,saves=0,failSave=true;const lostReply=new URLSearchParams(location.search).has('lost');
const frozen=input=>({...subject,schemaVersion:1,stage:'pending_task_links',ownerBindingProvenance:{state:'none'},goalRevision:1,goalVersion:1,planRevision:1,planVersion:1,planFingerprint:'plan',contextFingerprint:'ctx',plan,selectedStepKeys:input.selectedStepKeys,executor:{id:'e',name:'调研员',configurationHash:'e'},reviewer:{id:'r',name:'独立评审员',configurationHash:'r'},workspaceId:'w',workspaceName:'项目工作区',workspaceHash:'w',channelId:'c',modelId:'m',runtime:'ai-sdk',channelHash:'c',capabilityConfigurationHash:'cap',knowledgeSources:[],blockers:[]});
window.electronAPI={paa:{project:{getOwnerExecutionPreparation:async()=>ok(view),listOwnerExecutionPreparationHistory:async()=>ok([]),previewOwnerExecutionPreparation:async({input})=>{previews++;return ok({...frozen(input),input,previewFingerprint:'preview'})},saveOwnerExecutionPreparation:async({input})=>{saves++;if(failSave){failSave=false;if(!lostReply)return {ok:false,error:{code:'conflict',message:'模拟保存冲突'}}}const record={schemaVersion:1,id:'prep',projectId:'p',revision:1,policyRevision:1,stage:'pending_task_links',actor:'local-user',savedAt:1,input,source:frozen(input),inputHash:'h',previousIntegrityHash:null,integrityHash:'h'};view={...view,preparation:record,status:'current',revision:1,policyRevision:1};if(lostReply&&saves===1)throw Error('模拟保存回包丢失');return ok(record)}}}};
const app=createRoot(document.getElementById('root'));let generation=0;
const remount=()=>{const store=createStore();store.set(ownerGoalEditorsAtom,new Map([[key,{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:goal}]]));store.set(ownerPlanEditorsAtom,new Map([[key,{...getOwnerPlanEditor(new Map(),subject),loaded:true,snapshot:plan,context:{goal,sources:plan.sources,fingerprint:'ctx'}}]]));app.render(<Provider key={++generation} store={store}><ProjectOwnerExecutionConversation projectId="p"/></Provider>)};
window.fixture={remount,counts:()=>({previews,saves})};remount();
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent', plugins: [{ name: 'downstream-boundary', setup(builder) {
    builder.onLoad({ filter: /ProjectOwnerDeliveryConversation\.tsx$/ }, args => {
      const name = args.path.split('/').pop()!.replace('.tsx', '')
      return { contents: `export function ${name}(){return null}`, loader: 'tsx' }
    })
  } }] })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<html><body><div id="root"></div><script src="/entry.js"></script></body></html>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 360, height: 640 } })
  page.setDefaultTimeout(4000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: '按已确认计划继续', exact: true }).click()
    expect(await page.getByLabel('research · 执行人员').inputValue()).toBe('e')
    expect(await page.getByRole('button', { name: '核对完成，设置预算与范围', exact: true }).isEnabled()).toBe(false)
    await page.getByLabel('谁独立评审成果？').selectOption('r')
    await page.getByRole('button', { name: '核对完成，设置预算与范围', exact: true }).click()
    await page.getByLabel('项目共享费用上限（美元 USD）').fill('1.000001')
    await page.getByLabel('最多运行次数').fill('4')
    await page.getByLabel('最多返工次数').fill('1')
    await page.getByLabel('有效期至').fill('2099-01-01T12:00')
    await page.getByLabel('本次准备说明').fill('核对岗位与预算')
    await page.getByRole('button', { name: '生成执行准备摘要', exact: true }).click()
    await page.getByRole('button', { name: '确认摘要，保存暂停准备', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '模拟保存冲突' }).waitFor()
    expect(await page.getByLabel('本次准备说明').inputValue()).toBe('核对岗位与预算')
    await page.getByRole('button', { name: '重新读取执行配置', exact: true }).click()
    await page.getByRole('button', { name: '已核对当前来源，保留输入继续', exact: true }).click()
    await page.getByRole('button', { name: '生成执行准备摘要', exact: true }).click()
    await page.getByText('项目共享总额：1000001 微美元', { exact: false }).waitFor()
    await page.getByRole('button', { name: '确认摘要，保存暂停准备', exact: true }).click()
    await page.getByText('已有当前计划的暂停执行准备，可继续核对任务和执行授权。', { exact: true }).waitFor()
    expect(await page.getByLabel('项目共享费用上限（美元 USD）').count()).toBe(0)
    // 页面只提供准备服务；任何越过准备边界的IPC调用都会抛出并记录为页面错误。
    expect(await page.evaluate<{ previews: number; saves: number }>('window.fixture.counts()')).toEqual({ previews: 2, saves: 2 })
    await page.evaluate('window.fixture.remount()')
    await page.getByText('已有当前计划的暂停执行准备，可继续核对任务和执行授权。', { exact: true }).waitFor()
    expect(await page.getByLabel('谁独立评审成果？').count()).toBe(0)
    await page.getByRole('button', { name: '调整执行准备', exact: true }).click()
    expect(await page.getByLabel('谁独立评审成果？').inputValue()).toBe('r')
    await page.getByRole('button', { name: '核对完成，设置预算与范围', exact: true }).click()
    expect(await page.getByLabel('项目共享费用上限（美元 USD）').inputValue()).toBe('1.000001')
    expect(await page.evaluate<{ previews: number; saves: number }>('window.fixture.counts()')).toEqual({ previews: 2, saves: 2 })
    expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    await page.goto(`http://127.0.0.1:${server.port}/?lost=1`)
    await page.getByRole('button', { name: '按已确认计划继续', exact: true }).click()
    await page.getByLabel('谁独立评审成果？').selectOption('r')
    await page.getByRole('button', { name: '核对完成，设置预算与范围', exact: true }).click()
    await page.getByLabel('项目共享费用上限（美元 USD）').fill('2')
    await page.getByLabel('最多运行次数').fill('4')
    await page.getByLabel('最多返工次数').fill('1')
    await page.getByLabel('有效期至').fill('2099-01-01T12:00')
    await page.getByLabel('本次准备说明').fill('恢复落盘结果')
    await page.getByRole('button', { name: '生成执行准备摘要', exact: true }).click()
    await page.getByRole('button', { name: '确认摘要，保存暂停准备', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '模拟保存回包丢失' }).waitFor()
    await page.getByRole('button', { name: '重新读取执行配置', exact: true }).click()
    await page.getByText('已有当前计划的暂停执行准备，可继续核对任务和执行授权。', { exact: true }).waitFor()
    expect(await page.getByLabel('项目共享费用上限（美元 USD）').count()).toBe(0)
    expect(await page.getByRole('button', { name: '确认摘要，保存暂停准备', exact: true }).count()).toBe(0)
    expect(await page.evaluate<{ previews: number; saves: number }>('window.fixture.counts()')).toEqual({ previews: 1, saves: 1 })
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
