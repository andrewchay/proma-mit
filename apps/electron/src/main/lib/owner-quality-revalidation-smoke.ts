/** 打包烟测专用：为已明确授权的原成果追加新鲜验证，不伪造上一轮质量决定。 */
import * as store from './project-sqlite-store'

const activityAction = 'owner_quality_revalidation_smoke_authorized'

export interface OwnerQualityRevalidationSmokePermit {
  projectId: string
  taskId: string
  grantId: string
  originalOwnerExecutionId: string
  originalReviewerCommandId: string
  originalExecutorCommandId: string
  artifactHash: string
  reworkOrdinal: 1
  revalidationId: string
  revalidationRevision: number
}

interface RevalidationSource {
  projectId: string
  taskId: string
  originalOwnerExecutionId: string
  originalReviewerCommandId: string
  originalExecutorCommandId: string
  artifactHash: string
}

interface GrantRow {
  id: string
  project_id: string
  state: string
  expires_at: number
  revalidation_id: string
  revalidation_revision: number
  revalidation_integrity_hash: string
}

interface OriginalCommandRow {
  id: string
  state: string
  actual_cost_micros: number | null
  usage_evidence: string | null
  execution_id: string | null
  execution_status: string | null
  owner_command_id: string | null
}

function permitFromPayload(value: unknown): OwnerQualityRevalidationSmokePermit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Owner复验授权记录结构无效')
  const item = value as Record<string, unknown>
  const strings = ['projectId', 'taskId', 'grantId', 'originalOwnerExecutionId', 'originalReviewerCommandId', 'originalExecutorCommandId', 'revalidationId'] as const
  if (strings.some(key => typeof item[key] !== 'string' || !(item[key] as string).trim())
    || typeof item.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(item.artifactHash)
    || item.reworkOrdinal !== 1 || !Number.isSafeInteger(item.revalidationRevision) || Number(item.revalidationRevision) < 1) {
    throw new Error('Owner复验授权记录字段无效')
  }
  return item as unknown as OwnerQualityRevalidationSmokePermit
}

function readRecordedPermit(projectId: string): OwnerQualityRevalidationSmokePermit | null {
  const row = store.getProjectDb().prepare('SELECT payload FROM project_activities WHERE project_id=? AND action=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(projectId, activityAction) as { payload: string | null } | undefined
  return row?.payload ? permitFromPayload(JSON.parse(row.payload)) : null
}

function grantForReviewer(projectId: string, reviewerCommandId: string): GrantRow {
  const grant = store.getProjectDb().prepare(`SELECT g.id,g.project_id,g.state,g.expires_at,g.revalidation_id,g.revalidation_revision,g.revalidation_integrity_hash
    FROM project_owner_execution_grants g JOIN project_owner_execution_commands c ON c.grant_id=g.id
    WHERE c.id=? AND c.project_id=? AND c.role='reviewer'`).get(reviewerCommandId, projectId) as GrantRow | undefined
  if (!grant || grant.state !== 'active' || grant.expires_at <= Date.now()) throw new Error('Owner复验缺少有效的原执行授权')
  return grant
}

/** 续期只能把许可迁移到直接继任的再验证版本，旧许可与来源链均保留。 */
function isRevalidationSuccessor(projectId: string, previous: OwnerQualityRevalidationSmokePermit, grant: GrantRow): boolean {
  if (grant.revalidation_revision !== previous.revalidationRevision + 1) return false
  const previousRow = store.getProjectDb().prepare('SELECT integrity_hash FROM project_owner_execution_revalidations WHERE id=? AND project_id=? AND revision=?')
    .get(previous.revalidationId, projectId, previous.revalidationRevision) as { integrity_hash: string } | undefined
  const currentRow = store.getProjectDb().prepare('SELECT payload FROM project_owner_execution_revalidations WHERE id=? AND project_id=? AND revision=? AND integrity_hash=?')
    .get(grant.revalidation_id, projectId, grant.revalidation_revision, grant.revalidation_integrity_hash) as { payload: string } | undefined
  if (!previousRow || !currentRow) return false
  try {
    const payload = JSON.parse(currentRow.payload) as { previousIntegrityHash?: unknown }
    return payload.previousIntegrityHash === previousRow.integrity_hash
  } catch { return false }
}

function hasKnownUsage(raw: string | null): boolean {
  if (!raw) return false
  try {
    const usage = JSON.parse(raw) as { source?: unknown }
    return Boolean(usage && typeof usage === 'object' && usage.source !== 'unknown')
  } catch { return false }
}

function assertSettledOriginals(projectId: string, grantId: string, taskId: string, executorCommandId: string, reviewerCommandId: string, duringAuthorizedRound = false): void {
  const rows = store.getProjectDb().prepare(`SELECT c.id,c.state,c.actual_cost_micros,c.usage_evidence,c.execution_id,e.status AS execution_status,e.owner_command_id
    FROM project_owner_execution_commands c LEFT JOIN agent_executions e ON e.id=c.execution_id
    WHERE c.project_id=? AND c.grant_id=? AND c.source_task_id=? AND c.rework_ordinal=0 AND c.id IN (?,?) ORDER BY c.role`).all(projectId, grantId, taskId, executorCommandId, reviewerCommandId) as OriginalCommandRow[]
  if (rows.length !== 2 || rows.some(row => !row.execution_id || row.state !== 'settled' || row.actual_cost_micros === null
    || !hasKnownUsage(row.usage_evidence) || row.execution_status !== 'completed' || row.owner_command_id !== row.id)) {
    throw new Error('Owner复验的原Executor/Reviewer没有完整成功结算')
  }
  const originalRoundOnly = duringAuthorizedRound ? ' AND rework_ordinal=0' : ''
  const pending = store.getProjectDb().prepare(`SELECT COUNT(*) AS count FROM project_owner_execution_commands WHERE grant_id=? AND (state NOT IN ('settled','released') OR actual_cost_micros IS NULL OR usage_evidence IS NULL)${originalRoundOnly}`).get(grantId) as { count: number }
  const actions = store.getProjectDb().prepare('SELECT COUNT(*) AS count FROM project_owner_quality_actions WHERE project_id=? AND grant_id=? AND task_id=?').get(projectId, grantId, taskId) as { count: number }
  const task = store.getTask(taskId)
  if (pending.count !== 0 || actions.count !== 0 || !task || task.projectId !== projectId || task.status !== 'paused') throw new Error('Owner复验要求原命令全部结算、尚无质量决定且Task保持暂停')
}

/** 创建一次可审计许可；只有恢复服务核验过失败Owner回执后才能调用。 */
export function authorizeOwnerQualityRevalidationForSmoke(input: RevalidationSource): OwnerQualityRevalidationSmokePermit {
  if (process.env.GRAVITAS_PACKAGE_SMOKE !== '1'
    || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID !== input.originalOwnerExecutionId
    || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH !== input.artifactHash) {
    throw new Error('Owner成果复验必须由打包烟测绑定原失败执行和准确成果哈希')
  }
  const grant = grantForReviewer(input.projectId, input.originalReviewerCommandId)
  assertSettledOriginals(input.projectId, grant.id, input.taskId, input.originalExecutorCommandId, input.originalReviewerCommandId)
  const permit: OwnerQualityRevalidationSmokePermit = { ...input, grantId: grant.id, reworkOrdinal: 1, revalidationId: grant.revalidation_id, revalidationRevision: grant.revalidation_revision }
  const previous = readRecordedPermit(input.projectId)
  if (previous) {
    const keys = Object.keys(permit) as Array<keyof OwnerQualityRevalidationSmokePermit>
    const sameSource = keys.filter(key => key !== 'revalidationId' && key !== 'revalidationRevision').every(key => previous[key] === permit[key])
    if (!sameSource) throw new Error('Owner复验授权已经绑定其他来源，不覆盖原记录')
    if (previous.revalidationId === permit.revalidationId && previous.revalidationRevision === permit.revalidationRevision) return previous
    if (!isRevalidationSuccessor(input.projectId, previous, grant)) throw new Error('Owner复验许可只能迁移到可核验的直接继任再验证版本')
  }
  store.recordProjectActivity({ projectId: input.projectId, entityType: 'task', entityId: input.taskId, action: activityAction, actor: 'local-user',
    summary: '用户明确授权保留原成果追加新鲜验证与独立评审；不补造上一轮质量决定，成果变化即停止。',
    payload: { projectId: permit.projectId, taskId: permit.taskId, grantId: permit.grantId,
      originalOwnerExecutionId: permit.originalOwnerExecutionId, originalReviewerCommandId: permit.originalReviewerCommandId,
      originalExecutorCommandId: permit.originalExecutorCommandId, artifactHash: permit.artifactHash,
      reworkOrdinal: permit.reworkOrdinal, revalidationId: permit.revalidationId, revalidationRevision: permit.revalidationRevision } })
  return permit
}

/** 通用命令/快照服务只接受数据库中准确匹配且当前仍有效的烟测许可。 */
export function readOwnerQualityRevalidationSmokePermit(input: { projectId: string; taskId: string; grantId: string; reworkOrdinal: number }): OwnerQualityRevalidationSmokePermit | null {
  const permit = readRecordedPermit(input.projectId)
  if (!permit) return null
  const grant = grantForReviewer(input.projectId, permit.originalReviewerCommandId)
  if (permit.taskId !== input.taskId || permit.grantId !== input.grantId || permit.reworkOrdinal !== input.reworkOrdinal
    || grant.id !== input.grantId || grant.revalidation_id !== permit.revalidationId || grant.revalidation_revision !== permit.revalidationRevision
    || process.env.GRAVITAS_PACKAGE_SMOKE !== '1'
    || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID !== permit.originalOwnerExecutionId
    || process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH !== permit.artifactHash) {
    throw new Error('Owner复验许可与当前命令、执行授权或烟测来源不匹配')
  }
  assertSettledOriginals(input.projectId, input.grantId, input.taskId, permit.originalExecutorCommandId, permit.originalReviewerCommandId, true)
  return permit
}

export function ownerQualityRevalidationSmokeInstruction(permit: OwnerQualityRevalidationSmokePermit | null): string {
  if (!permit) return ''
  return `\n\n本轮是经本机用户明确授权的独立复验，只因上一验证证据过期而刷新证据。不得修改任何源码、配置或成果；请无损复核已交接的准确成果，并实际运行冻结验证命令后给出结果。原成果哈希=${permit.artifactHash}；不得自行声明哈希一致，主进程会独立比对。不要返工、扩大范围、改任务状态或接受交付。`
}
