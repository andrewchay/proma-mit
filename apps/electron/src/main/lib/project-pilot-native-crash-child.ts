import { getPilotGrantBudgetUsage, hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfigDir, getChannelsPath } from './config-paths'
import { getChannelById } from './channel-manager'
import { resolvePilotApproval } from './project-pilot-approval'
import { createAgentWorkspace, getAgentWorkspace } from './agent-workspace-manager'
import { bindWorkspaceToProject, listProjectWorkspaceBindings } from './project-workspace-bindings'
import { inspectPilotReadiness } from './project-pilot-readiness'
import { getPilotControlSnapshot } from './project-pilot-control'
import { reconcileAllPilotProjects, startPilotBackgroundReconcile } from './project-pilot-background-reconcile'
import { reconcilePilotOverview } from './project-pilot-intent-store'
import { confirmPilotGrantPause, listPilotGrantStopRequests, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createAgentEmployee, createProject, createTask, getAgentEmployee, getAgentExecution, getProjectDb, getTask,
  initProjectDb, listAgentExecutionsByProject, updateAgentExecution, updateTask } from './project-sqlite-store'

// 仅由 G1 原生强杀测试子进程执行；必须运行生产 NativeSqliteCompat/better-sqlite3 WAL 分支。不连接 Provider。
const MODES = ['setup', 'setup-dispatch', 'setup-approval', 'before', 'after', 'dispatch-before', 'dispatch-after',
  'dispatch-retry', 'approval-before', 'approval-after', 'approval-after-commit-before-event',
  'approval-retry', 'approval-dup', 'reconcile-approved', 'setup-approval-bound', 'resume-approved-bound',
  'invalidate-bound-channel', 'start-approved-bound-background', 'inspect'] as const
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
  workspaceId?: string
  channelId?: string
  executorEmployeeId?: string
  repoPath?: string
}

function readIdentity(): Identity {
  const raw = process.argv[3]
  if (!raw) throw new Error('缺少夹具身份')
  return JSON.parse(raw) as Identity
}

function emit(payload: unknown): void {
  process.stdout.write(`DATA ${JSON.stringify(payload)}\n`)
}

function holdUntilKilled(marker: 'READY_BEFORE_COMMIT' | 'READY_AFTER_COMMIT' | 'READY_AFTER_COMMIT_BEFORE_EVENT'): void {
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
  if (mode === 'setup-approval-bound') {
    const repoPath = mkdtempSync(join(getConfigDir(), 'pilot-bound-repo-'))
    execFileSync('git', ['init', '--quiet', repoPath])
    const workspace = createAgentWorkspace('Pilot WAL 绑定工作区', repoPath)
    const channelId = 'native-channel-bound'
    // Electron run-as-node 没有 safeStorage；测试文件只做权威 channels.json 夹具，
    // 随后和重启后必须由生产 getChannelById / inspectPilotReadiness 重新读取，绝不请求 .invalid 端点。
    writeFileSync(getChannelsPath(), JSON.stringify({ version: 1, channels: [{
      id: channelId, name: 'Pilot WAL 无网络渠道', provider: 'custom',
      baseUrl: 'https://pilot.invalid/v1', apiKey: 'fixture-not-a-real-key',
      models: [{ id: 'glm-5.3-flash', name: 'G1 无请求模型', enabled: true }],
      enabled: true, createdAt: now, updatedAt: now,
    }] }))
    const channel = getChannelById(channelId)
    if (!channel?.enabled) throw new Error('持久渠道夹具未被生产读取')
    const executor = createAgentEmployee({ name: 'Pilot WAL 执行', role: '工程师', description: '',
      channelId: channel.id, modelId: 'glm-5.3-flash', workspaceId: workspace.id,
      workspaceIds: [workspace.id], runtime: 'ai-sdk', executionProfile: 'development' })
    const reviewer = createAgentEmployee({ name: 'Pilot WAL 评审', role: '技术评审', description: '',
      channelId: channel.id, modelId: 'glm-5.3-flash', workspaceId: workspace.id,
      workspaceIds: [workspace.id], runtime: 'ai-sdk', executionProfile: 'development' })
    const project = createProject({ title: '原生 WAL 审批同库续派', description: '' })
    if (!bindWorkspaceToProject(project.id, workspace.id)) throw new Error('项目与隔离工作区正式绑定失败')
    const grantId = `native-grant-${project.id}`
    insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId: workspace.id,
      channelId: channel.id, modelId: 'glm-5.3-flash', executorEmployeeId: executor.id,
      reviewerEmployeeId: reviewer.id, maxCostMicros: 10_000, maxRuns: 2, maxRework: 0,
      expiresAt: now + 120_000, createdAt: now })
    const task = createTask(project.id, { title: '原生 WAL 同库审批', description: '',
      workspaceId: workspace.id, assignee: { userId: `agent-${executor.id}`, displayName: executor.name } })
    const commandId = `native-command-${project.id}`
    const executionId = `native-execution-${project.id}`
    reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'native-approval-bound',
      taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
      employeeId: executor.id, role: 'executor', reworkOrdinal: 0 },
    { executionId, prompt: '合成询问，不调用模型' })
    const summary = '【需要人工：决策】是否继续？'
    database.prepare("UPDATE pilot_commands SET state = 'settled', actual_cost_micros = 30 WHERE id = ?").run(commandId)
    updateAgentExecution(executionId, { status: 'completed', completedAt: Date.now(), resultSummary: summary })
    updateTask(task.id, { status: 'paused', completionNotes: summary })
    const readiness = inspectPilotReadiness(project.id)
    if (!readiness.bindingsValid) throw new Error(`正式绑定预检未通过：${readiness.blockers.join('; ')}`)
    emit({ projectId: project.id, grantId, executionId, commandId, taskId: task.id,
      sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task), idempotencyKey: 'native-approval-bound',
      prompt: '合成询问，不调用模型', employeeId: executor.id, executorEmployeeId: executor.id,
      workspaceId: workspace.id, channelId: channel.id, repoPath,
      summary, version: getTask(task.id)!.updatedAt })
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
    case 'approval-after-commit-before-event': {
      // 只在审批事务执行函数返回（COMMIT 已完成）后阻断，事件与活动记录尚未执行。
      const original = database.transaction.bind(database)
      database.transaction = ((callback: () => void) => {
        const execute = original(callback)
        return () => {
          execute()
          if (approvalResolutionExists(database, identity.taskId)) {
            holdUntilKilled('READY_AFTER_COMMIT_BEFORE_EVENT')
          }
        }
      }) as typeof database.transaction
      await resolvePilotApproval(identity.projectId, identity.taskId, 'approved',
        { sourceVersion: identity.version!, note: '已确认继续' })
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
    case 'invalidate-bound-channel': {
      // 仅操纵隔离权威 channels.json 夹具；生产 getChannelById / inspectPilotReadiness 必须即时阻断。
      const path = getChannelsPath()
      const config = JSON.parse(readFileSync(path, 'utf8')) as { version: number; channels: Array<{ id: string; enabled: boolean }> }
      const channel = config.channels.find((item) => item.id === identity.channelId)
      if (!channel) throw new Error('渠道夹具不存在')
      channel.enabled = false
      writeFileSync(path, JSON.stringify(config))
      emit({ disabled: !getChannelById(identity.channelId!)?.enabled })
      closeProjectDb()
      return
    }
    case 'start-approved-bound-background': {
      const readiness = inspectPilotReadiness(identity.projectId)
      if (!readiness.bindingsValid || getPilotControlSnapshot(identity.projectId).grantStatus !== 'active') {
        throw new Error(`后台启动前生产预检未通过：${readiness.blockers.join('; ')}`)
      }
      let starts = 0
      const stop = startPilotBackgroundReconcile({ inspectReadiness: inspectPilotReadiness,
        startExecution: async () => { starts++; return false },
      })
      try {
        let queuedCount = 0
        for (let i = 0; i < 100; i++) {
          queuedCount = (database.prepare(`SELECT count(*) AS n FROM pilot_commands
            WHERE source_task_id = ? AND state = 'queued'`).get(identity.taskId) as { n: number }).n
          if (queuedCount === 1) break
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        emit({ queuedCount, starts, commandCount: (database.prepare(`SELECT count(*) AS n FROM pilot_commands
          WHERE source_task_id = ?`).get(identity.taskId) as { n: number }).n })
      } finally {
        stop()
      }
      closeProjectDb()
      return
    }
    case 'resume-approved-bound': {
      // 同一被 SIGKILL 的 WAL 数据库重开后仅替换 Runtime 启动，不覆盖生产 readiness/grant 状态。
      const readiness = inspectPilotReadiness(identity.projectId)
      const control = getPilotControlSnapshot(identity.projectId)
      const channel = identity.channelId ? getChannelById(identity.channelId) : undefined
      const workspace = identity.workspaceId ? getAgentWorkspace(identity.workspaceId) : undefined
      const executor = identity.executorEmployeeId ? getAgentEmployee(identity.executorEmployeeId) : null
      if (!channel || channel.baseUrl !== 'https://pilot.invalid/v1'
        || !workspace?.rootPath || !identity.repoPath
        || realpathSync(workspace.rootPath) !== realpathSync(identity.repoPath)
        || executor?.runtime !== 'ai-sdk'
        || !executor.workspaceIds?.includes(identity.workspaceId ?? '')) {
        throw new Error('重启后渠道、Git 工作区或 ai-sdk 员工绑定漂移')
      }
      const boundWorkspace = listProjectWorkspaceBindings(identity.projectId)
        .some((binding) => binding.workspaceId === identity.workspaceId)
      if (!boundWorkspace) throw new Error('重启后项目工作区正式绑定缺失')
      if (!readiness.bindingsValid || control.grantStatus !== 'active') {
        throw new Error(`重启绑定或授权未就绪：${readiness.blockers.join('; ')} / ${control.grantStatus}`)
      }
      let starts = 0
      const dependencies = { inspectReadiness: inspectPilotReadiness,
        startExecution: async () => { starts++; return false } }
      await reconcileAllPilotProjects(undefined, dependencies)
      await reconcileAllPilotProjects(undefined, dependencies)
      const rows = database.prepare('SELECT id, state, execution_id FROM pilot_commands WHERE source_task_id = ?')
        .all(identity.taskId) as Array<{ id: string; state: string; execution_id: string }>
      const queued = rows.filter((row) => row.state === 'queued')
      emit({ readiness: readiness.bindingsValid, grantStatus: control.grantStatus,
        boundWorkspace, commandCount: rows.length, queuedCount: queued.length, starts,
        queuedExecutionId: queued[0]?.execution_id ?? null,
        queuedExecution: queued[0] ? getAgentExecution(queued[0].execution_id) : null,
        approvalActivityCount: (database.prepare(`SELECT count(*) AS n FROM project_activities
          WHERE project_id = ? AND entity_id = ? AND action = 'pilot_approval_approved'`)
          .get(identity.projectId, identity.taskId) as { n: number }).n })
      closeProjectDb()
      return
    }
    case 'reconcile-approved': {
      // 重开后主动重读权威事实；不注入 readiness，也不启动派发或 Provider。
      const snapshot = await reconcilePilotOverview(identity.projectId)
      emit({ ready: snapshot.intents.filter((item) => item.status === 'open'
        && item.kind === 'ready_candidate' && item.sourceId === identity.taskId).length,
      commandCount: (database.prepare('SELECT count(*) AS n FROM pilot_commands WHERE source_task_id = ?')
        .get(identity.taskId) as { n: number }).n })
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
      const approvalActivityCount = (database.prepare(`SELECT count(*) AS n FROM project_activities
        WHERE project_id = ? AND entity_id = ? AND action = 'pilot_approval_approved'`)
        .get(identity.projectId, identity.taskId) as { n: number }).n
      const budget = getPilotGrantBudgetUsage(identity.grantId)
      emit({ driver: database.constructor.name, journalMode: database.prepare('PRAGMA journal_mode').get(),
        grantState: grant?.state ?? null, decisions, executionStatus: execution?.status ?? null,
        commandState: command?.state ?? null, openEscalations, taskStatus: task?.status ?? null,
        taskVersion: task?.updatedAt ?? null, resolutionCount, approvalActivityCount, commandCount,
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
