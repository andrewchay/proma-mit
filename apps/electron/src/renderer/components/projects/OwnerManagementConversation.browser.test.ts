import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from '@playwright/test'
const root = resolve(import.meta.dir, '../../../../../..'), renderer = join(root, 'apps/electron/src/renderer')
const directory = mkdtempSync(join(tmpdir(), 'owner-dialogue-browser-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const browserTest = existsSync(chromium.executablePath()) ? test : test.skip
browserTest('Given持久Owner会话与待审方案 When讨论、回包丢失重提及切页 Then原对话恢复且方案不单独审批', async () => {
  writeFileSync(join(directory, 'entry.tsx'), `
import React from 'react';import {createRoot} from 'react-dom/client';import {Provider,createStore} from 'jotai';
import {OwnerManagementConversation} from ${JSON.stringify(join(renderer, 'components/projects/OwnerManagementConversation.tsx'))};
import {ProjectOwnerPlanPanel} from ${JSON.stringify(join(renderer, 'components/projects/ProjectOwnerPlanPanel.tsx'))};
import {loadOwnerManagementAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-management-atoms.ts'))};
import {loadOwnerPlanAtom} from ${JSON.stringify(join(renderer, 'atoms/project-owner-plan-atoms.ts'))};
import {ownerGoalEditorsAtom,getOwnerGoalEditor} from ${JSON.stringify(join(renderer, 'atoms/project-owner-goal-atoms.ts'))};
import {ownerDelegationEditorsAtom,getOwnerDelegationEditor} from ${JSON.stringify(join(renderer, 'atoms/owner-management-delegation-atoms.ts'))};
import {allPendingPermissionRequestsAtom} from ${JSON.stringify(join(renderer, 'atoms/agent-atoms.ts'))};
const store=createStore(),app=createRoot(document.getElementById('root')),ok=value=>({ok:true,value});
let approvals=[],actionRequests=[],calls=[],workspaceApprovals=[],lose=true,confirmed=0,readGate=null,releaseRead=null;const listeners=new Set();let trace=[{eventId:'a'.repeat(64),projectId:'p',phase:'assignment_run',state:'started',createdAt:1700000000000,detailCode:'provider_pending'},{eventId:'b'.repeat(64),projectId:'p',phase:'assignment_preparation',state:'completed',createdAt:1700000001000,detailCode:'team_check'}];
const goal=projectId=>({schemaVersion:1,revision:1,state:'draft',actor:'local-user',savedAt:1,goal:{projectId,goalVersion:1,objective:'产品定位',constraints:[],acceptanceCriteria:[]}});
const manager=projectId=>({schemaVersion:1,projectId,ownerId:'owner-'+projectId,conversationId:'conversation-'+projectId,revision:1,status:'active',createdAt:1,updatedAt:1});
const messages=[{id:'prior',projectId:'p',conversationId:'conversation-p',eventId:'event',role:'assistant',kind:'reply',content:'上次讨论保留一页建议。',createdAt:1}];
const sources={project:{id:'p',title:'项目',description:''},roles:[{key:'research',name:'调研',version:'1.0.0',sourceSha256:'a'.repeat(64),rulesSha256:'b'.repeat(64)}]};
let plan={projectId:'p',schemaVersion:1,revision:1,planVersion:1,goalRevision:1,goalVersion:1,state:'proposed',actor:'local-user',origin:'generated',sourceRun:{executionId:'raw-run-id',receiptId:'receipt',responseHash:'hash'},savedAt:1,changeReason:'建议',contextFingerprint:'ctx',planFingerprint:'plan',sources,proposal:{projectId:'p',goalVersion:1,mode:'proposal_only',summary:'先形成一页定位建议',assumptions:[],risks:['资料不足时再协商'],steps:[{key:'brief',title:'定位调研',outcome:'一页建议',acceptanceCriteria:['说明取舍'],dependencies:[],roleKey:'research'}]}};
window.electronAPI={respondPermission:async input=>{approvals.push(input)},paa:{project:{getOwnerManagement:async({projectId})=>ok({manager:manager(projectId),messages:messages.filter(item=>item.projectId===projectId),questions:[],pendingEvents:0,actionRequests:projectId==='p'?actionRequests:[],trace:projectId==='p'?trace:[]}),confirmOwnerTeamWorkspaceAccess:async input=>{workspaceApprovals.push(input);const item={id:'approval-'+workspaceApprovals.length,projectId:input.projectId,conversationId:'conversation-'+input.projectId,eventId:'approval-event-'+workspaceApprovals.length,role:'user',kind:'conversation',content:'我确认将工作区纳入本项目。',createdAt:7};messages.push(item);listeners.forEach(cb=>cb({projectId:input.projectId,messageId:item.id}));return ok(undefined)},
onOwnerManagementChanged:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},
sendOwnerManagementMessage:async input=>{calls.push(input);let message=messages.find(item=>item.eventId===input.requestId);if(!message){message={id:'m-'+calls.length,projectId:input.projectId,conversationId:input.conversationId,eventId:input.requestId,goalRevision:input.expectedGoalRevision,role:'user',kind:'conversation',content:input.content,...(input.deliveryReference?{deliveryReference:input.deliveryReference}:{}),createdAt:2};messages.push(message)}if(lose){lose=false;throw Error('模拟回包丢失')}return ok(message)},
getOwnerPlanDraft:async()=>{const captured=structuredClone(plan);if(readGate){const gate=readGate;readGate=null;await gate}return ok(captured)},getOwnerPlanningContext:async()=>ok({goal:goal('p'),sources,fingerprint:'ctx'}),listOwnerPlanHistory:async()=>ok([]),saveOwnerPlanDraft:async()=>{throw Error("禁止手工修改")},
confirmOwnerPlanDraft:async()=>{confirmed++;plan={...plan,state:'confirmed',revision:plan.revision+1};return ok(plan)}
}}};
const render=projectId=>{const subject={projectId};const entries=new Map(store.get(ownerGoalEditorsAtom));entries.set(JSON.stringify([projectId,null]),{...getOwnerGoalEditor(new Map(),subject),loaded:true,snapshot:goal(projectId)});store.set(ownerGoalEditorsAtom,entries);app.render(<Provider store={store}><OwnerManagementConversation key={projectId} projectId={projectId}>{projectId==='p'&&<ProjectOwnerPlanPanel projectId="p" conversational/>}</OwnerManagementConversation></Provider>)};
window.dialogueFixture={render,approvals:()=>approvals,setActionRequests:async()=>{actionRequests=[{requestId:'r1',sessionId:'s1',taskId:'t1'},{requestId:'r2',sessionId:'s1',taskId:'t1'}];store.set(allPendingPermissionRequestsAtom,new Map([['s1',actionRequests.map(item=>({...item,toolName:'Write',toolInput:{file_path:'package.json',content:'exact-content-'+item.requestId},description:'write',dangerLevel:'dangerous',requiresPerActionApproval:true}))],['unrelated',[{requestId:'other',sessionId:'unrelated',toolName:'Write',toolInput:{content:'other-project-secret'},dangerLevel:'dangerous',requiresPerActionApproval:true}]]]));await store.set(loadOwnerManagementAtom,'p')},setStaleGrant:()=>{const subject={projectId:'p'},entries=new Map(store.get(ownerDelegationEditorsAtom));entries.set(JSON.stringify(['p',null]),{...getOwnerDelegationEditor(entries,subject),view:{delegation:{id:'grant',projectId:'p',maxCostMicros:5000000,expiresAt:Date.now()+3600000},state:'stale',usedRequests:1,reservedCostMicros:930000,detail:'项目配置已变化'}});store.set(ownerDelegationEditorsAtom,entries)},activateGrant:()=>{const subject={projectId:'p'},entries=new Map(store.get(ownerDelegationEditorsAtom)),old=getOwnerDelegationEditor(entries,subject);entries.set(JSON.stringify(['p',null]),{...old,view:{...old.view,state:'active'}});store.set(ownerDelegationEditorsAtom,entries)},beginDelayedRead:()=>{readGate=new Promise(resolve=>{releaseRead=resolve});void store.set(loadOwnerPlanAtom,{projectId:'p'})},newPlan:()=>{plan={...plan,revision:2,proposal:{...plan.proposal,summary:'按讨论更新为精简方案'}};const item={id:'new-plan',projectId:'p',conversationId:'conversation-p',eventId:'new-plan-event',role:'assistant',kind:'plan_proposal',content:'新方案可审阅。',createdAt:4};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}));releaseRead()},facts:()=>({calls,messages,confirmed,workspaceApprovals}),clearTrace:()=>{trace=[];listeners.forEach(cb=>cb({projectId:'p',messageId:'trace-refresh'}))},setAuthorizationChangedTrace:async()=>{trace=[{eventId:'c'.repeat(64),projectId:'p',phase:'owner_response',state:'blocked',createdAt:1700000002000,detailCode:'authorization_changed'}];await store.set(loadOwnerManagementAtom,'p')},setAttention:()=>{const item={id:'attention',projectId:'p',conversationId:'conversation-p',eventId:'attention-event',role:'assistant',kind:'attention',content:'没有可用员工，等待你决定。',createdAt:5};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}))},setTeamWorkspaceProposal:()=>{const item={id:'team-proposal',projectId:'p',conversationId:'conversation-p',eventId:'team-proposal-event',role:'assistant',kind:'attention',content:'团队不足，建议授权工作区。',teamWorkspaceProposal:{workspaceId:'team-ws',workspaceName:'产品团队',eligibleEmployeeCount:3,scopeFingerprint:'c'.repeat(64)},createdAt:8};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}))},resume:()=>{const item={id:'resume',projectId:'p',conversationId:'conversation-p',eventId:'resume-event',role:'assistant',kind:'management_progress',content:'已经恢复安排。',createdAt:6};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}))},setOverflowTrace:()=>{trace=Array.from({length:35},(_,index)=>({eventId:(index+1).toString(16).padStart(64,'0'),projectId:'p',phase:'assignment_run',state:'completed',createdAt:1700000000000+index,detailCode:'result_ready'}));listeners.forEach(cb=>cb({projectId:'p',messageId:'trace-overflow'}))},reply:()=>{const item={id:'reply',projectId:'p',conversationId:'conversation-p',eventId:'reply-event',role:'assistant',kind:'reply',content:'建议保留现有用户作为首要受众。',createdAt:3};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}))},deliverAfterStaleAssignment:()=>{trace=[{eventId:'stale-assignment',projectId:'p',phase:'assignment_run',state:'started',createdAt:1700000001000,detailCode:'provider_pending'}];const item={id:'delivery',projectId:'p',conversationId:'conversation-p',eventId:'delivery-event',role:'assistant',kind:'delivery',content:'本轮工作已完成并交付。',createdAt:1700000002000,delivery:{schemaVersion:1,planVersion:1,items:[{stepKey:'design',title:'设计稿',content:'设计成果',artifactHash:'d'.repeat(64),acceptanceCriteria:['清晰'],ownerDecision:'可交付',reviewerSummary:'已核对'}]}};messages.push(item);listeners.forEach(cb=>cb({projectId:'p',messageId:item.id}))}};render('p');
`)
  await build({ entryPoints: [join(directory, 'entry.tsx')], outfile: join(directory, 'entry.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', absWorkingDir: root, nodePaths: [join(root, 'node_modules'), join(root, 'apps/electron/node_modules')], alias: { '@': renderer }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'silent', plugins: [{ name: 'business-boundary', setup(builder) { builder.onLoad({ filter: /ProjectOwnerExecutionConversation\.tsx$/ }, () => ({ contents: 'export function ProjectOwnerExecutionConversation(){return null}', loader: 'tsx' })) } }] })
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<div id="root"></div><script src="/entry.js"></script>', { headers: { 'Content-Type': 'text/html' } }), routes: { '/entry.js': () => new Response(Bun.file(join(directory, 'entry.js'))) } })
  const browser = await chromium.launch({ headless: true }), page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  page.setDefaultTimeout(5000)
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(`http://127.0.0.1:${server.port}`)
    await page.getByText('上次讨论保留一页建议。', { exact: true }).waitFor()
    await page.evaluate('window.dialogueFixture.setStaleGrant()')
    await page.getByRole('alert').getByText('管理授权因项目目标、配置、资料或费用依据变化而暂停。', { exact: false }).waitFor()
    expect(await page.getByRole('alert').innerText()).toContain('消息会保留且不会发送')
    await page.getByLabel('Owner方案摘要').waitFor()
    const progress = page.getByLabel('Owner组织进度')
    await progress.waitFor()
    await page.getByText('正在生成内部团队安排。', { exact: true }).waitFor()
    expect(await progress.innerText()).toContain('没有可靠的固定预计时长')
    expect(await progress.innerText()).toContain('Owner会继续检查处理状态，你不必重复发送')
    expect(await page.getByLabel('内部处理记录').count()).toBe(0)
    await page.evaluate('window.dialogueFixture.setAttention()')
    await page.getByLabel('Owner最新处理结果').getByText('没有可用员工，等待你决定。', { exact: true }).waitFor()
    await page.getByText('Owner正在等你处理一项待确认内容。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '回复 Owner' }).first().click()
    await page.waitForFunction(() => document.activeElement === document.querySelector('form[aria-label="向Owner发送消息"] [contenteditable="true"][aria-label="给项目 Owner 的消息"]'))
    expect(await page.getByLabel('Owner正在处理').count()).toBe(0)
    expect(await progress.innerText()).not.toContain('已等待')
    await page.evaluate('window.dialogueFixture.resume()')
    await page.evaluate('window.dialogueFixture.activateGrant()')
    await page.getByText('正在生成内部团队安排。', { exact: true }).waitFor()
    expect(await page.getByLabel('Owner最新处理结果').count()).toBe(0)
    const processingIndicator = page.getByLabel('Owner正在处理')
    await processingIndicator.waitFor({ state: 'attached' })
    expect(await processingIndicator.getAttribute('class')).toContain('sidebar-breathe-running')
    await page.evaluate('window.dialogueFixture.setAuthorizationChangedTrace()')
    expect(await page.getByLabel('内部处理记录').count()).toBe(0)
    await page.evaluate('window.dialogueFixture.setOverflowTrace()')
    expect(await page.getByLabel('内部处理记录').count()).toBe(0)
    expect(await progress.innerText()).toContain('内部安排已生成，正在核对下一步。')
    expect(await progress.innerText()).not.toContain('已等待')
    expect(await page.getByRole('combobox').isVisible()).toBe(false)
    expect(await page.getByLabel('步骤标题', { exact: true }).isVisible()).toBe(false)
    expect(await page.getByText('来源Run：raw-run-id', { exact: false }).isVisible()).toBe(false)
    await page.getByLabel('给项目 Owner 的消息').fill('解释一下受众取舍')
    await page.getByRole('button', { name: '发送给 Owner', exact: true }).click()
    await page.getByText('模拟回包丢失。原消息已保留。', { exact: true }).waitFor()
    expect(await page.getByLabel('给项目 Owner 的消息').innerText()).toBe('解释一下受众取舍')
    await page.getByRole('button', { name: '重新确认原消息已保存', exact: true }).click()
    await page.getByRole('log').getByText('解释一下受众取舍', { exact: true }).waitFor()
    expect(await page.getByLabel('给项目 Owner 的消息').textContent()).toBe('')
    expect(await page.evaluate<boolean>('window.dialogueFixture.facts().calls[0].requestId===window.dialogueFixture.facts().calls[1].requestId')).toBe(true)
    await page.evaluate('window.dialogueFixture.reply()')
    await page.getByLabel('Owner历史对话').getByText('建议保留现有用户作为首要受众。', { exact: true }).waitFor()
    await page.getByText('查看Owner对此的最近回应', { exact: true }).click()
    expect(await page.getByLabel('最近补充对项目的影响').innerText()).toContain('建议保留现有用户作为首要受众。')
    await page.getByLabel('给项目 Owner 的消息').fill('项目P未发送草稿')
    await page.evaluate('window.dialogueFixture.render("q")')
    await page.waitForFunction(() => document.querySelector('[contenteditable="true"][aria-label="给项目 Owner 的消息"]')?.textContent === '')
    expect(await page.getByLabel('给项目 Owner 的消息').textContent()).toBe('')
    expect(await page.getByText('建议保留现有用户作为首要受众。', { exact: true }).count()).toBe(0)
    await page.evaluate('window.dialogueFixture.render("p")')
    await page.getByLabel('Owner历史对话').getByText('建议保留现有用户作为首要受众。', { exact: true }).waitFor()
    expect(await page.getByLabel('给项目 Owner 的消息').innerText()).toBe('项目P未发送草稿')
    await page.evaluate('window.dialogueFixture.clearTrace()')
    expect(await page.getByLabel('内部处理记录').count()).toBe(0)
    await page.evaluate('window.dialogueFixture.beginDelayedRead()')
    await page.evaluate('window.dialogueFixture.newPlan()')
    await page.getByLabel('Owner方案摘要').getByText('按讨论更新为精简方案', { exact: true }).waitFor()
    expect(await page.getByRole('button', { name: '确认这个方案', exact: true }).count()).toBe(0)
    expect(await page.evaluate<number>('window.dialogueFixture.facts().confirmed')).toBe(0)
    await page.evaluate('window.dialogueFixture.setTeamWorkspaceProposal()')
    await page.getByLabel('团队工作区范围建议').waitFor()
    const teamScope = await page.getByLabel('团队工作区范围建议').innerText()
    expect(teamScope).toContain('产品团队')
    expect(teamScope).toContain('资料、技能和配置')
    expect(teamScope).not.toContain('3 名当前可用员工')
    await page.getByRole('button', { name: '允许本项目使用这个团队工作区' }).click()
    await page.getByText('范围已确认，Owner正在继续核对团队安排。', { exact: true }).waitFor()
    expect(await page.evaluate<number>('window.dialogueFixture.facts().workspaceApprovals.length')).toBe(1)
    await page.evaluate('window.dialogueFixture.deliverAfterStaleAssignment()')
    await page.getByLabel('Owner历史对话').getByText('本轮工作已完成并交付。', { exact: true }).waitFor()
    expect(await page.getByLabel('Owner组织进度').count()).toBe(0)
    const designReply = page.getByLabel('给项目 Owner 的消息')
    await designReply.fill('请调整标题')
    await page.getByRole('button', { name: '针对这个版本提出修改' }).click()
    await page.getByText('本条意见将关联已验收成果《设计稿》及其准确版本。', { exact: true }).waitFor()
    expect(await designReply.innerText()).toBe('请调整标题')
    await page.getByRole('button', { name: '取消关联' }).click()
    expect(await page.getByText('本条意见将关联已验收成果《设计稿》及其准确版本。').count()).toBe(0)
    expect(await designReply.innerText()).toBe('请调整标题')
    await designReply.fill('')
    expect(await page.getByText('已等待', { exact: false }).count()).toBe(0)
    await page.evaluate('window.dialogueFixture.setActionRequests()')
    const approval = page.getByLabel('员工动作需要你逐次审批')
    await approval.waitFor()
    expect(await approval.innerText()).toContain('exact-content-r1')
    expect(await approval.innerText()).not.toContain('other-project-secret')
    expect(await approval.getByText('始终允许', { exact: true }).count()).toBe(0)
    await page.getByRole('heading', { name: '需要你决定', exact: true }).focus().catch(() => {})
    await page.locator('body').click({ position: { x: 1, y: 1 } })
    await page.keyboard.press('Enter')
    expect(await page.evaluate<number>('window.dialogueFixture.approvals().length')).toBe(0)
    await approval.getByRole('button', { name: '允许', exact: true }).click()
    await approval.getByText('exact-content-r2', { exact: false }).waitFor()
    expect(await page.evaluate<Array<{ requestId: string; behavior: string; alwaysAllow: boolean }>>('window.dialogueFixture.approvals()')).toEqual([{ requestId: 'r1', behavior: 'allow', alwaysAllow: false }])
    await approval.getByRole('button', { name: '拒绝', exact: true }).click()
    await approval.waitFor({ state: 'detached' })
    expect(await page.evaluate<Array<{ requestId: string; behavior: string; alwaysAllow: boolean }>>('window.dialogueFixture.approvals()')).toEqual([{ requestId: 'r1', behavior: 'allow', alwaysAllow: false }, { requestId: 'r2', behavior: 'deny', alwaysAllow: false }])
    await designReply.fill('请调整标题')
    await page.getByLabel('已交付：设计稿').locator('pre').evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })
    await page.getByRole('button', { name: '针对选中片段提出修改' }).click()
    expect(await designReply.innerText()).toContain('设计成果')
    await page.getByRole('button', { name: '发送给 Owner' }).click()
    await page.waitForFunction('window.dialogueFixture.facts().calls.some(call => call.deliveryReference)')
    const sent = await page.evaluate<{ content: string; deliveryReference: { messageId: string; artifactHash: string; stepKey: string } }>('window.dialogueFixture.facts().calls.at(-1)')
    expect(sent.content).toContain('请调整标题')
    expect(sent.content).toContain('设计成果')
    expect(sent.deliveryReference).toEqual({ messageId: 'delivery', artifactHash: 'd'.repeat(64), stepKey: 'design' })
    expect(errors).toEqual([])
  } finally { await browser.close(); server.stop(true) }
}, 30000)
