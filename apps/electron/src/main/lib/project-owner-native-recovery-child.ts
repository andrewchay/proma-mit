import { randomUUID } from 'node:crypto'
import { createProject, createTask, getProjectDb, initProjectDb, closeProjectDb } from './project-sqlite-store'
import { saveProjectOwnerGoalDraft } from './project-owner-goal-service'
import { recoverInterruptedOwnerRuntimeExecutions } from './project-owner-execution-stop'

const mode = process.argv[2]
const now = Date.now()

async function main(): Promise<void> {
  await initProjectDb()
  const database = getProjectDb()
  if (database.constructor.name !== 'NativeSqliteCompat') throw new Error(`未使用原生SQLite：${database.constructor.name}`)

  if (mode === 'setup') {
    const project = createProject({ title: 'Owner原生恢复', description: '' })
    saveProjectOwnerGoalDraft(project.id, 0, { objective: '验证恢复后审批和旧回调的处理状态' })
    const task = createTask(project.id, { title: '等待敏感动作审批', description: '' })
    const grantId = randomUUID(), commandId = randomUUID(), executionId = randomUUID()
    const sessionId = randomUUID(), requestId = randomUUID(), employeeId = randomUUID()
    // 故意缺少历史重验证来源：验证WAL恢复仍失效审批并保留占额，不从主模型补造用量身份。
    database.prepare(`INSERT INTO project_owner_execution_grants
      (id,project_id,task_id,purpose,state,revalidation_id,revalidation_revision,revalidation_integrity_hash,
       materialization_id,materialization_revision,materialization_integrity_hash,policy_revision,executor_employee_id,
       reviewer_employee_id,workspace_id,channel_id,model_id,runtime,max_cost_micros,max_runs,max_rework,expires_at,
       approval_fingerprint,source_hash,request_id,input_hash,issued_at)
      VALUES (?,?,?,'owner_business_execution','active',?,1,?,?,1,?,1,?,?,?,?,?,'ai-sdk',1000,1,0,?,?,?,?,?,?)`)
      .run(grantId, project.id, task.id, randomUUID(), 'revalidation-hash', randomUUID(), 'materialization-hash',
        employeeId, randomUUID(), 'workspace-fixture', 'channel-fixture', 'model-fixture', now + 60_000,
        randomUUID(), randomUUID(), randomUUID(), randomUUID(), now)
    database.prepare(`INSERT INTO project_owner_execution_commands
      (id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,
       employee_id,role,rework_ordinal,reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?, 'executor',0,1000,'running',?,?,?,?)`)
      .run(commandId, project.id, grantId, randomUUID(), task.id, randomUUID(), randomUUID(), employeeId,
        executionId, randomUUID(), now, now)
    database.prepare(`INSERT INTO agent_executions
      (id,project_id,entity_type,entity_id,agent_id,session_id,status,started_at,owner_command_id)
      VALUES (?,?,'task',?,?,?,'running',?,?)`)
      .run(executionId, project.id, task.id, employeeId, sessionId, now, commandId)
    database.prepare(`INSERT INTO project_owner_execution_start_attempts
      (execution_id,command_id,project_id,session_id,claimed_at,handoff_intent_at) VALUES (?,?,?,?,?,?)`)
      .run(executionId, commandId, project.id, sessionId, now, now)
    database.prepare(`INSERT INTO project_owner_execution_start_receipts
      (execution_id,command_id,project_id,session_id,runner_name,process_id,started_at,received_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(executionId, commandId, project.id, sessionId, 'native-fixture', process.pid, now, now)
    database.prepare(`INSERT INTO project_owner_action_approvals
      (request_id,project_id,command_id,execution_id,session_id,tool_name,action_fingerprint,status,requested_at)
      VALUES (?,?,?,?,?,? ,?,'pending',?)`)
      .run(requestId, project.id, commandId, executionId, sessionId, 'Write', 'a'.repeat(64), now)
    process.stdout.write(`READY_OWNER_PENDING ${JSON.stringify({ projectId: project.id, commandId, executionId, requestId })}\n`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
    return
  }

  if (mode === 'recover') {
    const executionId = process.argv[3]
    const results = recoverInterruptedOwnerRuntimeExecutions(now, executionId)
    const repeatedResults = recoverInterruptedOwnerRuntimeExecutions(now + 1, executionId)
    const rows = database.prepare(`SELECT a.status, a.decided_at, a.decision_reason, e.status AS execution_status,
      g.state AS grant_state, c.state AS command_state, c.actual_cost_micros, c.reserved_cost_micros, c.usage_evidence,
      s.escalation_id, s.resolved_at AS escalation_resolved_at, s.reason AS escalation_reason
      FROM project_owner_action_approvals a
      JOIN agent_executions e ON e.id=a.execution_id
      JOIN project_owner_execution_commands c ON c.id=a.command_id
      JOIN project_owner_execution_grants g ON g.id=c.grant_id
      LEFT JOIN project_owner_execution_stop_escalations s ON s.command_id=c.id
      WHERE (? IS NULL OR a.execution_id=?)
      ORDER BY a.requested_at`).all(executionId ?? null, executionId ?? null)
    process.stdout.write(`OWNER_RECOVERY ${JSON.stringify({ results, repeatedResults, rows })}\n`)
    return
  }
  if (mode === 'recover-before') {
    let depth = 0
    const transaction = database.transaction.bind(database)
    database.transaction = ((callback: () => void) => transaction(() => {
      const outermost = depth === 0
      depth++
      try { callback() } finally { depth-- }
      const row = database.prepare(`SELECT a.status, e.status AS execution_status FROM project_owner_action_approvals a
        JOIN agent_executions e ON e.id=a.execution_id ORDER BY a.requested_at LIMIT 1`).get() as
        { status: string; execution_status: string } | undefined
      if (outermost && row?.status === 'invalidated' && row.execution_status === 'stale') {
        process.stdout.write('READY_OWNER_RECOVERY_BEFORE_COMMIT\n')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
      }
    })) as typeof database.transaction
    recoverInterruptedOwnerRuntimeExecutions(now)
    return
  }
  if (mode === 'recover-after') {
    const results = recoverInterruptedOwnerRuntimeExecutions(now)
    process.stdout.write(`READY_OWNER_RECOVERY_AFTER_COMMIT ${JSON.stringify(results)}\n`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
    return
  }
  if (mode === 'inspect') {
    const journalMode = database.prepare('PRAGMA journal_mode').get()
    const rows = database.prepare(`SELECT a.status, a.decided_at, a.decision_reason, e.status AS execution_status,
      g.state AS grant_state, c.state AS command_state, c.actual_cost_micros, c.reserved_cost_micros
      FROM project_owner_action_approvals a
      JOIN agent_executions e ON e.id=a.execution_id
      JOIN project_owner_execution_commands c ON c.id=a.command_id
      JOIN project_owner_execution_grants g ON g.id=c.grant_id`).all()
    process.stdout.write(`OWNER_INSPECT ${JSON.stringify({ journalMode, rows })}\n`)
    return
  }
  throw new Error('未知模式')
}

main().finally(() => closeProjectDb())
