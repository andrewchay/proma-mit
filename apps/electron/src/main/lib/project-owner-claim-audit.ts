/**
 * “说法必须对应事实”检查。
 *
 * 只做本地确定性核对：Owner 发给用户的话声称后台正在处理时，本地必须真的有排队事件
 * 或运行中的执行；否则就是编造。这里不判读模型语义，只按固定说法模式核对事实。
 * 检查结果只作为观察与测试断言，不授予权限，也不改变既有门禁。
 */
export interface OwnerClaimFacts {
  /** 尚未消费的管理事件数（含 assignment_recheck 等）。 */
  pendingEvents: number
  /** 当前状态为 running 的 Owner 命令执行数。 */
  runningExecutions: number
  /** 等待用户决定的员工交互数；这不是“后台处理”，不入账。 */
  awaitingUserDecisions: number
}

export interface OwnerClaimMessage {
  role: string
  kind: string
  content: string
  createdAt: number
}

/** 声称后台仍在推进的说法；与“稍后自动继续”同类，都不允许在没有事实时出现。 */
const BACKGROUND_CLAIM_PATTERNS: RegExp[] = [
  /(?:正在|已在)(?:后台|内部)?(?:核查|复查|核对|处理|推进|整理)/,
  /后台(?:继续)?(?:核查|复查|处理|推进|整理)/,
  /稍后(?:会)?自动(?:继续|处理|重试)/,
]

export function claimsBackgroundWork(content: string): boolean {
  return BACKGROUND_CLAIM_PATTERNS.some(pattern => pattern.test(content))
}

/** 按句子剔除没有事实支撑的后台说法；保留原意中可核对的部分。 */
export function stripUnsupportedClaims(content: string, facts: OwnerClaimFacts): { content: string; removed: string[] } {
  if (facts.pendingEvents > 0 || facts.runningExecutions > 0) return { content, removed: [] }
  const sentences = content.split(/(?<=[。！？!?\n])/).map(item => item.trim()).filter(Boolean)
  const removed: string[] = []
  const kept = sentences.filter(sentence => {
    if (!claimsBackgroundWork(sentence)) return true
    removed.push(sentence)
    return false
  })
  if (removed.length === 0) return { content, removed }
  const rest = kept.join('')
  return { content: rest.trim() ? rest : '当前没有正在进行的后台任务；具体状态以上面的记录为准。', removed }
}

/** 返回违反“说法对应事实”的消息；空数组表示当前可见说法都有事实支撑。 */
export function findOwnerClaimViolations(messages: ReadonlyArray<OwnerClaimMessage>, facts: OwnerClaimFacts): OwnerClaimMessage[] {
  const hasBackgroundWork = facts.pendingEvents > 0 || facts.runningExecutions > 0
  if (hasBackgroundWork) return []
  return messages.filter(message => message.role !== 'user' && claimsBackgroundWork(message.content))
}

export interface OwnerClaimViolationReport { violations: OwnerClaimMessage[]; facts: OwnerClaimFacts }

/** 只有这些事件代表“还会有后续后台工作”；结果类事件是当前这轮正在消费的输入，不算后台。 */
const BACKGROUND_EVENT_KINDS = ['goal_saved', 'delegation_confirmed', 'plan_confirmed', 'assignment_recheck', 'employee_interaction', 'employee_decision']

/** 运行时口径：写入消息前读取同一份事实。 */
export function readOwnerClaimFacts(projectId: string): OwnerClaimFacts {
  const { getProjectDb } = require('./project-sqlite-store') as typeof import('./project-sqlite-store')
  const db = getProjectDb()
  return {
    pendingEvents: (db.prepare(`SELECT COUNT(*) AS count FROM project_owner_management_events WHERE project_id=? AND consumed_at IS NULL
      AND json_extract(payload,'$.kind') IN (${BACKGROUND_EVENT_KINDS.map(() => '?').join(',')})`).get(projectId, ...BACKGROUND_EVENT_KINDS) as { count: number }).count,
    runningExecutions: (db.prepare("SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE project_id=? AND state='running'").get(projectId) as { count: number }).count,
    awaitingUserDecisions: (db.prepare(`SELECT COUNT(*) AS count FROM project_owner_employee_interactions
      WHERE project_id=? AND json_extract(payload,'$.state') IN ('discussing_user','pending_user')`).get(projectId) as { count: number }).count,
  }
}

/** 从权威表读取事实并检查最近消息；用于测试断言与本地自检。 */
export function auditProjectOwnerClaims(projectId: string, limit = 20): OwnerClaimViolationReport {
  const { getProjectDb } = require('./project-sqlite-store') as typeof import('./project-sqlite-store')
  const db = getProjectDb()
  const facts = readOwnerClaimFacts(projectId)
  // 只核对当前仍然生效的说法：最新一条 assistant 消息。历史说明已被后续消息替代，不重复判违规。
  const rows = db.prepare("SELECT payload FROM project_owner_management_messages WHERE project_id=? AND json_extract(payload,'$.role')='assistant' ORDER BY rowid DESC LIMIT ?").all(projectId, limit) as Array<{ payload: string }>
  const messages = rows.map(row => JSON.parse(row.payload) as OwnerClaimMessage)
  return { violations: findOwnerClaimViolations(messages.slice(0, 1), facts), facts }
}
