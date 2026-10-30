import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

const artifactHash = 'a'.repeat(64)
const grant = { id: 'grant-1', project_id: 'project-1', state: 'active', expires_at: Date.now() + 60_000, revalidation_id: 'revalidation-1', revalidation_revision: 3 }
const originalRows = ['executor-1', 'reviewer-1'].map(id => ({ id, state: 'settled', actual_cost_micros: 100, usage_evidence: '{"source":"provider"}', execution_id: `execution-${id}`, execution_status: 'completed', owner_command_id: id }))
let activityPayload: string | null = null
let pendingCount = 0
let qualityActionCount = 0
let taskStatus = 'paused'
let lastPendingSql = ''
const database = {
  prepare(sql: string) {
    return {
      get: (...args: unknown[]) => {
        if (sql.includes('FROM project_activities')) return activityPayload ? { payload: activityPayload } : undefined
        if (sql.includes('FROM project_owner_execution_grants')) return grant
        if (sql.includes('COUNT(*) AS count FROM project_owner_execution_commands')) { lastPendingSql = sql; return { count: pendingCount } }
        if (sql.includes('COUNT(*) AS count FROM project_owner_quality_actions')) return { count: qualityActionCount }
        throw new Error(`未登记的测试查询：${sql}；${JSON.stringify(args)}`)
      },
      all: (...args: unknown[]) => {
        if (sql.includes('FROM project_owner_execution_commands c LEFT JOIN agent_executions')) return originalRows.filter(row => args.includes(row.id))
        throw new Error(`未登记的测试查询：${sql}`)
      },
    }
  },
}
mock.module('./project-sqlite-store', () => ({
  getProjectDb: () => database,
  getTask: () => ({ projectId: 'project-1', status: taskStatus }),
  recordProjectActivity: (input: { payload?: unknown }) => { activityPayload = JSON.stringify(input.payload) },
}))
const smoke = await import('./owner-quality-revalidation-smoke')
const source = { projectId: 'project-1', taskId: 'task-1', originalOwnerExecutionId: 'owner-run-1', originalReviewerCommandId: 'reviewer-1', originalExecutorCommandId: 'executor-1', artifactHash }
const savedEnvironment = { smoke: process.env.GRAVITAS_PACKAGE_SMOKE, owner: process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID, hash: process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH }

beforeEach(() => {
  activityPayload = null
  pendingCount = 0
  qualityActionCount = 0
  taskStatus = 'paused'
  originalRows.forEach(row => { row.actual_cost_micros = 100; row.usage_evidence = '{"source":"provider"}' })
  process.env.GRAVITAS_PACKAGE_SMOKE = '1'
  process.env.GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID = 'owner-run-1'
  process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH = artifactHash
})
afterEach(() => {
  for (const [key, value] of Object.entries({ GRAVITAS_PACKAGE_SMOKE: savedEnvironment.smoke, GRAVITAS_OWNER_CHAIN_SMOKE_RECOVER_OWNER_EXECUTION_ID: savedEnvironment.owner, GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH: savedEnvironment.hash })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test('Given准确失败来源与已结算原命令 When授权复验 Then持久化单次审计许可且可幂等重读', () => {
  const permit = smoke.authorizeOwnerQualityRevalidationForSmoke(source)
  expect(permit).toMatchObject({ grantId: 'grant-1', reworkOrdinal: 1, revalidationRevision: 3, artifactHash })
  expect(activityPayload).not.toBeNull()
  expect(smoke.authorizeOwnerQualityRevalidationForSmoke(source)).toEqual(permit)
  expect(smoke.readOwnerQualityRevalidationSmokePermit({ projectId: 'project-1', taskId: 'task-1', grantId: 'grant-1', reworkOrdinal: 1 })).toEqual(permit)
  expect(lastPendingSql).toContain('AND rework_ordinal=0')
  expect(smoke.ownerQualityRevalidationSmokeInstruction(permit)).toContain('不得修改任何源码')
})

test('Given没有准确烟测绑定 When读取复验许可 Then缺失授权或环境来源均拒绝', () => {
  expect(smoke.readOwnerQualityRevalidationSmokePermit({ projectId: 'project-1', taskId: 'task-1', grantId: 'grant-1', reworkOrdinal: 1 })).toBeNull()
  expect(() => smoke.authorizeOwnerQualityRevalidationForSmoke({ ...source, originalOwnerExecutionId: 'other-run' })).toThrow('准确成果哈希')
  smoke.authorizeOwnerQualityRevalidationForSmoke(source)
  process.env.GRAVITAS_OWNER_CHAIN_SMOKE_REVALIDATE_ARTIFACT_HASH = 'b'.repeat(64)
  expect(() => smoke.readOwnerQualityRevalidationSmokePermit({ projectId: 'project-1', taskId: 'task-1', grantId: 'grant-1', reworkOrdinal: 1 })).toThrow('不匹配')
})

test('Given未知用量未决命令或已有质量决定 When授权复验 Then不得改写历史或追加许可', () => {
  originalRows[0]!.usage_evidence = '{"source":"unknown"}'
  expect(() => smoke.authorizeOwnerQualityRevalidationForSmoke(source)).toThrow('完整成功结算')
  expect(activityPayload).toBeNull()
  originalRows[0]!.usage_evidence = '{"source":"provider"}'
  pendingCount = 1
  expect(() => smoke.authorizeOwnerQualityRevalidationForSmoke(source)).toThrow('原命令全部结算')
  pendingCount = 0
  qualityActionCount = 1
  expect(() => smoke.authorizeOwnerQualityRevalidationForSmoke(source)).toThrow('尚无质量决定')
  qualityActionCount = 0
  taskStatus = 'done'
  expect(() => smoke.authorizeOwnerQualityRevalidationForSmoke(source)).toThrow('Task保持暂停')
  expect(activityPayload).toBeNull()
})

test('Given已保存许可 When命令任务授权轮次漂移 Then默认拒绝', () => {
  smoke.authorizeOwnerQualityRevalidationForSmoke(source)
  for (const input of [
    { projectId: 'project-1', taskId: 'other-task', grantId: 'grant-1', reworkOrdinal: 1 },
    { projectId: 'project-1', taskId: 'task-1', grantId: 'other-grant', reworkOrdinal: 1 },
    { projectId: 'project-1', taskId: 'task-1', grantId: 'grant-1', reworkOrdinal: 2 },
  ]) expect(() => smoke.readOwnerQualityRevalidationSmokePermit(input)).toThrow('不匹配')
})
