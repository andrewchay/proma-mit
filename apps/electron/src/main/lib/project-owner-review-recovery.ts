import { ownerDevelopmentArtifactFromPrompt } from './project-owner-development-artifact'
import { containsOwnerValidationEvidenceQuote } from './development-validation-acceptance'
/** 从已结算运行核对原评审及冻结证据，不重发模型请求。 */
import { getAgentSessionSDKMessages } from './agent-session-manager'
import { getOwnerManagementMessage, appendOwnerManagementMessage } from './project-owner-management-store'
import { assertOwnerReviewerTextDelivery } from './project-owner-text-delivery'
import { recordOwnerTechnicalReviewEvidence, normalizeOwnerTechnicalReviewQuotes, normalizeOwnerTechnicalReviewReceipt, unwrapReviewReceipt } from './project-owner-technical-review'
import * as store from './project-sqlite-store'

export function recoverOwnerReviewEvidence(projectId: string, grantId: string, taskId: string, round: number): boolean {
  const db = store.getProjectDb()
  const rows = db.prepare(`SELECT c.id, c.execution_id, e.session_id, e.result_summary, e.prompt FROM project_owner_execution_commands c
    JOIN agent_executions e ON e.id=c.execution_id AND e.owner_command_id=c.id AND e.project_id=c.project_id
    WHERE c.project_id=? AND c.grant_id=? AND c.source_task_id=? AND c.role='reviewer' AND c.rework_ordinal=?
      AND c.state='settled' AND c.actual_cost_micros IS NOT NULL AND c.usage_evidence IS NOT NULL AND e.status='completed'`).all(projectId, grantId, taskId, round) as Array<{ id: string; execution_id: string; session_id: string; result_summary: string | null; prompt: string }>
  if (rows.length !== 1 || !rows[0]!.session_id) return false
  const row = rows[0]!
  if (db.prepare('SELECT 1 FROM project_owner_technical_reviews WHERE reviewer_command_id=?').get(row.id)
    || db.prepare('SELECT 1 FROM project_owner_quality_actions WHERE reviewer_command_id=?').get(row.id)) return false
  const rejection = db.prepare('SELECT id FROM project_owner_management_messages WHERE project_id=? AND event_id=?').get(projectId, `owner-review-evidence-rejected:${row.id}:${row.execution_id}`) as { id: string } | undefined
  if (!rejection) return false
  const message = getOwnerManagementMessage(projectId, rejection.id)
  if (!message || message.kind !== 'attention') return false
  const invalidJson = message.content.includes('原因：技术评审回执不是严格 JSON。')
  if (!invalidJson && !message.content.includes('技术评审原文依据与完整成果不匹配')) return false
  const messages = getAgentSessionSDKMessages(row.session_id)
  const last = messages.at(-1)
  if (!last || last.type !== 'result' || last.subtype !== 'success' || last.session_id !== row.session_id) return false
  const assistant = messages.findLast(item => item.type === 'assistant')
  if (!assistant || assistant.type !== 'assistant' || !assistant.message || typeof assistant.message !== 'object' || !('content' in assistant.message)) return false
  const content: unknown = assistant.message.content
  if (!Array.isArray(content) || content.length !== 1 || !content[0] || typeof content[0] !== 'object'
    || content[0].type !== 'text' || typeof content[0].text !== 'string') return false
  const raw: string = content[0].text
  // SQLite 终态摘要必须完整等于会话原文；截断或被修改的会话不能用于恢复。
  if (raw !== row.result_summary) return false
  const development = ownerDevelopmentArtifactFromPrompt(row.prompt)
  if (invalidJson) {
    if (!development || last.finish_reason !== 'stop') return false
    const repaired = normalizeOwnerTechnicalReviewReceipt(raw, development.content, development.validationEvidence, { prompt: row.prompt, hash: development.contentHash })
    if (repaired === unwrapReviewReceipt(raw)) return false
    try { JSON.parse(repaired) } catch { return false }
    recordOwnerTechnicalReviewEvidence(row.id, row.execution_id, raw)
    appendOwnerManagementMessage({ projectId, taskId, eventId: `owner-review-json-recovered:${row.id}:${row.execution_id}`,
      role: 'assistant', kind: 'management_progress', content: '已核对原评审的文件路径引文和冻结成果，恢复评审记录，无需重新运行评审。' })
    return true
  } else if (development) {
    const receipt = unwrapReviewReceipt(raw)
    const normalized = normalizeOwnerTechnicalReviewQuotes(receipt, development.content, development.validationEvidence)
    if (normalized === receipt) {
      let response: { criteria?: Array<{ status?: unknown; quote?: unknown }> } | null
      try { response = JSON.parse(receipt) } catch { return false }
      if (!Array.isArray(response?.criteria) || !response.criteria.some(item => item?.status === 'met' && typeof item.quote === 'string'
        && containsOwnerValidationEvidenceQuote(development.validationEvidence, item.quote))) return false
    }
    recordOwnerTechnicalReviewEvidence(row.id, row.execution_id, raw)
    appendOwnerManagementMessage({ projectId, taskId, eventId: `owner-review-runtime-quote-recovered:${row.id}:${row.execution_id}`, role: 'assistant', kind: 'management_progress', content: '已从原回执和冻结成果恢复独立评审记录，保留未验证的标准。Owner 将根据现有证据继续判断。' })
    return true
  }
  const artifact = assertOwnerReviewerTextDelivery(row.id)
  if (!artifact) return false
  let original: unknown, corrected: unknown
  try { original = JSON.parse(raw); corrected = JSON.parse(normalizeOwnerTechnicalReviewQuotes(raw, artifact.content)) } catch { return false }
  if (!original || !corrected || typeof original !== 'object' || typeof corrected !== 'object') return false
  const before = original as { criteria?: Array<{ quote?: unknown }> }, after = corrected as { criteria?: Array<{ quote?: unknown }> }
  if (!Array.isArray(before.criteria) || !Array.isArray(after.criteria) || before.criteria.length !== after.criteria.length) return false
  let changed = false
  for (let i = 0; i < before.criteria.length; i++) {
    const oldQuote = before.criteria[i]?.quote, newQuote = after.criteria[i]?.quote
    if (oldQuote === newQuote) continue
    if (typeof oldQuote !== 'string' || typeof newQuote !== 'string') return false
    changed = true
  }
  if (!changed) return false
  recordOwnerTechnicalReviewEvidence(row.id, row.execution_id, raw)
  appendOwnerManagementMessage({ projectId, taskId, eventId: `owner-review-typography-recovered:${row.id}:${row.execution_id}`, role: 'assistant', kind: 'management_progress', content: '已从原评审和冻结成果中核对引号排版差异，恢复逐字依据并保留原回执；无需重新运行评审。Owner 将继续判断成果。' })
  return true
}
