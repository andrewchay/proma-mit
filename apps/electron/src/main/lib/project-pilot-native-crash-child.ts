import { hashPilotTaskSource, reserveAndQueuePilotCommand } from './project-pilot-budget-ledger'
import { confirmPilotGrantPause, listPilotGrantStopRequests, previewPilotGrantPauseImpact } from './project-pilot-grant-pause'
import { insertPilotGrantFixture } from './project-pilot-test-helpers'
import { closeProjectDb, createProject, createTask, getAgentExecution, getProjectDb, initProjectDb,
  updateAgentExecution } from './project-sqlite-store'

// 非 Bun 子进程夹具：必须运行 production NativeSqliteCompat/better-sqlite3 分支。
const mode = process.argv[2]
if (!['setup', 'before', 'after', 'inspect'].includes(mode ?? '')) throw new Error('无效崩溃窗口')
async function main(): Promise<void> {
await initProjectDb()
const database = getProjectDb()
const driver = database.constructor.name
if (driver !== 'NativeSqliteCompat') throw new Error(`测试未走生产原生数据库分支：${driver}`)
if (mode === 'setup') {
  const project = createProject({ title: '原生 WAL 暂停', description: '' })
  const grantId = `native-grant-${project.id}`
  const now = Date.now()
  insertPilotGrantFixture({ grantId, projectId: project.id, workspaceId: 'workspace-native',
    channelId: 'channel-native', modelId: 'model-native', maxCostMicros: 10_000, maxRuns: 2,
    maxRework: 0, expiresAt: now + 120_000, createdAt: now })
  const task = createTask(project.id, { title: '运行中的停止目标', description: '', workspaceId: 'workspace-native',
    assignee: { userId: 'agent-executor', displayName: '执行员工' } })
  const commandId = `native-command-${project.id}`
  const executionId = `native-execution-${project.id}`
  reserveAndQueuePilotCommand({ commandId, projectId: project.id, grantId, idempotencyKey: 'native-dispatch',
    taskId: task.id, sourceVersion: task.updatedAt, sourceHash: hashPilotTaskSource(task),
    employeeId: 'executor', role: 'executor', reworkOrdinal: 0 }, { executionId, prompt: '运行中任务' })
  updateAgentExecution(executionId, { status: 'running', sessionId: `native-session-${project.id}` })
  database.prepare("UPDATE pilot_commands SET state = 'running' WHERE id = ?").run(commandId)
  process.stdout.write(`DATA ${JSON.stringify({ projectId: project.id, grantId, executionId })}\n`)
  closeProjectDb()
} else {
  const projectId = process.argv[3]
  const grantId = process.argv[4]
  const executionId = process.argv[5]
  if (!projectId || !grantId || !executionId) throw new Error('缺少夹具身份')
  if (mode === 'before' || mode === 'after') {
    const preview = previewPilotGrantPauseImpact(grantId)
    const run = () => confirmPilotGrantPause(preview, [{ executionId, disposition: 'request_stop' }])
    if (mode === 'before') {
      // 外层事务拦截 COMMIT 窗口；生产暂停函数本身不修改，事务 callback 完成后强杀。
      const original = database.transaction.bind(database)
      database.transaction = ((callback: () => void) => original(() => {
        callback()
        process.stdout.write('READY_BEFORE_COMMIT\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
      })) as typeof database.transaction
      run()
    } else {
      run()
      process.stdout.write('READY_AFTER_COMMIT\n')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
    }
  } else {
    const grant = database.prepare('SELECT state FROM pilot_runtime_grants WHERE id = ?')
      .get(grantId) as { state: string } | undefined
    const decision = database.prepare('SELECT count(*) AS n FROM pilot_grant_pause_decisions WHERE grant_id = ?')
      .get(grantId) as { n: number }
    const execution = getAgentExecution(executionId)
    process.stdout.write(`DATA ${JSON.stringify({ driver, journalMode: database.prepare('PRAGMA journal_mode').get(),
      grantState: grant?.state, decisions: decision.n, executionStatus: execution?.status,
      requests: listPilotGrantStopRequests(projectId).map((row) => ({ executionId: row.execution_id, state: row.state })) })}\n`)
    closeProjectDb()
  }
}
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
