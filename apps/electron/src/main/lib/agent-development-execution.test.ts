import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMessage, AgentSendInput } from '@gravitas/shared'
import type { HeadlessAgentRunCallbacks } from './agent-headless-runner-registry'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-execution-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))
const store = await import('./project-sqlite-store')
const service = await import('./agent-employee-service')
const { createAgentWorkspace, getAgentWorkspaceCwd } = await import('./agent-workspace-manager')
const { getAgentSessionMeta, appendAgentMessage, appendSDKMessages, updateAgentSessionMeta } = await import('./agent-session-manager')
const { createChannel } = await import('./channel-manager')
const { setAgentStopper, setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')

let lastRun: { input: AgentSendInput; callbacks: HeadlessAgentRunCallbacks } | undefined
let acceptStopRequest = true
let confirmProcessTerminated = true
beforeAll(async () => {
  await store.initProjectDb()
  setHeadlessAgentRunner(async (input, callbacks) => { lastRun = { input, callbacks } })
  setAgentStopper((sessionId, expectedGeneration) => ({
    sessionId,
    expectedGeneration,
    activeGeneration: expectedGeneration,
    requestAccepted: acceptStopRequest,
    stopped: acceptStopRequest && confirmProcessTerminated,
    reason: acceptStopRequest ? 'stop-request-accepted' : 'stop-failed',
    processTermination: acceptStopRequest && confirmProcessTerminated ? 'VERIFIED' : 'NOT_VERIFIED',
  }))
})
afterAll(() => {
  service.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})
function message(content: string): AgentMessage {
  return { id: randomUUID(), role: 'assistant', content, createdAt: Date.now() }
}
function fixture() {
  const repo = join(directory, randomUUID()); mkdirSync(repo)
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'source.ts'), 'original'); git('add', '.'); git('commit', '-m', 'baseline')
  const workspace = createAgentWorkspace(`研发测试-${randomUUID()}`, repo)
  const channel = createChannel({ name: '隔离测试渠道', provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = service.createAgentEmployee({ name: '研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi', skills: ['find-skills'] })
  const project = store.createProject({ title: 'Gravitas', description: '保留兼容' })
  const task = store.createTask(project.id, { title: '修复小问题', description: '补充测试', assignee: { userId: `agent-${employee.id}`, displayName: employee.name } })
  return { repo, workspace, employee, project, task }
}
async function dispatch(task: ReturnType<typeof store.createTask>) {
  lastRun = undefined
  const result = await service.dispatchTaskToAgent(task)
  expect(result).not.toBeNull()
  const execution = store.getAgentExecution(result!.taskId)!
  return { execution, run: lastRun! }
}

describe('研发员工既有链路兼容', () => {
  test('Given 研发配置 When 派发与返工 Then 继承范围权限且保留原代码和会话', async () => {
    const { task, workspace, repo, employee } = fixture()
    const { execution, run } = await dispatch(task)
    expect(run.input.permissionModeOverride).toBe('auto')
    expect(run.input.agentRuntime).toBe('pi')
    expect(run.input.userMessage).toContain('本次执行基线')
    expect(run.input.userMessage).toContain('employee/')
    expect(run.input.mentionedSkills).toEqual(['find-skills'])
    expect(getAgentSessionMeta(execution.sessionId)).toMatchObject({ projectId: task.projectId, knowledgeScopeMode: 'project', delegationDepth: 1 })
    const cwd = getAgentWorkspaceCwd(workspace, execution.sessionId)
    expect(cwd).not.toBe(repo)
    writeFileSync(join(cwd, 'source.ts'), 'first change')
    const output = message('已修改文件，测试退出码 0；待验收。')
    appendAgentMessage(execution.sessionId, output)
    run.callbacks.onComplete([output])
    await Promise.resolve()
    expect(store.getTask(task.id)?.status).toBe('paused')
    expect(store.getTask(task.id)?.completedAt).toBeUndefined()
    expect(store.getAgentExecution(execution.id)?.status).toBe('completed')
    const evidencePath = store.getAgentExecution(execution.id)!.outputFiles![1]!
    expect(JSON.parse(readFileSync(evidencePath, 'utf8'))).toMatchObject({ testVerification: 'not-verified', cwd })
    expect(store.getAgentExecution(execution.id)?.resultSummary).toContain('source.ts')
    expect(readFileSync(join(repo, 'source.ts'), 'utf8')).toBe('original')
    store.updateTask(task.id, { status: 'pending', completionNotes: '请补充边界测试' })
    const retry = await dispatch(store.getTask(task.id)!)
    expect(retry.execution.sessionId).toBe(execution.sessionId)
    expect(retry.run.input.userMessage).toContain('请补充边界测试')
    expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe('first change')
    // 只有历史回答不得伪装为本轮新成果。
    retry.run.callbacks.onComplete([output])
    expect(store.getAgentExecution(retry.execution.id)?.status).toBe('failed')
    expect(store.getAgentEmployee(employee.id)?.completedTasks).toBe(1)
  })
  test('Given 用户停止运行中执行 When 调用取消 Then Runtime 被停止且任务回退 paused', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    service.cancelAgentExecution(execution.id)
    expect(store.getAgentExecution(execution.id)).toMatchObject({ status: 'cancelled', error: '用户已停止执行，未交付' })
    expect(store.getTask(task.id)?.status).toBe('paused')
    run.callbacks.onComplete([message('迟到结果')])
    expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
  })

  test('Given Runtime 只确认接受请求 When 调用取消 Then 等待完成回调再标 cancelled', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    confirmProcessTerminated = false
    try {
      expect(service.cancelAgentExecution(execution.id)).toMatchObject({
        status: 'running',
        stopped: false,
        stopRequested: true,
        processTermination: 'NOT_VERIFIED',
      })
      expect(store.getAgentExecution(execution.id)?.status).toBe('running')
      run.callbacks.onComplete([], { stoppedByUser: true })
      expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
    } finally {
      confirmProcessTerminated = true
    }
  })

  test('Given Runtime 未确认停止 When 调用取消 Then 不伪造 cancelled', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    const taskStatusBeforeStop = store.getTask(task.id)?.status
    acceptStopRequest = false
    try {
      expect(() => service.cancelAgentExecution(execution.id)).toThrow('未能确认目标执行')
      expect(store.getAgentExecution(execution.id)?.status).toBe('running')
      expect(store.getTask(task.id)?.status).toBe(taskStatusBeforeStop)
    } finally {
      acceptStopRequest = true
      run.callbacks.onComplete([], { stoppedByUser: true })
    }
  })

  test('Given 已完成执行 When 调用取消 Then 拒绝改变交付状态', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    run.callbacks.onComplete([message('已完成')])
    expect(() => service.cancelAgentExecution(execution.id)).toThrow('仅能停止')
    expect(store.getAgentExecution(execution.id)?.status).toBe('completed')
  })

  test('Given 用户停止 When 回调 Then 取消而非成功', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    run.callbacks.onComplete([message('部分完成')], { stoppedByUser: true })
    expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
    expect(store.getTask(task.id)?.status).toBe('paused')
    run.callbacks.onComplete([message('迟到结果')])
    expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
  })
  test('Given 运行中改派 When 旧运行交付 Then 不覆盖新负责人和状态', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    store.updateTask(task.id, { assignee: { userId: 'local-user', displayName: '用户' } })
    run.callbacks.onComplete([message('已修改并测试')])
    expect(store.getAgentExecution(execution.id)?.status).toBe('completed')
    expect(store.getTask(task.id)?.status).toBe('pending')
    expect(store.getTask(task.id)?.completionNotes).toBeUndefined()
  })
  test('Given 自定义可执行状态 When 指派 Then 按语义组派发且不重复执行', async () => {
    const { task, project } = fixture()
    const status = store.createTaskStatus(project.id, { name: '开发中', stateGroup: 'started' })
    store.updateTask(task.id, { status: status.id })
    const { run } = await dispatch(store.getTask(task.id)!)
    expect(await service.dispatchTaskToAgent(store.getTask(task.id)!)).toBeNull()
    run.callbacks.onComplete([], { stoppedByUser: true })
  })
  test('Given 研发提示 When 构建执行上下文 Then 明确禁止修改受保护目录', () => {
    const { task, employee } = fixture()
    expect(service.buildAgentTaskPrompt(task, employee)).toContain('禁止修改 `.context/**`、任何 `AGENTS.md`')
  })

  test('Given 脏仓库 When 派发 Then 保留失败记录，不调用模型', async () => {
    const { task, repo } = fixture()
    writeFileSync(join(repo, 'source.ts'), 'work in progress')
    const { execution, run } = await dispatch(task)
    expect(run).toBeUndefined()
    expect(execution.status).toBe('failed')
    expect(execution.error).toContain('未提交')
  })
  test('Given 真实 SDK 消息 When 首次交付与返工 Then 按 uuid 提取本轮结果', async () => {
    const { task } = fixture()
    const first = await dispatch(task)
    const sdk = (uuid: string, text: string) => ({ type: 'assistant' as const, uuid, session_id: first.execution.sessionId, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text }] } })
    const old = sdk(randomUUID(), '第一次修改完成')
    appendSDKMessages(first.execution.sessionId, [old])
    // 真实编排层目前用此类型断言向回调传递 SDKMessage[]。
    first.run.callbacks.onComplete([old] as unknown as AgentMessage[])
    expect(store.getAgentExecution(first.execution.id)?.status).toBe('completed')
    store.updateTask(task.id, { status: 'pending' })
    const second = await dispatch(store.getTask(task.id)!)
    second.run.callbacks.onComplete([old, sdk(randomUUID(), '本轮已补测试')] as unknown as AgentMessage[])
    expect(store.getAgentExecution(second.execution.id)?.status).toBe('completed')
    expect(store.getAgentExecution(second.execution.id)?.resultSummary).toContain('本轮已补测试')
    expect(store.getAgentExecution(second.execution.id)?.resultSummary).not.toContain('第一次修改完成')
  })
  test('Given Runtime 未返回停止字段 When 存在真实停止标记 Then 不交付', async () => {
    const { task } = fixture()
    const { execution, run } = await dispatch(task)
    updateAgentSessionMeta(execution.sessionId, { stoppedByUser: true })
    run.callbacks.onComplete([message('部分成果')])
    expect(store.getAgentExecution(execution.id)?.status).toBe('cancelled')
  })
  test('Given 已改派 When 旧员工报告卡点 Then 不覆盖新任务', async () => {
    const { task } = fixture()
    const { run } = await dispatch(task)
    store.updateTask(task.id, { assignee: { userId: 'local-user', displayName: '用户' }, completionNotes: '人工说明' })
    run.callbacks.onComplete([message('权限不足，无法完成')])
    expect(store.getTask(task.id)).toMatchObject({ status: 'pending', completionNotes: '人工说明' })
  })
  test('Given 旧员工排队期间改派 When 新负责人派发 Then 取消旧队列且启动新员工', async () => {
    const { task, employee } = fixture()
    const previous = store.createAgentEmployee({ name: '之前的员工', role: '通用', description: '', channelId: 'old' })
    const oldId = randomUUID()
    store.createAgentExecution({ id: oldId, projectId: task.projectId, entityType: 'task', entityId: task.id, agentId: previous.id, sessionId: '', status: 'queued', prompt: '' })
    expect(await service.dispatchTaskToAgentIfIdle(task)).not.toBeNull()
    expect(store.getAgentExecution(oldId)?.status).toBe('cancelled')
    const active = store.listAgentExecutionsByEntity('task', task.id).find((run) => run.status === 'running')!
    expect(active.agentId).toBe(employee.id)
    lastRun!.callbacks.onComplete([], { stoppedByUser: true })
  })
  test('Given 普通员工 When 重开数据库 Then 缺省兼容，研发配置保持', async () => {
    const { employee } = fixture()
    const legacy = store.createAgentEmployee({ name: '旧员工', role: '文档', description: '', channelId: 'old' })
    store.closeProjectDb(); await store.initProjectDb()
    expect(store.getAgentEmployee(legacy.id)).toMatchObject({ executionProfile: 'general', permissionMode: 'safe' })
    expect(store.getAgentEmployee(employee.id)).toMatchObject({ executionProfile: 'development', permissionMode: 'auto' })
    expect(() => service.updateAgentEmployee(employee.id, { workspaceId: undefined })).toThrow('工作区')
  })
})
