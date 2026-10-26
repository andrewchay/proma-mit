import { afterAll, beforeAll, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
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
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')
const controlled = await import('./controlled-project-task-service')
const { createControlledProviderFetch } = await import('./controlled-provider-boundary')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { AISDKRuntimeCore } = await import('./agent-runtime/ai-sdk-runtime-core')
const { getAgentProviderProtocol } = await import('@gravitas/shared')
const { getConfigDir } = await import('./config-paths')
const auth = spyOn(controlled, 'assertControlledPreparedExecution')
let mockAuthorized = false
auth.mockImplementation(() => { if (!mockAuthorized) throw new Error('假准入未授权') })
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { auth.mockRestore(); employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
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
function running(f: ReturnType<typeof prepared>) {
  const sessionId = randomUUID(), executionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId, status: 'running', prompt: '不能信任此角色原文' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  return { executionId, sessionId }
}
function outlet() {
  const f = prepared(); const run = running(f); const scope = source.resolveOwnerPlanningSession(run.sessionId)!
  const cwd = join(getConfigDir(), 'agent-workspaces', f.workspace.slug, run.sessionId); mkdirSync(cwd, { recursive: true })
  const actual = { runtime: 'ai-sdk' as const, cwd, modelId: 'model', permissionMode: 'safe' }
  const body = JSON.stringify({ model: 'model', stream: true, max_tokens: 4096, messages: [{ role: 'system', content: scope.request.systemPrompt }, { role: 'user', content: scope.request.userPrompt }] })
  let sends = 0
  const fake: typeof fetch = Object.assign(async () => { sends++; return new Response('fake') }, { preconnect: () => {} })
  const guarded = createControlledProviderFetch(run.sessionId, () => actual, fake)!
  const init = { method: 'POST', headers: { authorization: 'Bearer fake', 'content-type': 'application/json' }, body }
  return { ...f, ...run, actual, fake, guarded, init, sent: () => sends }
}
function admitted(executionId: string) { return store.getProjectDb().prepare('SELECT * FROM project_owner_planning_admissions WHERE execution_id = ?').get(executionId) }
test('Given mocked controlled准入尚未授权 When finalfetch Then 无HTTP/占位', async () => {
  mockAuthorized = false; const f = outlet(); await expect(f.guarded('https://example.invalid/v1/chat/completions', f.init)).rejects.toThrow('未授权'); expect(f.sent()).toBe(0); expect(admitted(f.executionId)).toBeUndefined()
})
test('Given 明确隔离mock准入 When 两次并发finalfetch Then DB只准入一次，第二次不HTTP', async () => {
  mockAuthorized = true; const f = outlet(); const result = await Promise.allSettled([f.guarded('https://example.invalid/v1/chat/completions', f.init), f.guarded('https://example.invalid/v1/chat/completions', f.init)])
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(f.sent()).toBe(1); expect(admitted(f.executionId)).toBeDefined()
})
test('Given 占位后模拟HTTP网络失败 When 再试 Then unknown占位保留，不自动补请求', async () => {
  mockAuthorized = true; const f = outlet(); let calls = 0; const network: typeof fetch = Object.assign(async () => { calls++; throw new Error('fake network') }, { preconnect: () => {} }); const guarded = createControlledProviderFetch(f.sessionId, () => f.actual, network)!
  await expect(guarded('https://example.invalid/v1/chat/completions', f.init)).rejects.toThrow('fake network'); expect(admitted(f.executionId)).toBeDefined()
  await expect(guarded('https://example.invalid/v1/chat/completions', f.init)).rejects.toThrow('可能发送'); expect(calls).toBe(1)
})
test('Given 实际body/header变更 When finalfetch Then 事务回滚admitted时间/占位，HTTP零', async () => {
  mockAuthorized = true
  for (const update of [{ body: JSON.stringify({ model: 'model' }) }, { headers: { authorization: 'Bearer another' } }]) {
    const f = outlet(); await expect(f.guarded('https://example.invalid/v1/chat/completions', { ...f.init, ...update })).rejects.toThrow(); expect(f.sent()).toBe(0); expect(admitted(f.executionId)).toBeUndefined(); expect((store.getProjectDb().prepare('SELECT provider_admitted_at FROM controlled_task_preparations WHERE execution_id = ?').get(f.executionId) as { provider_admitted_at: number | null }).provider_admitted_at).toBeNull()
  }
})
test('Given 异步Request读取后actual钩子改Goal When finalfetch Then 重读来源拒绝HTTP', async () => {
  mockAuthorized = true; const f = outlet(); const guarded = createControlledProviderFetch(f.sessionId, () => { saveProjectOwnerGoalDraft(f.project.id, 1, { objective: '读取后源变' }); return f.actual }, f.fake)!
  await expect(guarded(new Request('https://example.invalid/v1/chat/completions', f.init))).rejects.toThrow('更新'); expect(f.sent()).toBe(0); expect(admitted(f.executionId)).toBeUndefined()
})
test('Given 外层事务回滚或DB重开 When 核查单请求准入 Then 无半回执/既有占位不重发', async () => {
  mockAuthorized = true; const rollback = outlet(); expect(() => store.getProjectDb().transaction(() => { claimOwnerPlanningProviderRequest(rollback.sessionId, rollback.init.body, new URL('https://example.invalid/v1/chat/completions')); throw new Error('rollback') })()).toThrow('rollback'); expect(admitted(rollback.executionId)).toBeUndefined(); expect(rollback.sent()).toBe(0)
  const f = outlet(); await f.guarded('https://example.invalid/v1/chat/completions', f.init); store.closeProjectDb(); await store.initProjectDb(); await expect(f.guarded('https://example.invalid/v1/chat/completions', f.init)).rejects.toThrow('可能发送'); expect(f.sent()).toBe(1)
})
test('Given 真实AI SDK序列化+mock费用准入 When 三协议经过真实finalbody/凭据/占位 Then 各单请求且可回token', async () => {
  mockAuthorized = true
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    const f = prepared(provider); const run = running(f); const scope = source.resolveOwnerPlanningSession(run.sessionId)!; const cwd = join(getConfigDir(), 'agent-workspaces', f.workspace.slug, run.sessionId); mkdirSync(cwd, { recursive: true }); let calls = 0
    const fake: typeof fetch = Object.assign(async () => {
      calls++
      if (provider === 'openai') return new Response(['data: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}','data: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}','data: [DONE]',''].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })
      if (provider === 'google') return new Response('data: '+JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 } })+'\n\n', { headers: { 'content-type': 'text/event-stream' } })
      const events = [{ type: 'message_start', message: { id: 'fake', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' }]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }, { preconnect: () => {} })
    const fetchFn = createControlledProviderFetch(run.sessionId, () => ({ runtime: 'ai-sdk', cwd, modelId: 'model', permissionMode: 'safe' }), fake)!
    const messages = await new AISDKRuntimeCore().runAgentTurn({ sessionId: run.sessionId, prompt: 'never sent', systemPrompt: 'never sent', modelId: 'model', provider, protocol: getAgentProviderProtocol(provider, 'ai-sdk'), apiKey: 'fake', baseUrl: f.channel.baseUrl, cwd, runtimeTools: [], activeSession: { controller: new AbortController(), permissionMode: 'safe', planModeEntered: false }, maxTurns: 9, maxRetries: 9, ownerPlanningRequest: scope.request, fetchFn })
    expect(calls).toBe(1); expect(messages.at(-1)).toMatchObject({ result: 'ok', finish_reason: 'stop', usage: { input_tokens: 12, output_tokens: 4 } }); expect(admitted(run.executionId)).toBeDefined()
  }
})

test('Given safeStorage加密渠道Key When 实际SDK/final凭据检查 Then 比较解密Key而非密文且不入占位', async () => {
  mockAuthorized = true; encrypted = true
  try { const f = outlet(); expect(f.channel.apiKey).not.toBe('fake'); await f.guarded('https://example.invalid/v1/chat/completions', f.init); expect(f.sent()).toBe(1); expect(JSON.stringify(admitted(f.executionId))).not.toContain('Bearer fake') } finally { encrypted = false }
})
test('Given 下游传入follow或Request自带follow When Owner最终运输 Then 强制redirect error且不重试', async () => {
  mockAuthorized = true
  for (const asRequest of [false, true]) {
    const f = outlet(); let calls = 0
    const fake: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => { calls++; expect(init?.redirect).toBe('error'); throw new Error('fake redirect refused') }, { preconnect: () => {} })
    const guarded = createControlledProviderFetch(f.sessionId, () => f.actual, fake)!
    const init = { ...f.init, redirect: 'follow' as const }
    await expect(asRequest ? guarded(new Request('https://example.invalid/v1/chat/completions', init)) : guarded('https://example.invalid/v1/chat/completions', init)).rejects.toThrow('redirect refused')
    expect(calls).toBe(1); expect(admitted(f.executionId)).toBeDefined()
  }
})

test('Given 真实本地transport返回307/308 When Owner发送 Then 只有原请求，重定向目标零访问且占位不释放', async () => {
  mockAuthorized = true
  for (const redirectStatus of [307, 308]) {
    let first = 0, followed = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { if (new URL(request.url).pathname === '/v1/chat/completions') { first++; return new Response(null, { status: redirectStatus, headers: { location: '/v1/redirect/chat/completions' } }) } followed++; return new Response('should not arrive') } })
    try {
      const baseUrl = `http://127.0.0.1:${server.port}/v1`; const f = prepared('openai', baseUrl); const run = running(f); const scope = source.resolveOwnerPlanningSession(run.sessionId)!
      const cwd = join(getConfigDir(), 'agent-workspaces', f.workspace.slug, run.sessionId); mkdirSync(cwd, { recursive: true })
      const guarded = createControlledProviderFetch(run.sessionId, () => ({ runtime: 'ai-sdk', cwd, modelId: 'model', permissionMode: 'safe' }), globalThis.fetch)!
      const init = { method: 'POST', headers: { authorization: 'Bearer fake' }, body: JSON.stringify({ model: 'model', stream: true, max_tokens: 4096, messages: [{ role: 'system', content: scope.request.systemPrompt }, { role: 'user', content: scope.request.userPrompt }] }) }
      await expect(guarded(`${baseUrl}/chat/completions`, init)).rejects.toThrow(); expect(first).toBe(1); expect(followed).toBe(0); expect(admitted(run.executionId)).toBeDefined()
      await expect(guarded(`${baseUrl}/chat/completions`, init)).rejects.toThrow('可能发送'); expect(first).toBe(1)
    } finally { server.stop(true) }
  }
})
