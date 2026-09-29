import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashPilotTaskSource, reserveAndQueuePilotCommand, reservePilotCommandBudget } from './project-pilot-budget-ledger'
import { confirmPilotGrantPause, confirmPilotGrantPauseAndRequestStops, inspectPilotGrantPauseRecovery, listPilotGrantStopRequests, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentExecution, createProject, createTask, getAgentExecution, getProjectDb,
  initProjectDb, updateAgentExecution } from './project-sqlite-store'

const dir = mkdtempSync(join(tmpdir(), 'pilot-grant-pause-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const project = createProject({ title: '受控暂停', description: '' })
  const grantId = `grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId: 'workspace-a',
    channelId: 'channel-a', modelId: 'model-a', maxCostMicros: 10_000, maxRuns: 4,
    maxRework: 1, expiresAt: now + 100_000, createdAt: now })
  const queue = (ordinal: number) => {
    const task = createTask(project.id, { title: `任务 ${ordinal}`, description: '', workspaceId: 'workspace-a',
      assignee: { userId: 'agent-executor', displayName: '执行员工' } })
    const commandId = `command-${project.id}-${ordinal}`
    const executionId = `execution-${project.id}-${ordinal}`
    const input = { commandId, projectId: project.id, grantId, idempotencyKey: `dispatch-${ordinal}`,
      taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0 }
    reserveAndQueuePilotCommand(input, { executionId, prompt: `执行任务 ${ordinal}` })
    return { input, executionId }
  }
  return { project, grantId, queue }
}

test('用户确认后同事务暂停 grant、取消未启动执行并保留运行项的逐条选择', async () => {
  const { project, grantId, queue } = fixture()
  const queued = queue(1)
  const running = queue(2)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  const ordinary = createAgentExecution({ id: `ordinary-${project.id}`, projectId: project.id,
    entityType: 'task', entityId: queued.input.taskId, agentId: 'executor', sessionId: '', prompt: '普通执行' })
  const impact = previewPilotGrantPauseImpact(grantId)
  expect(impact.queued.map((item) => item.executionId)).toEqual([queued.executionId])
  expect(impact.running.map((item) => item.executionId)).toEqual([running.executionId])
  expect(() => confirmPilotGrantPause(impact, [])).toThrow('逐项选择')
  const choice = [{ executionId: running.executionId, disposition: 'request_stop' as const }]
  const result = confirmPilotGrantPause(impact, choice)
  expect(result.cancelledExecutionIds).toEqual([queued.executionId])
  expect(result.runningChoices).toEqual(choice)
  expect(result.pendingStopExecutionIds).toEqual([running.executionId])
  expect(getAgentExecution(queued.executionId)?.status).toBe('cancelled')
  expect(getAgentExecution(running.executionId)?.status).toBe('running')
  expect(getAgentExecution(ordinary.id)?.status).toBe('queued')
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as { state: string }
  expect(grant.state).toBe('paused')
  const command = getProjectDb().prepare('SELECT state, actual_cost_micros FROM pilot_commands WHERE id = ?')
    .get(queued.input.commandId) as { state: string; actual_cost_micros: number }
  expect(command).toEqual({ state: 'released', actual_cost_micros: 0 })
  expect(() => reservePilotCommandBudget({ ...queued.input, commandId: 'new-command', idempotencyKey: 'new' }))
    .toThrow('活动授权不存在或已失效')
  closeProjectDb()
  await initProjectDb()
  const decision = getProjectDb().prepare('SELECT running_choices FROM pilot_grant_pause_decisions WHERE grant_id = ?')
    .get(grantId) as { running_choices: string }
  expect(JSON.parse(decision.running_choices)).toEqual(choice)
  expect(listPilotGrantStopRequests(project.id)).toMatchObject([{ grant_id: grantId,
    execution_id: running.executionId, command_id: running.input.commandId,
    session_id: 'session-running', state: 'pending' }])
  expect(inspectPilotGrantPauseRecovery(grantId)).toEqual({ state: 'needs_attention',
    pendingStopExecutionIds: [running.executionId], reason: '运行中停止请求缺少进程终止证据' })
})

test('影响面变化或关联失效时拒绝确认，grant 与队列不发生部分修改', () => {
  const { grantId, queue } = fixture()
  const first = queue(1)
  const preview = previewPilotGrantPauseImpact(grantId)
  const second = queue(2)
  expect(() => confirmPilotGrantPause(preview, [])).toThrow('影响面已变化')
  getProjectDb().prepare('DELETE FROM pilot_command_links WHERE command_id = ?').run(second.input.commandId)
  expect(() => previewPilotGrantPauseImpact(grantId)).toThrow('来源关联无法核验')
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as { state: string }
  expect(grant.state).toBe('active')
  expect(getAgentExecution(first.executionId)?.status).toBe('queued')
  expect(getAgentExecution(second.executionId)?.status).toBe('queued')
})


test('取消命令落库失败时，grant 暂停与执行取消一起回滚', () => {
  const { grantId, queue } = fixture()
  const item = queue(1)
  const impact = previewPilotGrantPauseImpact(grantId)
  getProjectDb().exec(`CREATE TRIGGER reject_pilot_release_${item.executionId.replaceAll('-', '_')}
    BEFORE UPDATE OF state ON pilot_commands
    WHEN NEW.id = '${item.input.commandId}' AND NEW.state = 'released'
    BEGIN SELECT RAISE(ABORT, 'fixture release failure'); END`)
  expect(() => confirmPilotGrantPause(impact, [])).toThrow('fixture release failure')
  expect(getAgentExecution(item.executionId)?.status).toBe('queued')
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as { state: string }
  expect(grant.state).toBe('active')
  const decision = getProjectDb().prepare('SELECT grant_id FROM pilot_grant_pause_decisions WHERE grant_id = ?')
    .get(grantId)
  expect(decision).toBeUndefined()
})

test('账本与执行状态矛盾时不展示不完整影响面', () => {
  const { grantId, queue } = fixture()
  const item = queue(1)
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'released' WHERE id = ?").run(item.input.commandId)
  expect(() => previewPilotGrantPauseImpact(grantId)).toThrow('状态不一致')
})


test('暂停影响面列出未排队预留，确认后同事务释放费用', () => {
  const { project, grantId } = fixture()
  const task = createTask(project.id, { title: '尚未排队', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const input = { commandId: `reserved-${project.id}`, projectId: project.id, grantId, idempotencyKey: 'reserved',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor' as const, reworkOrdinal: 0 }
  reservePilotCommandBudget(input)
  const impact = previewPilotGrantPauseImpact(grantId)
  expect(impact.reservedCommandIds).toEqual([input.commandId])
  const result = confirmPilotGrantPause(impact, [])
  expect(result.releasedReservationCommandIds).toEqual([input.commandId])
  const command = getProjectDb().prepare('SELECT state, actual_cost_micros FROM pilot_commands WHERE id = ?')
    .get(input.commandId) as { state: string; actual_cost_micros: number }
  expect(command).toEqual({ state: 'released', actual_cost_micros: 0 })
})


test('旧版暂停决定没有新表记录时仍列出送达状态未知的人工对账项', () => {
  const { project, grantId, queue } = fixture()
  const running = queue(1)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  confirmPilotGrantPause(previewPilotGrantPauseImpact(grantId),
    [{ executionId: running.executionId, disposition: 'request_stop' }])
  getProjectDb().prepare('DELETE FROM pilot_grant_stop_requests WHERE grant_id = ?').run(grantId)
  expect(listPilotGrantStopRequests(project.id)).toMatchObject([{ grant_id: grantId,
    execution_id: running.executionId, state: 'legacy_unknown' }])
})


test('逐项待停止写入失败时授权撤权与排队取消一并回滚', () => {
  const { grantId, queue } = fixture()
  const queued = queue(1)
  const running = queue(2)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  const preview = previewPilotGrantPauseImpact(grantId)
  getProjectDb().exec(`CREATE TRIGGER reject_pending_stop BEFORE INSERT ON pilot_grant_stop_requests
    BEGIN SELECT RAISE(ABORT, 'pending unavailable'); END`)
  expect(() => confirmPilotGrantPause(preview,
    [{ executionId: running.executionId, disposition: 'request_stop' }])).toThrow('pending unavailable')
  getProjectDb().exec('DROP TRIGGER reject_pending_stop')
  expect((getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as { state: string }).state).toBe('active')
  expect(getAgentExecution(queued.executionId)?.status).toBe('queued')
  expect(listPilotGrantStopRequests(preview.projectId)).toEqual([])
})


test('停止请求只在撤权提交后逐项发送，失败如实报告未验证', () => {
  const { grantId, queue } = fixture()
  const running = queue(1)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  const preview = previewPilotGrantPauseImpact(grantId)
  const seen: string[] = []
  const result = confirmPilotGrantPauseAndRequestStops(preview,
    [{ executionId: running.executionId, disposition: 'request_stop' }], (executionId) => {
      const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
        .get(grantId) as { state: string }
      expect(grant.state).toBe('paused')
      seen.push(executionId)
      throw new Error('停止器不可用')
    })
  expect(seen).toEqual([running.executionId])
  expect(result.stopOutcomes).toEqual([{ executionId: running.executionId,
    requestAccepted: false, stopped: false, processTermination: 'NOT_VERIFIED' }])
  expect(getAgentExecution(running.executionId)?.status).toBe('running')
})


test('暂停后逐条请求停止：一条已接受、一条抛错，均不冒充终止且重启待对账', async () => {
  const { grantId, queue } = fixture()
  const first = queue(1)
  const second = queue(2)
  for (const item of [first, second]) {
    updateAgentExecution(item.executionId, { status: 'running', sessionId: `session-${item.executionId}` })
    getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(item.input.commandId)
  }
  const calls: string[] = []
  const preview = previewPilotGrantPauseImpact(grantId)
  const result = confirmPilotGrantPauseAndRequestStops(preview, [
    { executionId: first.executionId, disposition: 'request_stop' },
    { executionId: second.executionId, disposition: 'request_stop' },
  ], (executionId) => {
    calls.push(executionId)
    expect((getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
      .get(grantId) as { state: string }).state).toBe('paused')
    if (executionId === first.executionId) return { executionId, requestAccepted: true,
      stopped: false, processTermination: 'NOT_VERIFIED' }
    throw new Error('目标代际不可用')
  })
  expect(calls).toEqual([first.executionId, second.executionId])
  expect(result.stopOutcomes).toEqual([
    { executionId: first.executionId, requestAccepted: true, stopped: false, processTermination: 'NOT_VERIFIED' },
    { executionId: second.executionId, requestAccepted: false, stopped: false, processTermination: 'NOT_VERIFIED' },
  ])
  expect(listPilotGrantStopRequests(preview.projectId).map((row) => row.state))
    .toEqual(['accepted_unverified', 'unverified'])
  closeProjectDb()
  await initProjectDb()
  expect(listPilotGrantStopRequests(preview.projectId).map((row) => row.state))
    .toEqual(['accepted_unverified', 'unverified'])
  expect(inspectPilotGrantPauseRecovery(grantId).state).toBe('needs_attention')
  const activities = getProjectDb().prepare("SELECT payload FROM project_activities WHERE action = 'pilot_stop_request_result' AND project_id = ?")
    .all(preview.projectId) as Array<{ payload: string }>
  expect(activities.map((item) => JSON.parse(item.payload).executionId).sort()).toEqual(
    [first.executionId, second.executionId].sort())
})


test('停止请求已送达但结果审计失败时不伪装成未送达，保留人工对账', () => {
  const { grantId, queue } = fixture()
  const running = queue(1)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  getProjectDb().exec(`CREATE TRIGGER reject_stop_result BEFORE INSERT ON project_activities
    WHEN NEW.action = 'pilot_stop_request_result' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`)
  const result = confirmPilotGrantPauseAndRequestStops(previewPilotGrantPauseImpact(grantId),
    [{ executionId: running.executionId, disposition: 'request_stop' }], (executionId) => ({
      executionId, requestAccepted: true, stopped: false, processTermination: 'NOT_VERIFIED',
    }))
  expect(result.stopOutcomes).toEqual([{ executionId: running.executionId, requestAccepted: true,
    stopped: false, processTermination: 'NOT_VERIFIED', auditRecorded: false }])
  expect(listPilotGrantStopRequests(getAgentExecution(running.executionId)!.projectId)[0]?.state).toBe('pending')
  expect(inspectPilotGrantPauseRecovery(grantId).state).toBe('needs_attention')
  getProjectDb().exec('DROP TRIGGER reject_stop_result')
})


test('reserved 命令已有执行标记时拒绝释放预算', () => {
  const { project, grantId } = fixture()
  const task = createTask(project.id, { title: '异常预留', description: '', workspaceId: 'workspace-a',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const commandId = `reserved-${project.id}`
  reservePilotCommandBudget({ commandId, projectId: project.id, grantId, idempotencyKey: 'reserved',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0 })
  createAgentExecution({ id: `orphan-${project.id}`, projectId: project.id, entityType: 'task',
    entityId: task.id, agentId: 'executor', sessionId: '', prompt: '异常执行', pilotCommandId: commandId })
  expect(() => previewPilotGrantPauseImpact(grantId)).toThrow('已有执行或来源关联')
  const grant = getProjectDb().prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
    .get(grantId) as { state: string }
  expect(grant.state).toBe('active')
})


test('停止器返回自相矛盾的已停止结果时按未验证报告', () => {
  const { grantId, queue } = fixture()
  const running = queue(1)
  updateAgentExecution(running.executionId, { status: 'running', sessionId: 'session-running' })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(running.input.commandId)
  const result = confirmPilotGrantPauseAndRequestStops(previewPilotGrantPauseImpact(grantId),
    [{ executionId: running.executionId, disposition: 'request_stop' }], (executionId) => ({
      executionId, requestAccepted: false, stopped: true, processTermination: 'VERIFIED',
    }))
  expect(result.stopOutcomes).toEqual([{ executionId: running.executionId,
    requestAccepted: false, stopped: false, processTermination: 'NOT_VERIFIED' }])
})


test('重启对账仅在排队取消可核验且无待停请求时报告完成', async () => {
  const { grantId, queue } = fixture()
  const item = queue(1)
  confirmPilotGrantPause(previewPilotGrantPauseImpact(grantId), [])
  closeProjectDb()
  await initProjectDb()
  expect(inspectPilotGrantPauseRecovery(grantId)).toEqual({ state: 'queue_reconciled', pendingStopExecutionIds: [] })
  getProjectDb().prepare("UPDATE pilot_commands SET state = 'queued' WHERE id = ?").run(item.input.commandId)
  expect(inspectPilotGrantPauseRecovery(grantId)).toEqual({ state: 'needs_attention',
    pendingStopExecutionIds: [], reason: '排队取消结果无法核验' })
})


test('持久暂停记录损坏时恢复拒绝宣称已完成', () => {
  const { grantId, queue } = fixture()
  queue(1)
  confirmPilotGrantPause(previewPilotGrantPauseImpact(grantId), [])
  getProjectDb().prepare('UPDATE pilot_grant_pause_decisions SET queued_targets = ? WHERE grant_id = ?')
    .run('{bad json', grantId)
  expect(inspectPilotGrantPauseRecovery(grantId)).toEqual({ state: 'needs_attention',
    pendingStopExecutionIds: [], reason: '暂停确认记录无法读取' })
})
