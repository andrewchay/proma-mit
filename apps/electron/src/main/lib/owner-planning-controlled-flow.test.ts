import { afterAll, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-admission-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
let encrypted = false
const electron = { ...buildElectronMock(), safeStorage: { isEncryptionAvailable: () => encrypted, encryptString: (value: string) => Buffer.from(value, 'utf8'), decryptString: (value: Buffer) => value.toString('utf8') } }
mock.module('electron', () => electron)
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const bodies: Record<string, unknown>[] = []
let responseText = ''
let finishReason = 'stop'
let fault = ''
let releaseResponse: (() => void) | undefined
let beforeRunner: (() => void) | undefined
beforeEach(() => { bodies.length = 0; inFlight.length = 0; responseText = ''; finishReason = 'stop'; fault = ''; beforeRunner = undefined; releaseResponse = undefined })
const transport: typeof fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
  if (!String(_url).startsWith('https://example.invalid')) throw new Error('只接受离线假Provider域名，不触网')
  bodies.push(JSON.parse(String(init?.body)))
  if (fault === 'blocked') await new Promise<void>((resolve, reject) => { releaseResponse = resolve; init?.signal?.addEventListener('abort', () => reject(new DOMException('离线abort','AbortError')), {once:true}) })
  if (fault === 'network') throw new Error('离线可能已发送后的连接中断')
  if (fault === 'redirect') return new Response(null,{status:302,headers:{location:'https://other.invalid'}})
  if (fault === 'partial') { let n=0; return new Response(new ReadableStream<Uint8Array>({async pull(c) { if (!n++) c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',created:1,model:'model',choices:[{index:0,delta:{content:'partial-evidence'},finish_reason:null}]})+'\n\n')); else { await new Promise(r => setTimeout(r,5)); c.error(new Error('离线断流')) } }}),{headers:{'content-type':'text/event-stream'}}) }
  return new Response([
    'data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',created:1,model:'model',choices:[{index:0,delta:{content:responseText},finish_reason:null}]}),
    'data: '+JSON.stringify({id:'fake',object:'chat.completion.chunk',created:1,model:'model',choices:[{index:0,delta:{},finish_reason:finishReason}],...(fault==='no_usage'?{}:{usage:{prompt_tokens:12,completion_tokens:40,total_tokens:52}})}),
    'data: [DONE]','',
  ].join('\n\n'), {headers:{'content-type':'text/event-stream'}})
}, { preconnect: () => {} })
// 仅fake最终transport与Electron/host；不mock source、fee authorization、claim、SDK/Adapter/Orchestrator/Worker。
mock.module('./proxy-fetch', () => ({ getFetchFn: () => transport }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')

beforeAll(async () => { await store.initProjectDb() })
afterAll(async () => { releaseResponse?.(); await Promise.allSettled(inFlight); employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture(provider: 'openai' | 'anthropic' | 'google' = 'openai', baseUrl = 'https://example.invalid') {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider, baseUrl, apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, channel, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function prepared(provider: 'openai' | 'anthropic' | 'google' = 'openai', baseUrl?: string) { const f = fixture(provider, baseUrl); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); return { ...f, link } }
const controlled = await import('./controlled-project-task-service')
const runService = await import('./project-owner-planning-run-service')
const plans = await import('./project-owner-plan-service')
const registry = await import('./agent-headless-runner-registry')
const { AgentOrchestrator } = await import('./agent-orchestrator')
const { AISDKAgentAdapter } = await import('./adapters/ai-sdk-agent-adapter')
const { AgentEventBus } = await import('./agent-event-bus')
const { createElectronRuntimeServices } = await import('./agent-runtime/runtime-services')
const bus = new AgentEventBus(), services = createElectronRuntimeServices(bus)
const orchestrator = new AgentOrchestrator(new AISDKAgentAdapter(services.mcp),bus,services)
const inFlight: Promise<void>[] = []
registry.setAgentStopper((sessionId,generation) => orchestrator.stop(sessionId,generation))
registry.setHeadlessAgentRunner(async (input, callbacks) => {
  beforeRunner?.()
  const promise=orchestrator.sendMessage(input,{onError:callbacks.onError,onComplete:callbacks.onComplete,onTitleUpdated:callbacks.onTitleUpdated});inFlight.push(promise);await promise
})
test('Given 已批准费用与冻结Owner准备 When 真实start/claim→Worker/Orchestrator/Adapter/SDK Then 最终只发一请求，生成可审Plan且不派工', async () => {
  const f=prepared(), snapshot=source.readOwnerPlanningSnapshot(f.link.planningTaskId)!
  responseText=JSON.stringify({schemaVersion:1,kind:'plan_proposal',projectId:f.project.id,goalVersion:1,contextFingerprint:f.link.contextFingerprint,proposal:{summary:'完整离线链定位提案',assumptions:[],risks:[],steps:[{key:'brief',title:'定位研究',outcome:'定位简报',acceptanceCriteria:['范围明确'],dependencies:[],roleKey:snapshot.context.sources.roles[0]!.key}]}})
  const preview=controlled.getControlledTaskStartPreview(f.link.planningTaskId)
  await expect(controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:false})).rejects.toThrow('费用')
  expect(bodies).toHaveLength(0)
  const result=await controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:true});await Promise.all(inFlight)
  expect(bodies).toHaveLength(1);expect(bodies[0]).toMatchObject({model:'model',max_tokens:4096,messages:[{role:'system',content:snapshot.request.systemPrompt},{role:'user',content:snapshot.request.userPrompt}]});expect(bodies[0]?.tools).toBeUndefined()
  expect(store.getAgentExecution(result.executionId)?.status).toBe('completed');expect(plans.getProjectOwnerPlanDraft(f.project.id)).toMatchObject({origin:'generated',state:'proposed'});expect(runService.getOwnerPlanningRunOutcome(result.executionId)?.state).toBe('proposed');expect(store.getTask(f.link.planningTaskId)?.status).toBe('paused');expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  const repeated=await controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:true});expect(repeated.executionId).toBe(result.executionId);expect(bodies).toHaveLength(1)
})

function proposal(f: ReturnType<typeof prepared>) {
  const snapshot=source.readOwnerPlanningSnapshot(f.link.planningTaskId)!
  return {schemaVersion:1,kind:'plan_proposal',projectId:f.project.id,goalVersion:1,contextFingerprint:f.link.contextFingerprint,proposal:{summary:'真实单请求提案',assumptions:[],risks:[],steps:[{key:'brief',title:'定位研究',outcome:'定位简报',acceptanceCriteria:['范围明确'],dependencies:[],roleKey:snapshot.context.sources.roles[0]!.key}]}}
}
async function start(f: ReturnType<typeof prepared>) {
  const preview=controlled.getControlledTaskStartPreview(f.link.planningTaskId)
  const result=await controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:true})
  return {...result,preview}
}
async function settle(){ await Promise.all(inFlight) }
function releasePendingResponse(){ const release=releaseResponse; if(!release) throw new Error('离线response尚未就绪');release() }
test('Given 必要澄清 When 真实SDK终态 Then 一请求unknown费用，业务不完成且无Plan/自动续问',async () => {
  const f=prepared(), {proposal:_proposal,...scope}=proposal(f);responseText=JSON.stringify({...scope,kind:'needs_clarification',reason:'范围不明确',questions:[{key:'audience',question:'核心受众是谁？',why:'影响定位',options:[]}]})
  const result=await start(f);await settle();const outcome=runService.getOwnerPlanningRunOutcome(result.executionId)!
  expect(outcome.state).toBe('needs_clarification');expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)).toMatchObject({cost:{source:'unknown',usd:null},usage:{inputTokens:12,outputTokens:40}});expect(bodies).toHaveLength(1);expect(store.listTasks(f.project.id)).toHaveLength(1)
})
test('Given source/费用范围更新 When 旧preview或Runner之前变化 Then 权威门禁0发送',async () => {
  const f=prepared(), preview=controlled.getControlledTaskStartPreview(f.link.planningTaskId)
  saveProjectOwnerGoalDraft(f.project.id,1,{objective:'修改后的目标'})
  await expect(controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:true})).rejects.toThrow('已更新');expect(bodies).toHaveLength(0);expect(store.listAgentExecutionsByEntity('task',f.link.planningTaskId)).toHaveLength(0)
  const next=prepared();responseText=JSON.stringify(proposal(next));beforeRunner=()=>saveProjectOwnerGoalDraft(next.project.id,1,{objective:'Runner前修改'})
  const result=await start(next);await Promise.allSettled(inFlight);expect(bodies).toHaveLength(0);expect(plans.getProjectOwnerPlanDraft(next.project.id)).toBeNull();expect(store.getAgentExecution(result.executionId)?.status).not.toBe('completed')
})
test('Given SDK length/网络失败/断流/302 When 单真实准入后终态 Then 保留证据不重发，不推断零费用', async () => {
  for (const mode of ['length','network','partial','redirect']) {
    bodies.length=0;inFlight.length=0;fault=mode==='length'?'':mode;finishReason=mode==='length'?'length':'stop'
    const f=prepared();responseText=JSON.stringify(proposal(f));const result=await start(f);await settle()
    const outcome=runService.getOwnerPlanningRunOutcome(result.executionId)!,receipt=runService.getOwnerPlanningRunReceipt(outcome.receiptId)!
    expect(outcome.state).toBe('failed');expect(receipt.cost).toEqual({source:'unknown',usd:null});expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(bodies).toHaveLength(1);if(mode==='partial')expect(receipt.responseText).toBe('partial-evidence')
    const admission=store.getProjectDb().prepare('SELECT execution_id FROM project_owner_planning_admissions WHERE execution_id=?').get(result.executionId);expect(admission).toBeDefined()
    const again=await controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:result.preview.previewHash,acknowledgeModelCosts:true});expect(again.executionId).toBe(result.executionId);expect(bodies).toHaveLength(1)
  }
})
test('Given HTTP已发送而心跳失联 When late success Then 原文保留但stale不生成不补发',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));fault='blocked';const result=await start(f)
  while(!releaseResponse) await new Promise(r=>setTimeout(r,1))
  store.updateAgentExecution(result.executionId,{lastHeartbeatAt:Date.now()-10*60_000});employees.scanAgentEmployeeHeartbeat();expect(store.getAgentExecution(result.executionId)?.status).toBe('stale')
  releasePendingResponse();await settle();expect(runService.getOwnerPlanningRunOutcome(result.executionId)?.state).toBe('unknown');expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(bodies).toHaveLength(1)
})
test('Given 启动前持久stop意图 When Runner/body尚未发送 Then 停止收紧发送能力，不等abort失败后仍收费',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));beforeRunner=()=> { const execution=store.listAgentExecutionsByEntity('task',f.link.planningTaskId)[0]!;runService.requestOwnerPlanningStop(execution.id) }
  await start(f);await Promise.allSettled(inFlight);expect(bodies).toHaveLength(0);expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull()
})
test('Given 在途真实SDK generation When 错代际stop/实际取消 Then 不停止其他代际，持久stop保unknown费用且不生成',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));fault='blocked';const result=await start(f)
  while(!releaseResponse) await new Promise(r=>setTimeout(r,1))
  const sessionId=store.getAgentExecution(result.executionId)!.sessionId;expect(orchestrator.stop(sessionId,-1)).toMatchObject({requestAccepted:false,reason:'generation-mismatch'})
  expect(employees.cancelAgentExecution(result.executionId)).toMatchObject({stopRequested:true,processTermination:'NOT_VERIFIED'})
  await settle();expect(runService.getOwnerPlanningRunOutcome(result.executionId)?.state).toBe('stopped');expect(store.getAgentExecution(result.executionId)?.status).toBe('cancelled');expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(bodies).toHaveLength(1)
})

test('Given SDK只返回合法文本未报告usage When 真实完成 Then 保持null未知而非兼容零token/成本估价',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));fault='no_usage';const result=await start(f);await settle()
  const outcome=runService.getOwnerPlanningRunOutcome(result.executionId)!, receipt=runService.getOwnerPlanningRunReceipt(outcome.receiptId)!
  expect(outcome.state).toBe('proposed');expect(receipt).toMatchObject({cost:{source:'unknown',usd:null},usage:{inputTokens:null,outputTokens:null}});expect(bodies).toHaveLength(1)
})
test('Given 确认TTL经过/冻结费用范围被改 When Runner即将开始 Then 再次权威复核0发送且无Plan',async () => {
  for (const mode of ['expired','scope','owner_marker']) {
    beforeRunner=undefined;bodies.length=0;inFlight.length=0
    const f=prepared();responseText=JSON.stringify(proposal(f))
    beforeRunner=()=> { if(mode==='expired')store.getProjectDb().prepare('UPDATE controlled_task_preparations SET authorized_until=? WHERE task_id=?').run(Date.now()-1,f.link.planningTaskId);else if(mode==='scope')store.updateAgentEmployee(f.employee.id,{systemPrompt:'员工配置已变化'});else store.getProjectDb().prepare('DELETE FROM project_owner_planning_links WHERE id=?').run(f.link.id) }
    const result=await start(f);await Promise.allSettled(inFlight)
    expect(bodies).toHaveLength(0);expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(store.getAgentExecution(result.executionId)?.status).not.toBe('completed');expect(store.listAgentEmployeeLearningSamples(f.employee.id)).toHaveLength(0)
  }
})
test('Given 同preview同时双击 When 真实排队与发送 Then 原子认领同一execution/唯一admission/单请求',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));const preview=controlled.getControlledTaskStartPreview(f.link.planningTaskId)
  const input={taskId:f.link.planningTaskId,previewHash:preview.previewHash,acknowledgeModelCosts:true}
  const [a,b]=await Promise.all([controlled.startControlledTask(input),controlled.startControlledTask(input)]);await settle()
  expect(a.executionId).toBe(b.executionId);expect(bodies).toHaveLength(1);expect(store.listAgentExecutionsByEntity('task',f.link.planningTaskId)).toHaveLength(1);expect(store.getProjectDb().prepare('SELECT execution_id FROM project_owner_planning_admissions WHERE execution_id=?').all(a.executionId)).toHaveLength(1)
})
test('Given 真实发送后DB关闭重开 When 重复启动相同费用确认 Then 回执/来源/admission不丢且不补发',async () => {
  const f=prepared();responseText=JSON.stringify(proposal(f));const result=await start(f);await settle()
  const outcome=runService.getOwnerPlanningRunOutcome(result.executionId)!;store.closeProjectDb();await store.initProjectDb()
  expect(runService.getOwnerPlanningRunOutcome(result.executionId)).toEqual(outcome);expect(runService.getOwnerPlanningRunReceipt(outcome.receiptId)?.responseText).toBe(responseText);expect(plans.getProjectOwnerPlanDraft(f.project.id)?.origin).toBe('generated')
  await controlled.startControlledTask({taskId:f.link.planningTaskId,previewHash:result.preview.previewHash,acknowledgeModelCosts:true});expect(bodies).toHaveLength(1)
})
test('Given 真实准入后摘要/时间/本地完整性损坏 When SDK终态 Then callback隔离，不生成/认定费用或补发',async () => {
  for(const mode of ['empty','invalid','replaced','time','legacy']) {
    bodies.length=0;inFlight.length=0;releaseResponse=undefined;const f=prepared();responseText=JSON.stringify(proposal(f));fault='blocked';const result=await start(f)
    while(!releaseResponse) await new Promise(r=>setTimeout(r,1))
    if(mode==='time')store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET admitted_at=1 WHERE execution_id=?').run(result.executionId)
    else if(mode==='legacy')store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET integrity_hash=NULL WHERE execution_id=?').run(result.executionId)
    else store.getProjectDb().prepare('UPDATE project_owner_planning_admissions SET request_hash=? WHERE execution_id=?').run(mode==='empty'?'':mode==='invalid'?'x'.repeat(64):'a'.repeat(64),result.executionId)
    releasePendingResponse();await settle();expect(store.getAgentExecution(result.executionId)?.status).toBe('stale');expect(plans.getProjectOwnerPlanDraft(f.project.id)).toBeNull();expect(store.getProjectDb().prepare('SELECT id FROM project_owner_planning_callback_evidence WHERE execution_id=?').all(result.executionId)).toHaveLength(1);expect(runService.getOwnerPlanningRunOutcome(result.executionId)).toBeNull();expect(bodies).toHaveLength(1)
  }
})
