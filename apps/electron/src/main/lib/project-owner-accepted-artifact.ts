/**
 * 已验收成果的权威解析。
 *
 * 复用判定与上游成果交接必须同源：两者若各查各的，会出现
 * 「判定说 A 已验收、交接时又找不到那份成果」的分裂。
 *
 * 只认完整证据链：Owner 质量决定 accepted + 独立评审 approved 且成果已核验
 * + 该轮执行命令唯一 + 成果正文哈希与决定一致。任一环缺失即视为未验收，
 * 不用「任务状态是 completed」代替——那是状态，不是验收。
 */
import type { OwnerExecutionCommandRole } from '@gravitas/shared'
import type { OwnerQualityArtifact, OwnerQualityAction } from './project-owner-quality-actions'
import { readOwnerQualityActionByExecution, readOwnerQualityArtifact } from './project-owner-quality-actions'
import { listOwnerTechnicalReviewEvidence, type OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import * as store from './project-sqlite-store'

/** 一条可核验的已验收成果；内容与身份都已交叉核对。 */
export interface AcceptedArtifact {
  projectId: string
  taskId: string
  /** 冻结的步骤关联；与任务当前的 ownerStepLinkId 一致。 */
  stepLinkId: string
  /** 产出该成果的执行命令（旧授权下的）。 */
  executorCommandId: string
  reviewerCommandId: string
  ownerExecutionId: string
  artifactHash: string
  reworkOrdinal: number
  content: string
  validationEvidence?: OwnerTechnicalReviewEvidence['validationEvidence']
}

/**
 * 读取某任务「最近一次」已验收成果。
 *
 * 只扫该项目下所有质量决定里 acceptance 成功的那条；不限定 grant，
 * 因为跨批次接替时成果属于旧授权——正是这里需要跨授权读取。
 */
export function readLatestAcceptedArtifact(projectId: string, taskId: string): AcceptedArtifact | null {
  const rows = store.getProjectDb().prepare(`SELECT owner_execution_id FROM project_owner_quality_actions
    WHERE project_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC`).all(projectId, taskId) as Array<{ owner_execution_id: string }>
  for (const row of rows) {
    // 记录损坏意味着这轮的验收不可核验；不能让它把整个复用判定炸掉，
    // 也不能当作已验收——按「无证据」处理，交由上层重做该步骤。
    let action: ReturnType<typeof readOwnerQualityActionByExecution>
    try { action = readOwnerQualityActionByExecution(row.owner_execution_id) }
    catch (error) {
      console.warn(`[Owner复用] 质量决定不可核验，按未验收处理: ${row.owner_execution_id}`, error instanceof Error ? error.message : error)
      continue
    }
    if (!action || action.state !== 'accepted' || action.projectId !== projectId || action.taskId !== taskId) continue
    const resolved = resolveAcceptedArtifact(action)
    if (resolved) return resolved
  }
  return null
}

/**
 * 把一条 accepted 质量决定解析成可交接成果；证据不完整时返回 null。
 *
 * 与 `resolveUpstreamArtifactHandoffs` 的判定等价，但允许跨 grant——
 * 调用方负责校验该成果是否属于允许引用的旧批次。
 */
export function resolveAcceptedArtifact(action: OwnerQualityAction): AcceptedArtifact | null {
  if (action.state !== 'accepted') return null
  const task = store.getTask(action.taskId)
  if (!task || task.projectId !== action.projectId) return null
  const reviews = listOwnerTechnicalReviewEvidence(action.projectId, action.taskId)
  const review = reviews.find(item => item.reviewerCommandId === action.reviewerCommandId)
  // 独立评审必须与 Owner 决定绑定同一份可核验成果。
  if (!review || review.verdict !== 'approved' || review.artifactVerified !== true || review.artifactHash !== action.artifactHash) return null
  const artifact: OwnerQualityArtifact | null = readOwnerQualityArtifact(action.reviewerCommandId)
  if (!artifact || artifact.contentHash !== action.artifactHash
    || artifact.projectId !== action.projectId || artifact.taskId !== action.taskId
    || artifact.reworkOrdinal !== action.reworkOrdinal) return null
  const executor = findExecutorCommand(action.projectId, action.grantId, action.taskId, artifact.stepLinkId, artifact.reworkOrdinal)
  if (!executor) return null
  return {
    projectId: action.projectId,
    taskId: action.taskId,
    stepLinkId: artifact.stepLinkId,
    executorCommandId: executor,
    reviewerCommandId: action.reviewerCommandId,
    ownerExecutionId: action.ownerExecutionId,
    artifactHash: artifact.contentHash,
    reworkOrdinal: artifact.reworkOrdinal,
    content: artifact.content,
    ...(review.validationEvidence ? { validationEvidence: review.validationEvidence } : {}),
  }
}

/** 该轮执行命令必须唯一，否则无法确定成果由哪次运行产出。 */
function findExecutorCommand(projectId: string, grantId: string, taskId: string, stepLinkId: string, reworkOrdinal: number): string | null {
  const rows = store.getProjectDb().prepare(`SELECT id FROM project_owner_execution_commands
    WHERE project_id=? AND grant_id=? AND source_task_id=? AND source_step_link_id=? AND role=? AND rework_ordinal=? AND state='settled'`)
    .all(projectId, grantId, taskId, stepLinkId, 'executor' satisfies OwnerExecutionCommandRole, reworkOrdinal) as Array<{ id: string }>
  return rows.length === 1 ? rows[0]!.id : null
}
