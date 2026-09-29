import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePilotApproval } from './project-pilot-approval'
import { startPilotBackgroundReconcile } from './project-pilot-background-reconcile'
import { getCurrentPilotIntents } from './project-pilot-intent-store'
import { projectPilotDispatchTesting } from './project-pilot-dispatch'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { getWorkflowIdentityDirectory, saveWorkflowIdentityDirectory } from './workflow-identity-service'
import { updateProjectChain, updateProjectChainAsActor } from './project-chain-service'
import {
  closeProjectDb,
  createAgentEmployee,
  createProject,
  createTask,
  createTaskDependency,
  getAgentExecution,
  getProjectDb,
  getTask,
  initProjectDb,
  updateAgentExecution,
  updateTask,
} from './project-sqlite-store'
import { updateTask as updateTaskWithEvents } from './project-service'

// 端到端事件链路验证（A01/A02/A04 交汇）：绑定核验与 Runtime 启动语义分别由 readiness/控制面/研发执行
// 专项测试覆盖；此处经后台依赖注入固定「绑定就绪 + 启动成功」，聚焦「页面未挂载时事实事件 →
// 后台对账 → 受控命令派发」的完整推进链。注入而非 mock.module：mock 是进程级共享，会泄漏到并发文件。
const backgroundDependencies = {
  inspectReadiness: (projectId: string) => ({ projectId, policyRevision: 1, bindingsValid: true, blockers: [] }),
  startExecution: async () => true,
  inspectGrantStatus: () => 'active',
}

const directory = mkdtempSync(join(tmpdir(), 'pilot-bg-e2e-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
  await initProjectDb()
  // 交付责任人须为身份目录中已启用的人类用户（同交付服务测试前置）
  const dir = getWorkflowIdentityDirectory()
  if (!dir.users.some((user) => user.id === 'reviewer-1')) {
    saveWorkflowIdentityDirectory({ ...dir, users: [...dir.users, { id: 'reviewer-1', displayName: '验收人一', roleIds: [], enabled: true }] })
  }
})
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

function e2eFixture(title: string) {
  const executor = createAgentEmployee({
    name: `${title} 执行`, role: '工程师', description: '', channelId: 'channel-e2e', modelId: 'model-e2e',
    workspaceId: 'workspace-e2e', workspaceIds: ['workspace-e2e'], runtime: 'ai-sdk', executionProfile: 'development',
  })
  const reviewer = createAgentEmployee({
    name: `${title} 评审`, role: '技术评审', description: '', channelId: 'channel-e2e', modelId: 'model-e2e',
    workspaceId: 'workspace-e2e', workspaceIds: ['workspace-e2e'], runtime: 'ai-sdk', executionProfile: 'development',
  })
  const project = createProject({ title, description: '' })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({
    grantId, projectId: project.id, workspaceId: 'workspace-e2e', channelId: 'channel-e2e', modelId: 'model-e2e',
    executorEmployeeId: executor.id, reviewerEmployeeId: reviewer.id,
    maxCostMicros: 3_000, maxRuns: 3, maxRework: 1, expiresAt: now + 100_000, createdAt: now,
  })
  return { project, executor, reviewer, grantId, now }
}

/** 轮询等待后台对账产出预期事实（非 mount：无任何渲染层调用）。 */
async function waitFor(predicate: () => boolean, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true
    await Bun.sleep(20)
  }
  return predicate()
}

test('Given 活动授权 When 页面未挂载且依赖解除事件到达 Then 后台自动派发下游执行命令', async () => {
  const { project, executor } = e2eFixture('依赖解除端到端')
  const upstream = createTask(project.id, { title: '上游依赖', description: '' })
  const downstream = createTask(project.id, {
    title: '下游执行', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${executor.id}`, displayName: executor.name },
  })
  createTaskDependency(downstream.id, upstream.id)
  // 先对账固化 waiting_dependency 快照
  await getCurrentPilotIntents(project.id)

  const stop = startPilotBackgroundReconcile(backgroundDependencies)
  try {
    await updateTaskWithEvents(upstream.id, { status: 'completed' }, { source: 'system' })
    const dispatched = await waitFor(() => (getProjectDb()
      .prepare(`SELECT count(*) AS n FROM pilot_commands WHERE project_id = ? AND source_task_id = ? AND state = 'queued'`)
        .get(project.id, downstream.id) as { n: number } | undefined)?.n === 1)
    expect(dispatched).toBe(true)
    const execution = getProjectDb().prepare(`SELECT execution_id FROM pilot_commands
      WHERE project_id = ? AND source_task_id = ?`).get(project.id, downstream.id) as { execution_id: string }
    expect(getAgentExecution(execution.execution_id)).toMatchObject({
      projectId: project.id, entityId: downstream.id, agentId: executor.id, status: 'queued',
    })
  } finally {
    stop()
  }
})

test('Given 两项并行和一项依赖 When 后台无页面扫描及上游完成事件 Then 先派两项再派下游（A02）', async () => {
  const base = e2eFixture('并行依赖端到端')
  const upstream = createTask(base.project.id, {
    title: '并行上游', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  const independent = createTask(base.project.id, {
    title: '独立并行', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  const downstream = createTask(base.project.id, {
    title: '下游依赖', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  createTaskDependency(downstream.id, upstream.id)
  const stop = startPilotBackgroundReconcile(backgroundDependencies)
  try {
    expect(await waitFor(() => (getProjectDb().prepare(`SELECT count(*) AS n FROM pilot_commands
      WHERE project_id = ?`).get(base.project.id) as { n: number }).n === 2)).toBe(true)
    expect(getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?').get(downstream.id))
      .toEqual({ n: 0 })
    const commands = getProjectDb().prepare('SELECT source_task_id FROM pilot_commands WHERE project_id = ?')
      .all(base.project.id) as Array<{ source_task_id: string }>
    expect(new Set(commands.map((row) => row.source_task_id))).toEqual(new Set([upstream.id, independent.id]))
    await updateTaskWithEvents(upstream.id, { status: 'completed' }, { source: 'system' })
    expect(await waitFor(() => (getProjectDb().prepare(`SELECT count(*) AS n FROM pilot_commands
      WHERE source_task_id = ?`).get(downstream.id) as { n: number }).n === 1)).toBe(true)
  } finally {
    stop()
  }
})

test('Given 执行完成且主动询问 When 页面未挂载时人工批准 Then 后台自动续跑新命令', async () => {
  const base = e2eFixture('审批续跑端到端')
  const task = createTask(base.project.id, {
    title: '待授权变更', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  // 首轮命令入账并模拟完成回调后的权威事实（命令 settled、执行 completed、任务 paused 携带询问标记）
  const readyIntent = (await getCurrentPilotIntents(base.project.id)).find((item) => item.sourceId === task.id)!
  const first = await projectPilotDispatchTesting.dispatch(base.project.id, readyIntent.id, {
    inspectReadiness: backgroundDependencies.inspectReadiness,
    startExecution: async () => false,
  }, base.now)
  getProjectDb().prepare(`UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 40 WHERE id = ?`).run(first!.commandId)
  const summary = '【需要人工：权限】需要生产库只读授权'
  updateAgentExecution(first!.executionId, { status: 'completed', completedAt: base.now + 1, resultSummary: summary })
  updateTask(task.id, { status: 'paused', completionNotes: summary })
  await getCurrentPilotIntents(base.project.id)

  const stop = startPilotBackgroundReconcile(backgroundDependencies)
  try {
    // 人工批准走审批入口（内部带任务事件），后台自动把任务事实转成续跑命令
    await resolvePilotApproval(base.project.id, task.id, 'approved', { sourceVersion: getTask(task.id)!.updatedAt, note: '已开通只读授权' })
    const resumed = await waitFor(() => {
      const commands = getProjectDb().prepare(`SELECT id, state FROM pilot_commands
        WHERE project_id = ? AND source_task_id = ? ORDER BY created_at ASC`).all(base.project.id, task.id) as Array<{ id: string, state: string }>
      return commands.length === 2 && commands[1]!.state === 'queued'
    })
    expect(resumed).toBe(true)
    const commands = getProjectDb().prepare(`SELECT id FROM pilot_commands
      WHERE project_id = ? AND source_task_id = ? ORDER BY created_at ASC`).all(base.project.id, task.id) as Array<{ id: string }>
    expect(commands[1]!.id).not.toBe(first!.commandId)
  } finally {
    stop()
  }
})

test('Given 审批已提交但即时事件丢失 When 重开数据库且后台启动扫描 Then 仅派一条续跑命令', async () => {
  const base = e2eFixture('审批事件丢失后重启')
  const task = createTask(base.project.id, {
    title: '等待答复后续跑', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  const readyIntent = (await getCurrentPilotIntents(base.project.id)).find((item) => item.sourceId === task.id)!
  const first = await projectPilotDispatchTesting.dispatch(base.project.id, readyIntent.id, {
    inspectReadiness: backgroundDependencies.inspectReadiness,
    startExecution: async () => false,
  }, base.now)
  getProjectDb().prepare(`UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 40 WHERE id = ?`).run(first!.commandId)
  const summary = '【需要人工：决策】确认执行范围'
  updateAgentExecution(first!.executionId, { status: 'completed', completedAt: base.now + 1, resultSummary: summary })
  updateTask(task.id, { status: 'paused', completionNotes: summary })
  const version = getTask(task.id)!.updatedAt
  // 未启动后台订阅：审批提交后的即时事件没有消费者；活动记录后置链不作为续跑事实。
  await resolvePilotApproval(base.project.id, task.id, 'approved', { sourceVersion: version, note: '范围已确认' })
  expect((getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
    .get(task.id) as { n: number }).n).toBe(1)
  closeProjectDb()
  await initProjectDb()
  let starts = 0
  const stop = startPilotBackgroundReconcile({ ...backgroundDependencies,
    startExecution: async () => { starts++; return false },
  })
  try {
    const resumed = await waitFor(() => (getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { n: number }).n === 2)
    expect(resumed).toBe(true)
    const commands = getProjectDb().prepare('SELECT state, execution_id FROM pilot_commands WHERE source_task_id = ?')
      .all(task.id) as Array<{ state: string; execution_id: string }>
    expect(commands.map((item) => item.state).sort()).toEqual(['queued', 'settled'])
    const continuation = commands.find((item) => item.state === 'queued')
    expect(continuation?.execution_id).not.toBe(first!.executionId)
    expect(getAgentExecution(continuation!.execution_id)).toMatchObject({
      projectId: base.project.id, entityId: task.id, agentId: base.executor.id, status: 'queued',
    })
    expect(starts).toBe(1)
    // 周期/重复对账不得再次占额或创建第三条命令。
    await getCurrentPilotIntents(base.project.id)
    expect((getProjectDb().prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
      .get(task.id) as { n: number }).n).toBe(2)
  } finally {
    stop()
  }
})

test('Given 交付提交 When 页面未挂载 Then 后台自动派发同任务评审命令（A03 环路事件入口）', async () => {
  const base = e2eFixture('交付评审端到端')
  const task = createTask(base.project.id, {
    title: '待评审交付', description: '', workspaceId: 'workspace-e2e',
    assignee: { userId: `agent-${base.executor.id}`, displayName: base.executor.name },
  })
  const readyIntent = (await getCurrentPilotIntents(base.project.id)).find((item) => item.sourceId === task.id)!
  const first = await projectPilotDispatchTesting.dispatch(base.project.id, readyIntent.id, {
    inspectReadiness: backgroundDependencies.inspectReadiness,
    startExecution: async () => false,
  }, base.now)
  getProjectDb().prepare(`UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 40 WHERE id = ?`).run(first!.commandId)
  updateAgentExecution(first!.executionId, { status: 'completed', completedAt: base.now + 1 })
  updateTask(task.id, { status: 'paused', completionNotes: '【AI 交付待确认】已修复并验证' })
  const withDecision = updateProjectChain(base.project.id, 0, { kind: 'decision', title: '修复方向', rationale: '最小增量', evidence: 'issue#1' })
  const owner = `agent-${base.executor.id}`
  const withDraft = updateProjectChainAsActor(base.project.id, withDecision.revision, {
    kind: 'draft', taskId: task.id, title: '修复交付', content: '修复说明', criteria: '测试通过',
    recipient: 'reviewer-1', decisionIds: [withDecision.decisions[0]!.id], executionId: first!.executionId,
    responsibilities: { ownerId: owner, reviewerId: 'reviewer-1', recipientId: 'reviewer-1' },
  }, owner)

  const stop = startPilotBackgroundReconcile(backgroundDependencies)
  try {
    // 交付提交事件（页面未挂载）→ 后台对账 → 同任务评审命令自动派发
    updateProjectChainAsActor(base.project.id, withDraft.revision, { kind: 'submit', draftId: withDraft.drafts[0]!.id }, owner)
    const reviewed = await waitFor(() => (getProjectDb()
      .prepare(`SELECT count(*) AS n FROM pilot_commands WHERE project_id = ? AND role = 'reviewer' AND state = 'queued'`)
        .get(base.project.id) as { n: number } | undefined)?.n === 1)
    expect(reviewed).toBe(true)
  } finally {
    stop()
  }
})
