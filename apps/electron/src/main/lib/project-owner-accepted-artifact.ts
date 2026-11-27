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
import type { OwnerExecutionCommandRole, OwnerManagementDeliveryItem } from '@gravitas/shared'
import type { OwnerQualityArtifact, OwnerQualityAction } from './project-owner-quality-actions'
import { readOwnerQualityActionByExecution, readOwnerQualityArtifact } from './project-owner-quality-actions'
import { listOwnerTechnicalReviewEvidence, type OwnerTechnicalReviewEvidence } from './project-owner-technical-review'
import { readOwnerCommandFrozenSource } from './project-owner-employee-runtime'
import { ownerTextDeliveryLengthViolation } from './project-owner-text-delivery'
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
  acceptanceCriteria: string[]
  ownerDecision: string
  reviewerSummary: string
  localTextRevision?: OwnerManagementDeliveryItem['localTextRevision']
  validationEvidence?: OwnerTechnicalReviewEvidence['validationEvidence']
}

/**
 * 读取某任务全部质量决定，最新在前。
 *
 * 损坏的记录保留为 `null` 占位而不是丢弃——「这一轮有过决定但不可核验」
 * 与「这一轮没有决定」是不同事实，后者才允许回看更早的记录。
 *
 * 不限定 grant：跨批次接替时成果属于旧授权，正是这里需要跨授权读取。
 */
export function listQualityDecisionsNewestFirst(projectId: string, taskId: string): Array<OwnerQualityAction | null> {
  const rows = store.getProjectDb().prepare(`SELECT owner_execution_id FROM project_owner_quality_actions
    WHERE project_id=? AND task_id=? ORDER BY created_at DESC, rowid DESC`).all(projectId, taskId) as Array<{ owner_execution_id: string }>
  return rows.map((row) => {
    try { return readOwnerQualityActionByExecution(row.owner_execution_id) }
    catch (error) {
      console.warn(`[Owner复用] 质量决定不可核验，按未验收处理: ${row.owner_execution_id}`, error instanceof Error ? error.message : error)
      return null
    }
  })
}

/**
 * 最新一条决定控制复用。
 *
 * **不回退**是这里的关键：若最新决定是返工/升级/拒绝，说明该步骤已被重新打开，
 * 更早那份「已验收」已被取代；若最新决定不可核验，也无法证明当前成果有效。
 * 两种情况下都必须判为不可复用，否则会把用户明确要求重做的成果当成最终成果。
 */
export function resolveControllingAcceptedArtifact(
  decisionsNewestFirst: ReadonlyArray<OwnerQualityAction | null>,
): AcceptedArtifact | null {
  const newest = decisionsNewestFirst[0]
  return newest ? resolveAcceptedArtifact(newest) : null
}

/** 读取某任务当前生效的已验收成果；没有决定或最新决定不可复用时返回 null。 */
export function readLatestAcceptedArtifact(projectId: string, taskId: string): AcceptedArtifact | null {
  const decision = listQualityDecisionsNewestFirst(projectId, taskId)[0]
  const artifact = decision ? resolveAcceptedArtifact(decision) : null
  if (!artifact || !decision || artifact.validationEvidence?.length) return artifact
  const source = store.getProjectDb().prepare(`SELECT g.task_id AS scope_id,l.step_key FROM project_owner_execution_grants g
    JOIN project_owner_task_step_links l ON l.project_id=g.project_id WHERE g.id=? AND l.id=?`)
    .get(decision.grantId, artifact.stepLinkId) as { scope_id: string | null; step_key: string } | undefined
  if (!source) return artifact
  const { readOwnerLocalTextRevision } = require('./project-owner-local-text-revision') as typeof import('./project-owner-local-text-revision')
  const revised = readOwnerLocalTextRevision(projectId, source.scope_id, decision.grantId, source.step_key, artifact.artifactHash)
  return revised ? { ...artifact, artifactHash: revised.artifactHash, content: revised.content, ownerDecision: revised.ownerDecision,
    reviewerSummary: revised.reviewerSummary, localTextRevision: revised.localTextRevision } : artifact
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
  if (ownerTextDeliveryLengthViolation(readOwnerCommandFrozenSource(action.reviewerCommandId).source, action.taskId, artifact.content)) return null
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
    acceptanceCriteria: review.criteria.map(item => item.criterion),
    ownerDecision: action.detail,
    reviewerSummary: review.summary,
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
