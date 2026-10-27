import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-provider-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const employees = await import('./agent-employee-service')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createChannel } = await import('./channel-manager')
const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
const { getProjectOwnerPlanningContext, saveProjectOwnerPlanDraft, confirmProjectOwnerPlanDraft } = await import('./project-owner-plan-service')
const assignmentService = await import('./project-owner-execution-assignment-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')
const { assertOwnerPlanningPayload } = await import('./project-owner-planning-provider')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }, { id: 'deepseek-flash', name: '审核价格的员工模型', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function prepared() { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); return { ...f, link } }
function running(f: { project: { id: string }; employee: { id: string }; link: { planningTaskId: string } }) {
  const sessionId = randomUUID(), executionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId, status: 'running', prompt: '不能信任此角色原文' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  return { executionId, sessionId }
}
function scope() { const f = prepared(); const run = running(f); return source.resolveOwnerPlanningSession(run.sessionId)! }
function preparedAssignment() {
  const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding)
  const context = getProjectOwnerPlanningContext(f.project.id), roleKey = context.sources.roles[0]?.key
  if (!roleKey) throw new Error('测试上下文缺少岗位')
  employees.createAgentEmployee({ name: '执行员工', role: '研究', roleTemplateId: roleKey, description: '研究', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.employee.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  employees.createAgentEmployee({ name: '评审员工', role: '评审', roleTemplateId: 'reviewer', description: '核验', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: f.employee.channelId, modelId: 'deepseek-flash', workspaceIds: [f.workspace.id] })
  const draft = saveProjectOwnerPlanDraft(f.project.id, context.goal.revision, 0, { expectedContextFingerprint: context.fingerprint, summary: '研究计划', assumptions: [], risks: [], steps: [{ key: 'research', title: '研究', outcome: '简报', acceptanceCriteria: ['有来源'], dependencies: [], roleKey }], changeReason: '测试计划' })
  const plan = confirmProjectOwnerPlanDraft(f.project.id, context.goal.revision, draft.revision)
  const current = getProjectOwnerPlanningContext(f.project.id)
  const link = assignmentService.prepareOwnerExecutionAssignment({ projectId: f.project.id }, { requestId: randomUUID(), expectedBindingRevision: 1, expectedGoalRevision: current.goal.revision, expectedPlanRevision: plan.revision, expectedPlanFingerprint: plan.planFingerprint, expectedContextFingerprint: current.fingerprint })
  return { ...f, link }
}
test('Given v4 JSON输出 When实际序列化体缺失、错格式或夹带schema Then发送前拒绝；旧协议不追加参数', () => {
  const current = scope(), s = { ...current, binding: { ...current.binding, modelId: 'deepseek-flash' }, link: { ...current.link, protocolVersion: '4' as const } }
  const body = { model: 'deepseek-flash', stream: true, max_tokens: 8192, messages: [{ role: 'system', content: s.request.systemPrompt }, { role: 'user', content: s.request.userPrompt }], response_format: { type: 'json_object' } }
  const url = new URL('https://example.invalid/v1/chat/completions')
  expect(() => assertOwnerPlanningPayload(s, body, 'openai-chat', url)).not.toThrow()
  for (const response_format of [undefined, { type: 'text' }, { type: 'json_schema' }, { type: 'json_object', schema: {} }]) expect(() => assertOwnerPlanningPayload(s, { ...body, response_format }, 'openai-chat', url)).toThrow()
  expect(() => assertOwnerPlanningPayload({ ...s, link: { ...s.link, protocolVersion: '2' } }, body, 'openai-chat', url)).toThrow('旧Owner')
  expect(() => assertOwnerPlanningPayload(s, body, 'anthropic-messages', url)).toThrow('实际模型协议')
})
test('Given 新版Owner规划 When 固定system/user及8192单流式请求 Then 可验证实际payload', () => {
  const s = scope(), { systemPrompt: system, userPrompt: user } = s.request
  expect(() => assertOwnerPlanningPayload(s, { model: 'model', stream: true, max_tokens: 8192, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream_options: { include_usage: true } }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(s, { model: 'model', stream: true, max_tokens: 8192, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }, 'anthropic-messages', new URL('https://example.invalid/v1/messages'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(s, { generationConfig: { maxOutputTokens: 8192 }, systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }, 'google-generative', new URL('https://example.invalid/v1beta/models/model:streamGenerateContent'))).not.toThrow()
})
test('Given GLM-5.3 Owner协议v3 When 实际OpenAI请求缺少冻结low推理参数 Then 拒绝准入', () => {
  const current = scope()
  const glm = { ...current, binding: { ...current.binding, modelId: 'glm-5.3-flash' }, link: { ...current.link, protocolVersion: '3' as const, reasoningEffort: 'low' as const } }
  const body = { model: 'glm-5.3-flash', stream: true, max_tokens: 8192, reasoning_effort: 'low', messages: [{ role: 'system', content: glm.request.systemPrompt }, { role: 'user', content: glm.request.userPrompt }] }
  expect(() => assertOwnerPlanningPayload(glm, body, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(glm, { ...body, reasoning_effort: 'max' }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow('推理强度')
  expect(() => assertOwnerPlanningPayload(glm, { ...body, reasoning_effort: undefined }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow('推理强度')
})
test('Given新版Owner人员安排 When最终OpenAI请求校验 Then接受冻结的8192 token并拒绝旧额度与额外资料', () => {
  const f = preparedAssignment(), run = running(f), s = source.resolveOwnerPlanningSession(run.sessionId)!
  expect(s.link.purpose).toBe('owner_execution_assignment')
  expect(s.link).toMatchObject({ assignmentProtocolVersion: '2', maxOutputTokens: 8192 })
  const body = { model: 'model', stream: true, max_tokens: 8192, messages: [{ role: 'system', content: s.request.systemPrompt }, { role: 'user', content: s.request.userPrompt }] }
  expect(() => assertOwnerPlanningPayload(s, body, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
  for (const patch of [{ max_tokens: 4096 }, { tools: [{ name: 'extra' }] }, { messages: [...body.messages, { role: 'user', content: 'additional context' }] }]) expect(() => assertOwnerPlanningPayload(s, { ...body, ...patch }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow()
})
test('Given历史Owner安排关联缺少新版额度字段 When恢复冻结来源 Then仍按4096 token读取', () => {
  const f = preparedAssignment(), run = running(f), current = source.resolveOwnerPlanningSession(run.sessionId)!
  const row = store.getProjectDb().prepare('SELECT payload FROM project_owner_planning_links WHERE id = ?').get(current.link.id) as { payload: string }
  const legacy = JSON.parse(row.payload) as Record<string, unknown>
  delete legacy.assignmentProtocolVersion
  legacy.maxOutputTokens = 4096
  store.getProjectDb().prepare('UPDATE project_owner_planning_links SET payload = ? WHERE id = ?').run(JSON.stringify(legacy), current.link.id)
  const restored = source.resolveOwnerPlanningSession(run.sessionId)!
  expect(restored.link).toMatchObject({ purpose: 'owner_execution_assignment', maxOutputTokens: 4096 })
  const body = { model: restored.binding.modelId, stream: true, max_tokens: 4096, messages: [{ role: 'system', content: restored.request.systemPrompt }, { role: 'user', content: restored.request.userPrompt }] }
  expect(() => assertOwnerPlanningPayload(restored, body, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
})
test('Given 历史v1规划关联 When 继续验证 Then 仍只接受4096输出限制', () => {
  const current = scope()
  const legacy = { ...current, link: { ...current.link, protocolVersion: '1' as const, maxOutputTokens: 4096 as const } }
  const body = { model: 'model', stream: true, max_tokens: 4096, messages: [{ role: 'system', content: legacy.request.systemPrompt }, { role: 'user', content: legacy.request.userPrompt }] }
  expect(() => assertOwnerPlanningPayload(legacy, body, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(legacy, { ...body, max_tokens: 8192 }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow()
})
test('Given OpenAI夹带工具/资料/隐藏参数/错误输出限制或出口 When 最终body检查 Then 全拒绝', () => {
  const s = scope(); const base = { model: 'model', stream: true, max_tokens: 8192, messages: [{ role: 'system', content: s.request.systemPrompt }, { role: 'user', content: s.request.userPrompt }] }
  for (const patch of [{ model: 'other' }, { max_tokens: 4096 }, { max_tokens: undefined }, { max_completion_tokens: 8000 }, { tools: [{ name: 'Bash' }] }, { tool_choice: 'auto' }, { parallel_tool_calls: true }, { temperature: 1 }, { messages: [...base.messages, { role: 'user', content: '隐藏历史' }] }, { messages: [{ role: 'system', content: 'override' }, base.messages[1]] }, { messages: [base.messages[0], { role: 'user', content: [{ type: 'image_url', image_url: { url: 'private' } }] }] }, { stream_options: { include_usage: false } }]) expect(() => assertOwnerPlanningPayload(s, { ...base, ...patch }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow()
  expect(() => assertOwnerPlanningPayload(s, base, 'openai-chat', new URL('https://example.invalid/v1/embeddings'))).toThrow('出口')
})
test('Given Google/Anthropic请求含历史、非文字、工具或非冻结输出限制 When 实际body检查 Then 拒绝', () => {
  const s = scope(); const google = { generationConfig: { maxOutputTokens: 8192 }, systemInstruction: { parts: [{ text: s.request.systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: s.request.userPrompt }] }] }
  for (const patch of [{ tools: [] }, { toolConfig: {} }, { generationConfig: { maxOutputTokens: 4096 } }, { contents: [] }, { contents: [{ role: 'user', parts: [{ inlineData: 'private' }] }] }]) expect(() => assertOwnerPlanningPayload(s, { ...google, ...patch }, 'google-generative', new URL('https://example.invalid/models/model:streamGenerateContent'))).toThrow()
  const anthropic = { model: 'model', stream: true, max_tokens: 8192, system: s.request.systemPrompt, messages: [{ role: 'user', content: s.request.userPrompt }] }
  for (const patch of [{ thinking: { type: 'enabled', budget_tokens: 5000 } }, { max_tokens: 4096 }, { messages: [] }, { messages: [{ role: 'user', content: [{ type: 'document', text: 'private' }] }] }]) expect(() => assertOwnerPlanningPayload(s, { ...anthropic, ...patch }, 'anthropic-messages', new URL('https://example.invalid/messages'))).toThrow()
})

test('Given GLM JSON协议v5 When实际请求缺少JSON格式或low推理 Then发送前拒绝且旧v3不追加参数', () => {
  const current = scope()
  const source = { ...current, binding: { ...current.binding, modelId: 'glm-5.3-flash' }, link: { ...current.link, protocolVersion: '5' as const, reasoningEffort: 'low' as const } }
  const body = { model: 'glm-5.3-flash', stream: true, max_tokens: 8192, reasoning_effort: 'low', response_format: { type: 'json_object' }, messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }] }
  const url = new URL('https://example.invalid/v1/chat/completions')
  expect(() => assertOwnerPlanningPayload(source, body, 'openai-chat', url)).not.toThrow()
  for (const patch of [{ response_format: undefined }, { response_format: { type: 'text' } }, { reasoning_effort: undefined }, { reasoning_effort: 'max' }]) expect(() => assertOwnerPlanningPayload(source, { ...body, ...patch }, 'openai-chat', url)).toThrow()
  expect(() => assertOwnerPlanningPayload({ ...source, link: { ...source.link, protocolVersion: '3' } }, body, 'openai-chat', url)).toThrow('旧Owner')
  expect(() => assertOwnerPlanningPayload(source, body, 'anthropic-messages', url)).toThrow('实际模型协议')
})
