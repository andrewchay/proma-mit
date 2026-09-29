import { getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { resolvePilotApproval } from './project-pilot-approval'
import { confirmPilotGrantPause, listPilotGrantStopRequests, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createProject, createTask, getAgentExecution, getProjectDb, getTask,
  initProjectDb, listAgentExecutionsByProject, updateAgentExecution, updateTask } from './project-sqlite-store'

// 仅由 G1 原生强杀测试子进程执行；必须运行生产 NativeSqliteCompat/better-sqlite3 WAL 分支。不连接 Provider。
const MODES = ['setup', 'setup-dispatch', 'setup-approval', 'before', 'after', 'dispatch-before', 'dispatch-after',
  'dispatch-retry', 'approval-before', 'approval-after', 'approval-retry', 'approval-dup', 'inspect'] as const
const mode = process.argv[2]
if (!mode || !(MODES as readonly string[]).includes(mode)) throw new Error('无效崩溃窗口')

interface Identity {
  projectId: string
  grantId: string
  executionId: string
  commandId: string
  taskId: string
  sourceVersion: number
  sourceHash: string
  idempotencyKey: string
  prompt: string
  employeeId: string
  summary?: string
  version?: number
}

function readIdentity(): Identity {
  const raw = process.argv[3]
  if (!raw) throw new Error('缺少夹具身份')
  return JSON.parse(raw) as Identity
}

function emit(payload: unknown): void {
  process.stdout.write(`DATA ${JSON.stringify(payload)}\n`)
}

function holdUntilKilled(marker: 'READY_BEFORE_COMMIT' | 'READY_AFTER_COMMIT'): void {
  process.stdout.write(`${marker}\n`)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function commandExists(database: ReturnType<typeof getProjectDb>, commandId: string): boolean {
  return (database.prepare('SELECT count(*) AS n FROM pilot_commands WHERE id = ?').get(commandId) as { n: number }).n > 0
}

function grantStopRequestExists(database: ReturnType<typeof getProjectDb>, grantId: string): boolean {
  return (database.prepare('SELECT count(*) AS n FROM pilot_grant_stop_requests WHERE grant_id = ?')
    .get(grantId) as { n: number }).n > 0
}

function approvalResolutionExists(database: ReturnType<typeof getProjectDb>, taskId: string): boolean {
  return (database.prepare('SELECT count(*) AS n FROM pilot_approval_resolutions WHERE task_id = ?')
    .get(taskId) as { n: number }).n > 0
}

/** 在包含目标写入的最外层事务 COMMIT 前挂起：深度 + 内容标记双条件，避免误挂到前置快照或嵌套事务。 */
function holdBeforeCommit(database: ReturnType<typeof getProjectDb>, marker: () => boolean): void {
  let depth = 0
  const original = database.transaction.bind(database)
  database.transaction = ((callback: () => void) => original(() => {
    const outermost = depth === 0
    depth++
    try { callback() } finally { depth-- }
    if (outermost && marker()) {
      process.stdout.write('READY_BEFORE_COMMIT\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
    }
  })) as typeof database.transaction
}

async function main(): Promise<void> {
  await initProjectDb()
  const database = getProjectDb()
  if (database.constructor.name !== 'NativeSqliteCompat') {
    throw new Error(`测试未走生产原生数据库分支：${database.constructor.name}`)
  }
  const now = Date.now()

  const buildGrantFixture = (projectId: string): string => {
    const grantId = `native-grant-${projectId}`
    insertPilotGrantFixture({ grantId, projectId, workspaceId: 'workspace-native', channelId: 'channel-native',
      modelId: 'model-native', maxCostMicros: 10_000, maxRuns: 2, maxRework: 0,
      expiresAt: now + 120_000, createdAt: now })
    return grantId
  }
  const buildTask = (projectId: string) => createTask(projectId, { title: '原生强杀窗口任务', description: '',
    workspaceId: 'workspace-native', assignee: { userId: 'agent-executor', displayName: '执行员工' } })

  if (mode === 'setup') {
    const project = createProject({ title: '原生 WAL 暂停', description: '' })
    const grantId = buildGrantFixture(project.id)
    const task = buildTask(project.id)
    const commandId = `native-command-${project.id}`
    const executionId = `native-execution-${project.id}`
    reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'native-dispatch',
      taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      employeeId: 'executor', role: 'executor', reworkOrdinal: 0 }, { executionId, prompt: '运行中任务' })
    updateAgentExecution(executionId, { status: 'running', sessionId: `native-session-${project.id}` })
    database.prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(commandId)
    emit({ projectId: project.id, grantId, executionId, commandId, taskId: task.id,
      sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      idempotencyKey: 'native-dispatch', prompt: '运行中任务', employeeId: 'executor' })
    closeProjectDb()
    return
  }
  if (mode === 'setup-dispatch') {
    const project = createProject({ title: '原生派发窗口', description: '' })
    const grantId = buildGrantFixture(project.id)
    const task = buildTask(project.id)
    emit({ projectId: project.id, grantId, commandId: `native-command-${project.id}`,
      executionId: `native-execution-${project.id}`, taskId: task.id,
      sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      idempotencyKey: 'native-dispatch', prompt: '派发窗口任务', employeeId: 'executor' })
    closeProjectDb()
    return
  }
  if (mode === 'setup-approval') {
    const project = createProject({ title: '原生审批窗口', description: '' })
    const grantId = buildGrantFixture(project.id)
    const task = buildTask(project.id)
    const commandId = `native-command-${project.id}`
    const executionId = `native-execution-${project.id}`
    reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'native-approval',
      taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      employeeId: 'executor', role: 'executor', reworkOrdinal: 0 },
    { executionId, prompt: '模拟完成请求' })
    const summary = '【需要人工：决策】是否继续？'
    database.prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 30 WHERE id = ?").run(commandId)
    updateAgentExecution(executionId, { status: 'completed', completedAt: Date.now(), resultSummary: summary })
    updateTask(task.id, { status: 'paused', completionNotes: summary })
    const version = getTask(task.id)!.updatedAt
    emit({ projectId: project.id, grantId, executionId, commandId, taskId: task.id,
      sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      idempotencyKey: 'native-approval', prompt: '模拟完成请求', employeeId: 'executor', summary, version })
    closeProjectDb()
    return
  }

  const identity = readIdentity()
  const dispatchInput = { commandId: identity.commandId, projectId: identity.projectId, grantId: identity.grantId,
    idempotencyKey: identity.idempotencyKey, taskId: identity.taskId, sourceVersion: identity.sourceVersion,
    sourceHash: identity.sourceHash, employeeId: identity.employeeId, role: 'executor' as const, reworkOrdinal: 0 }
  const queue = { executionId: identity.executionId, prompt: identity.prompt }

  switch (mode) {
    case 'before':
    case 'after': {
      const run = () => confirmPilotGrantPause(previewPilotGrantPauseImpact(identity.grantId),
        [{ executionId: identity.executionId, disposition: 'request_stop' }])
      if (mode === 'before') {
        holdBeforeCommit(database, () => grantStopRequestExists(database, identity.grantId))
        run()
      } else {
        run()
        holdUntilKilled('READY_AFTER_COMMIT')
      }
      return
    }
    case 'dispatch-before':
      holdBeforeCommit(database, () => commandExists(database, identity.commandId))
      reserveAndQueuePilotCommand(dispatchInput, queue)
      return
    case 'dispatch-after':
      reserveAndQueuePilotCommand(dispatchInput, queue)
      holdUntilKilled('READY_AFTER_COMMIT')
      return
    case 'dispatch-retry': {
      try {
        const result = reserveAndQueuePilotCommand(dispatchInput, queue)
        emit({ ok: true, commandState: result.command.state, executionStatus: result.execution.status })
      } catch (cause) {
        emit({ ok: false, message: messageOf(cause) })
      }
      closeProjectDb()
      return
    }
    case 'approval-before':
      holdBeforeCommit(database, () => approvalResolutionExists(database, identity.taskId))
      await resolvePilotApproval(identity.projectId, identity.taskId, 'approved',
        { sourceVersion: identity.version!, note: '已确认继续' })
      return
    case 'approval-after':
      await resolvePilotApproval(identity.projectId, identity.taskId, 'approved',
        { sourceVersion: identity.version!, note: '已确认继续' })
      holdUntilKilled('READY_AFTER_COMMIT')
      return
    case 'approval-retry': {
      try {
        await resolvePilotApproval(identity.projectId, identity.taskId, 'approved',
          { sourceVersion: identity.version!, note: '已确认继续' })
        emit({ ok: true })
      } catch (cause) {
        emit({ ok: false, message: messageOf(cause) })
      }
      closeProjectDb()
      return
    }
    case 'approval-dup': {
      try {
        await resolvePilotApproval(identity.projectId, identity.taskId, 'approved',
          { sourceVersion: identity.sourceVersion, note: '重复' })
        emit({ ok: true })
      } catch (cause) {
        emit({ ok: false, message: messageOf(cause) })
      }
      closeProjectDb()
      return
    }
    case 'inspect': {
      const grant = database.prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
        .get(identity.grantId) as { state: string } | undefined
      const decisions = (database.prepare('SELECT count(*) AS n FROM pilot_grant_pause_decisions WHERE grant_id = ?')
        .get(identity.grantId) as { n: number }).n
      const commandCount = (database.prepare('SELECT count(*) AS n FROM pilot_commands WHERE id = ?')
        .get(identity.commandId) as { n: number }).n
      const command = database.prepare('SELECT state FROM pilot_commands WHERE id = ?')
        .get(identity.commandId) as { state: string } | undefined
      const execution = getAgentExecution(identity.executionId)
      const openEscalations = (database.prepare(
        'SELECT count(*) AS n FROM pilot_stop_escalations WHERE execution_id = ? AND resolved_at IS NULL')
        .get(identity.executionId) as { n: number }).n
      const task = getTask(identity.taskId)
      const resolutionCount = (database.prepare(
        'SELECT count(*) AS n FROM pilot_approval_resolutions WHERE task_id = ?')
        .get(identity.taskId) as { n: number }).n
      const budget = getPilotGrantBudgetUsage(identity.grantId)
      emit({ driver: database.constructor.name, journalMode: database.prepare('PRAGMA journal_mode').get(),
        grantState: grant?.state ?? null, decisions, executionStatus: execution?.status ?? null,
        commandState: command?.state ?? null, openEscalations, taskStatus: task?.status ?? null,
        taskVersion: task?.updatedAt ?? null, resolutionCount, commandCount,
        executionCount: listAgentExecutionsByProject(identity.projectId).length,
        runReservations: budget.runReservations,
        requests: listPilotGrantStopRequests(identity.projectId)
          .map((row) => ({ executionId: row.execution_id, state: row.state })) })
      closeProjectDb()
      return
    }
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
