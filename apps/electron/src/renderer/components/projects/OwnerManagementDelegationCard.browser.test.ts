import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
const root = resolve(import.meta.dir, '../../../../../..'), renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-delegation-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given 管理范围许可卡 When 授权、失效后续授权及撤销 Then 显示项目累计额度并保留确认边界', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider} from 'jotai';
import {OwnerManagementDelegationCard} from ${JSON.stringify(join(renderer, 'components/projects/OwnerManagementDelegationCard.tsx'))};
const params=new URLSearchParams(location.search);let reauthorized=false,raceStale=false,current=params.has('stale')||params.has('attention')?{id:'stale-grant',maxCostMicros:2000000,expiresAt:Date.now()+3600000}:null,previews=[],confirms=[],revokes=[],reads=0,bindings=0;
const ok=value=>({ok:true,value});
window.electronAPI={paa:{project:{
getOwnerManagementDelegation:async()=>{reads++;return ok({delegation:current,state:current?(reauthorized?'active':raceStale||params.has('stale')?'stale':params.has('attention')?'attention':'active'):'none',usedRequests:current?1:0,reservedCostMicros:current?620000:0,detail:current?(reauthorized?'管理委托有效':raceStale||params.has('stale')?'来源已变化，需重新确认':params.has('attention')?'上次管理请求未得到可继续结果，请核对原运行；不会自动重试。':'管理委托有效'):'',...(params.has('attention')?{attentionCheck:{executionStatus:'failed',outcomeState:'failed',reason:'output_limit',requestStartedAt:Date.now()-120000,receiptCapturedAt:Date.now()-60000,modelId:'deepseek-flash',providerResponseId:'d713371a-eb05-4a91-a53f-a2b8f46f94fb',outcomeDetail:'Owner安排输出达到本次请求上限',inputTokens:1849,outputTokens:4096,costSource:'unknown',costUsd:null}}:{})})},onOwnerManagementChanged:()=>()=>{},
ensureOwnerRuntimeBinding:async()=>{bindings++;return ok({revision:2})},

previewOwnerManagementDelegation:async input=>{previews.push(input);if(params.has('bindingstale')&&previews.length===1)return {ok:false,error:{code:'conflict',message:'Owner管理配置已变化，请重新确认'}};return ok({...input,scopeHash:'scope',previewHash:'preview',bindingRevision:1,goalRevision:1,modelId:'deepseek-flash',workspaceName:'已授权资料',priceEvidenceId:'reviewed',perRequestCeilingMicros:310000,maxOutputTokens:8192})},
confirmOwnerManagementDelegation:async input=>{confirms.push(input);current={...input.input,id:'grant',modelId:'deepseek-flash'};if(params.has('race')&&confirms.length===1){current={id:'stale-grant',maxCostMicros:2000000,expiresAt:Date.now()+3600000};raceStale=true;throw Error('Owner管理委托的配置、资料或价格已变化')}if(!params.has('stale')&&confirms.length===1)throw Error('回包丢失，请重提核对');reauthorized=true;return ok(current)},
revokeOwnerManagementDelegation:async input=>{revokes.push(input);return ok({delegation:current,state:'revoked',usedRequests:1,reservedCostMicros:310000,detail:'管理委托已撤销'})}
}}};
window.fixture={facts:()=>({previews,confirms,revokes,reads,bindings})};
createRoot(document.getElementById('root')).render(<Provider><OwnerManagementDelegationCard projectId="p" {...(params.has('task')?{taskId:'task'}:{})}/></Provider>);
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent' })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage()
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    const introduction = await page.locator('section[aria-label="Owner管理委托"]').innerText()
    expect(introduction).toContain('确认一次后，Owner会在该额度内自主推进')
    expect(introduction).not.toContain('员工执行仍由你确认')
    await page.getByLabel('项目总模型费用上限（美元）', { exact: true }).fill('2')
    expect(await page.getByLabel(/调用次数|请求次数|模型名称|模型配置/).count()).toBe(0)
    await page.getByText('你授权 Owner 在本项目范围内按目标规划、组织团队、跟进进度并检查成果。', { exact: false }).waitFor()
    expect(await page.getByText('你授权 Owner 在本项目范围内按目标规划、组织团队、跟进进度并检查成果。', { exact: false }).count()).toBe(1)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    expect(await page.getByText('查看数据与费用范围', { exact: true }).count()).toBe(1)
    expect(await page.locator('section[aria-label="Owner管理委托"]').innerText()).not.toContain('每次管理请求最多预留')
    await page.getByText('查看数据与费用范围', { exact: true }).click()
    expect(await page.locator('section[aria-label="Owner管理委托"]').innerText()).toContain('每次管理请求最多预留')
    await page.getByText('查看数据与费用范围', { exact: true }).click()
    const previewText = await page.locator('section[aria-label="Owner管理委托"]').innerText()
    expect(previewText).toContain('项目总模型费用上限为 $2.00')
    expect(previewText).toContain('本次Owner模型：deepseek-flash')
    expect(previewText).not.toContain('已授权资料')
    expect(previewText).not.toContain('最多调用')
    expect(await page.evaluate<number>('window.fixture.facts().previews.length')).toBeGreaterThan(0)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    await page.getByLabel('项目总模型费用上限（美元）', { exact: true }).fill('3')
    await page.getByText('项目总模型费用上限为 $3.00', { exact: false }).waitFor()
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '回包丢失' }).waitFor()
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    await page.getByRole('button', { name: '撤销授权', exact: true }).waitFor()
    expect(await page.evaluate<boolean>('window.fixture.facts().confirms[0].input.requestId===window.fixture.facts().confirms[1].input.requestId')).toBe(true)
    expect(await page.evaluate<number>('window.fixture.facts().confirms[0].input.maxCostMicros')).toBe(3000000)
    expect(await page.evaluate<number>('window.fixture.facts().confirms[0].input.maxRequests')).toBe(Number.MAX_SAFE_INTEGER)
    expect(await page.evaluate<boolean>('window.fixture.facts().confirms[0].input.autonomousExecution')).toBe(true)
    expect(await page.locator('section[aria-label="Owner管理委托"]').count()).toBe(0)
    expect(await page.getByRole('status').filter({ hasText: '项目管理授权有效。实际进度及需要处理的事项见下方。' }).count()).toBe(1)
    await page.getByRole('button', { name: '撤销授权', exact: true }).click()
    await page.getByText('管理委托已撤销', { exact: true }).waitFor()
    expect(await page.evaluate<string>('window.fixture.facts().revokes[0].projectId')).toBe('p')
    await page.goto(`http://127.0.0.1:${server.port}/?stale`)
    await page.getByText('Owner 已暂停：授权范围需要重新确认', { exact: true }).waitFor()
    await page.getByText('来源已变化，需重新确认', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: '不会沿用旧授权' }).waitFor()
    expect(await page.getByText('管理委托有效', { exact: true }).count()).toBe(0)
    await page.getByText('项目总模型费用上限为 $1.50', { exact: false }).waitFor()
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    const previewsBeforeRecovery = await page.evaluate<number>('window.fixture.facts().previews.length')
    const bindingsBeforeRecovery = await page.evaluate<number>('window.fixture.facts().bindings')
    await page.getByRole('button', { name: '重新核对当前授权', exact: true }).click()
    await page.waitForFunction(`window.fixture.facts().previews.length>${previewsBeforeRecovery}`)
    expect(await page.evaluate<number>('window.fixture.facts().bindings')).toBeGreaterThan(bindingsBeforeRecovery)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    await page.getByRole('button', { name: '撤销授权', exact: true }).waitFor()
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(1)
    expect(await page.evaluate<string>('window.fixture.facts().confirms[0].input.requestId')).toBeTruthy()
    await page.goto(`http://127.0.0.1:${server.port}/?task`)
    await page.getByLabel('项目总模型费用上限（美元）', { exact: true }).waitFor()
    expect(await page.getByText('本任务预算与管理范围', { exact: true }).count()).toBe(0)
    await page.goto(`http://127.0.0.1:${server.port}/?attention`)
    const attentionText = await page.locator('section[aria-label="Owner管理委托"]').innerText()
    expect(attentionText).toContain('Owner 已暂停：需要核对上次请求')
    expect(attentionText).toContain('Owner 已暂停并保留你的新消息')
    expect(attentionText).toContain('重新确认授权范围不会解除这次暂停')
    expect(attentionText).toContain('预留金额按保守上界计算，不是实际账单')
    expect(attentionText).toContain('暂停原因：模型输出达到本次请求上限，未形成完整结果')
    expect(attentionText).toContain('输入 1849 / 输出 4096 tokens')
    expect(attentionText).toContain('服务商请求编号：本地没有保存服务商请求编号 · 响应编号：d713371a-eb05-4a91-a53f-a2b8f46f94fb')
    expect(attentionText).toContain('处理详情：Owner安排输出达到本次请求上限')
    expect(attentionText).toContain('当前界面没有将外部账单核对结果写回并恢复授权的操作')
    const readsBeforeRefresh = await page.evaluate<number>('window.fixture.facts().reads')
    await page.getByRole('button', { name: '重新读取上次请求状态', exact: true }).click()
    await page.waitForFunction(`window.fixture.facts().reads>${readsBeforeRefresh}`)
    await page.getByRole('status').filter({ hasText: '已重新读取本地状态' }).waitFor()
    expect(await page.getByText(/不会查询账单或解除暂停/).count()).toBe(1)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    expect(await page.evaluate<number>('window.fixture.facts().previews.length')).toBe(0)
    await page.goto(`http://127.0.0.1:${server.port}/?bindingstale`)
    await page.getByRole('alert').filter({ hasText: 'Owner管理配置已变化，请重新确认' }).waitFor()
    const bindingsBeforeRetry = await page.evaluate<number>('window.fixture.facts().bindings')
    await page.getByRole('button', { name: '重新核对授权范围', exact: true }).click()
    await page.getByText('项目总模型费用上限为 $1.50', { exact: false }).waitFor()
    expect(await page.evaluate<number>('window.fixture.facts().bindings')).toBeGreaterThan(bindingsBeforeRetry)
    expect(await page.evaluate<number>('window.fixture.facts().previews.length')).toBe(2)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(0)
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    await page.waitForFunction('window.fixture.facts().confirms.length===1', undefined, { timeout: 3000 })
    expect(await page.evaluate<number>('window.fixture.facts().confirms.at(-1).input.startApproval ? 1 : 0')).toBe(0)
    await page.goto(`http://127.0.0.1:${server.port}/?race`)
    await page.getByText('项目总模型费用上限为 $1.50', { exact: false }).waitFor()
    await page.getByRole('button', { name: '确认范围，让 Owner 自主推进', exact: true }).click()
    await page.getByText('Owner 已暂停：授权范围需要重新确认', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: '不会沿用旧授权' }).waitFor()
    expect(await page.locator('section[aria-label="Owner管理委托"]').innerText()).not.toContain('Owner管理委托的配置、资料或价格已变化')
    expect(await page.evaluate<number>('window.fixture.facts().reads')).toBeGreaterThan(1)
    expect(await page.evaluate<number>('window.fixture.facts().confirms.length')).toBe(1)
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
