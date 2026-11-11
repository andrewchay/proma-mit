/**
 * 缺陷 7+8 的端到端验收：上一条响应未通过协议解析后，用户的新消息必须恰好到达上游一次。
 *
 * 独立成文件是为了避免与 delegation 主套件共用全局并发闸门（上限 5）——
 * 前序用例留下的执行会让本用例长期排队，从而误判为产品缺陷。
 */
import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-carryover-'))
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
const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
const { resolveOwnerPlanningSession } = await import('./project-owner-planning-source')
const { claimOwnerPlanningProviderRequest } = await import('./project-owner-planning-provider')
const { startDelegatedOwnerPlanningTask } = await import('./controlled-project-task-service')
const delegationService = await import('./project-owner-management-delegation')
const managementStore = await import('./project-owner-management-store')
const { getOwnerManagementConversation } = await import('./project-owner-management-questions')
const { reconcileOwnerManagement, startOwnerManagementLoop } = await import('./project-owner-management-loop')
const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')

const callbacks = new Map<string, HeadlessAgentRunCallbacks>()
/** 统计真正打到上游的请求次数；本文件只关心「恰好一次」。 */
let calls = 0

beforeAll(async () => {
  await store.initProjectDb()
  setHeadlessAgentRunner(async (input, handlers) => {
    calls++
    const source = resolveOwnerPlanningSession(input.sessionId)!
    const body = JSON.stringify({ model: source.binding.modelId, stream: true, max_tokens: source.link.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: source.request.systemPrompt }, { role: 'user', content: source.request.userPrompt }] })
    claimOwnerPlanningProviderRequest(input.sessionId, body, new URL('https://example.invalid/v1/chat/completions'))
    callbacks.set(input.sessionId, handlers)
  })
})

afterAll(() => {
  employees.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const project = store.createProject({ title: '接续验收', description: '' })
  const workspace = createAgentWorkspace(`接续-${randomUUID()}`)
  bindWorkspaceToProject(project.id, workspace.id)
  const channel = createChannel({ name: 'fake', provider: 'openai', baseUrl: 'https://example.invalid/v1', apiKey: 'fake', enabled: true, models: [{ id: 'deepseek-flash', name: 'deepseek-flash', enabled: true }] })
  const employee = employees.createAgentEmployee({ name: 'Owner', role: '规划', description: '', executionProfile: 'controlled', permissionMode: 'safe', runtime: 'ai-sdk', channelId: channel.id, modelId: 'deepseek-flash', workspaceIds: [workspace.id] })
  saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成产品定位建议', constraints: [] })
  saveOwnerRuntimeBinding(project.id, 0, { ownerName: 'Owner', carrierId: employee.id, workspaceId: workspace.id, changeReason: '隔离测试' })
  reconcileOwnerManagement(project.id)
  const taskId = getOwnerManagementConversation(project.id).messages.findLast(item => item.planningTaskId)?.planningTaskId!
  return { project, workspace, employee, taskId }
}

async function until(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error('等待后台行为超时')
}

test('Given 上条响应未通过协议解析且仍在预算内 When 用户发送新消息 Then 恰好向上游发送一次且旧记录不变', async () => {
  const f = fixture()
  const preview = delegationService.previewOwnerManagementDelegation({ projectId: f.project.id, requestId: randomUUID(), maxRequests: 3, maxCostMicros: 20_000_000, expiresAt: Date.now() + 3_600_000 })
  const grant = delegationService.confirmOwnerManagementDelegation({ input: { projectId: f.project.id, requestId: preview.requestId, maxRequests: 3, maxCostMicros: 20_000_000, expiresAt: preview.expiresAt }, previewHash: preview.previewHash })
  const stop = startOwnerManagementLoop()
  try {
    await startDelegatedOwnerPlanningTask(f.taskId)
    const first = store.listAgentExecutionsByEntity('task', f.taskId)[0]!
    await until(() => callbacks.has(first.sessionId!))
    // 真实故障形态：步骤字段名带多余字符，协议解析必然失败。
    callbacks.get(first.sessionId!)!.onComplete([], { runtimeResult: {
      type: 'result', subtype: 'success', session_id: first.sessionId!, finish_reason: 'stop',
      result: '{"schemaVersion":1,"kind":"plan_proposal","proposal":{"steps":[{"acceptanceCriteria ["broken"]}]}}',
      usage: { input_tokens: 100, output_tokens: 20 },
      owner_planning_usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: null, cacheWriteTokens: null },
    } })
    // 解析失败被显式标记；委托据此保持可接续，而不是永久 attention。
    const runs = await import('./project-owner-planning-run-service')
    expect(runs.getOwnerPlanningRunOutcome(first.id)).toMatchObject({ state: 'failed', protocolRejected: true })
    expect(delegationService.getOwnerManagementDelegation(f.project.id)).toMatchObject({ state: 'active' })
    const before = calls
    const { sendOwnerManagementMessage } = await import('./project-owner-management-conversation')
    sendOwnerManagementMessage({ projectId: f.project.id, conversationId: managementStore.getOwnerManager(f.project.id)!.conversationId, requestId: randomUUID(), expectedGoalRevision: 1, content: '继续按新要求推进' })
    // 新消息必须真正到达上游，且只到达一次。
    await until(() => calls > before)
    expect(calls - before).toBe(1)
    // 旧失败记录保留原文与预留，不被重试或补造用量。
    expect(runs.getOwnerPlanningRunOutcome(first.id)).toMatchObject({ state: 'failed', protocolRejected: true })
    expect(store.getAgentExecution(first.id)?.status).toBe('failed')
  } finally {
    await stop()
    delegationService.revokeOwnerManagementDelegation(f.project.id, grant.id)
  }
}, 30_000)
