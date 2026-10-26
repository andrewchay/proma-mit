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
const { getProjectOwnerPlanningContext } = await import('./project-owner-plan-service')
const service = await import('./project-owner-runtime-binding')
const source = await import('./project-owner-planning-source')
const { assertOwnerPlanningPayload } = await import('./project-owner-planning-provider')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { employees.stopAgentEmployeeHeartbeat(); store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  const project = store.createProject({ title: 'Owner定位', description: '' })
  const workspace = createAgentWorkspace(`Owner-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: '假渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'fake', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: '执行载体', role: '研究', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'model', workspaceIds: [workspace.id] })
  const binding = { ownerName: '项目Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '明确绑定既有载体' }
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '提出可评审的定位建议' })
  return { project, employee, workspace, binding }
}
function request(projectId: string, bindingRevision = 1) { const context = getProjectOwnerPlanningContext(projectId); return { requestId: randomUUID(), expectedBindingRevision: bindingRevision, expectedGoalRevision: context.goal.revision, expectedPlanRevision: 0, expectedContextFingerprint: context.fingerprint } }
function prepared() { const f = fixture(); service.saveOwnerRuntimeBinding(f.project.id, 0, f.binding); const link = service.prepareOwnerPlanning(f.project.id, request(f.project.id)); return { ...f, link } }
function running(f: ReturnType<typeof prepared>) {
  const sessionId = randomUUID(), executionId = randomUUID()
  store.createAgentExecution({ id: executionId, projectId: f.project.id, entityType: 'task', entityId: f.link.planningTaskId, agentId: f.employee.id, sessionId, status: 'running', prompt: '不能信任此角色原文' })
  store.getProjectDb().prepare('UPDATE controlled_task_preparations SET execution_id = ? WHERE task_id = ?').run(executionId, f.link.planningTaskId)
  return { executionId, sessionId }
}
function scope() { const f = prepared(); const run = running(f); return source.resolveOwnerPlanningSession(run.sessionId)! }
test('Given SDK三种协议 When 固定system/user及4096单流式请求 Then 可验证实际payload', () => {
  const s = scope(), { systemPrompt: system, userPrompt: user } = s.request
  expect(() => assertOwnerPlanningPayload(s, { model: 'model', stream: true, max_tokens: 4096, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream_options: { include_usage: true } }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(s, { model: 'model', stream: true, max_tokens: 4096, system: [{ type: 'text', text: system }], messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }, 'anthropic-messages', new URL('https://example.invalid/v1/messages'))).not.toThrow()
  expect(() => assertOwnerPlanningPayload(s, { generationConfig: { maxOutputTokens: 4096 }, systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }, 'google-generative', new URL('https://example.invalid/v1beta/models/model:streamGenerateContent'))).not.toThrow()
})
test('Given OpenAI夹带工具/资料/隐藏参数/错误输出限制或出口 When 最终body检查 Then 全拒绝', () => {
  const s = scope(); const base = { model: 'model', stream: true, max_tokens: 4096, messages: [{ role: 'system', content: s.request.systemPrompt }, { role: 'user', content: s.request.userPrompt }] }
  for (const patch of [{ model: 'other' }, { max_tokens: 8192 }, { max_tokens: undefined }, { max_completion_tokens: 8000 }, { tools: [{ name: 'Bash' }] }, { tool_choice: 'auto' }, { parallel_tool_calls: true }, { temperature: 1 }, { messages: [...base.messages, { role: 'user', content: '隐藏历史' }] }, { messages: [{ role: 'system', content: 'override' }, base.messages[1]] }, { messages: [base.messages[0], { role: 'user', content: [{ type: 'image_url', image_url: { url: 'private' } }] }] }, { stream_options: { include_usage: false } }]) expect(() => assertOwnerPlanningPayload(s, { ...base, ...patch }, 'openai-chat', new URL('https://example.invalid/v1/chat/completions'))).toThrow()
  expect(() => assertOwnerPlanningPayload(s, base, 'openai-chat', new URL('https://example.invalid/v1/embeddings'))).toThrow('出口')
})
test('Given Google/Anthropic请求含历史、非文字、工具或无4096 When 实际body检查 Then 拒绝', () => {
  const s = scope(); const google = { generationConfig: { maxOutputTokens: 4096 }, systemInstruction: { parts: [{ text: s.request.systemPrompt }] }, contents: [{ role: 'user', parts: [{ text: s.request.userPrompt }] }] }
  for (const patch of [{ tools: [] }, { toolConfig: {} }, { generationConfig: { maxOutputTokens: 8192 } }, { contents: [] }, { contents: [{ role: 'user', parts: [{ inlineData: 'private' }] }] }]) expect(() => assertOwnerPlanningPayload(s, { ...google, ...patch }, 'google-generative', new URL('https://example.invalid/models/model:streamGenerateContent'))).toThrow()
  const anthropic = { model: 'model', stream: true, max_tokens: 4096, system: s.request.systemPrompt, messages: [{ role: 'user', content: s.request.userPrompt }] }
  for (const patch of [{ thinking: { type: 'enabled', budget_tokens: 5000 } }, { max_tokens: 8192 }, { messages: [] }, { messages: [{ role: 'user', content: [{ type: 'document', text: 'private' }] }] }]) expect(() => assertOwnerPlanningPayload(s, { ...anthropic, ...patch }, 'anthropic-messages', new URL('https://example.invalid/messages'))).toThrow()
})
