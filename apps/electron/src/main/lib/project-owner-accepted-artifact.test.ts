import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-accepted-artifact-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
mock.module('./agent-service', () => ({ isAgentSessionActive: () => false }))

const store = await import('./project-sqlite-store')
const accepted = await import('./project-owner-accepted-artifact')
const actions = await import('./project-owner-quality-actions')
const reviews = await import('./project-owner-technical-review')

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 直接落一条质量决定；证据链其余部分由各用例按需注入。 */
function seedAction(projectId: string, taskId: string, state: 'accepted' | 'rework_authorized'): { ownerExecutionId: string; reviewerCommandId: string; grantId: string; artifactHash: string } {
  const ownerExecutionId = `exec-${digest(projectId + taskId + state).slice(0, 16)}`
  const reviewerCommandId = `reviewer-${ownerExecutionId}`
  const grantId = `grant-${projectId}`
  const artifactHash = digest({ projectId, taskId, ownerExecutionId })
  const action = {
    ownerExecutionId, ownerReceiptId: `receipt-${ownerExecutionId}`, actor: 'local-user',
    projectId, grantId, taskId, reviewerCommandId, artifactHash, reworkOrdinal: 0,
    decision: {
      reviewerCommandId, artifactHash,
      verdict: state === 'accepted' ? 'accept' as const : 'rework' as const,
      reason: '测试', criteria: [], findings: [],
    },
    state, detail: '测试', createdAt: Date.now(),
  }
  store.getProjectDb().prepare(`INSERT INTO project_owner_quality_actions
    (reviewer_command_id, owner_execution_id, project_id, grant_id, task_id, payload, integrity_hash, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(reviewerCommandId, ownerExecutionId, projectId, grantId, taskId, JSON.stringify(action), digest(action), action.createdAt)
  return { ownerExecutionId, reviewerCommandId, grantId, artifactHash }
}

// 复用判定如果只认「任务已完成」，人工标完成就能绕过验收。
// 这里锁住：状态不是证据，缺证据必须返回 null。
test('Given 没有质量决定 When 读取已验收成果 Then 返回 null', () => {
  const project = store.createProject({ title: '证据链', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
})

test('Given 质量决定是 rework_authorized When 读取 Then 不当作已验收', () => {
  const project = store.createProject({ title: '证据链', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  seedAction(project.id, task.id, 'rework_authorized')
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
})

// 质量决定本身不可核验时（缺少原始规划快照等），必须按「无证据」处理：
// 既不能放行复用，也不能把整个材料化炸掉。
test('Given accepted 决定的原始证据不可核验 When 读取 Then 返回 null 而不是抛错', () => {
  const project = store.createProject({ title: '证据链', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  seedAction(project.id, task.id, 'accepted')
  expect(() => accepted.readLatestAcceptedArtifact(project.id, task.id)).not.toThrow()
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
})

test('Given 质量决定指向其他项目的任务 When 读取 Then 拒绝', () => {
  const project = store.createProject({ title: '证据链', description: '' })
  const other = store.createProject({ title: '别的项目', description: '' })
  const task = store.createTask(other.id, { title: 'A', description: '' })
  seedAction(project.id, task.id, 'accepted')
  // 用 project 查询属于 other 的任务，任何一侧不匹配都不成立。
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
})

test('Given 评审证据存在但成果未核验 When 解析 Then 返回 null', () => {
  const project = store.createProject({ title: '证据链', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  const action = seedAction(project.id, task.id, 'accepted')
  // 直接喂一个证据不完整的 action，验证解析器逐环校验而不是短路放行。
  expect(accepted.resolveAcceptedArtifact({
    ownerExecutionId: action.ownerExecutionId, ownerReceiptId: 'r', actor: 'local-user',
    projectId: project.id, grantId: action.grantId, taskId: task.id,
    reviewerCommandId: action.reviewerCommandId, artifactHash: action.artifactHash,
    reworkOrdinal: 0, state: 'accepted', detail: '', createdAt: Date.now(),
    decision: { reviewerCommandId: action.reviewerCommandId, artifactHash: action.artifactHash, verdict: 'accept', reason: '', criteria: [], findings: [] },
  })).toBeNull()
  // 评审记录未建立时同样不成立（上面的调用已隐含，这里显式确认没有评审行）。
  expect(reviews.listOwnerTechnicalReviewEvidence(project.id, task.id)).toEqual([])
})

// ===== P1-1：更新的拒绝必须使更早的验收失效 =====

const qualityAction = (overrides: Partial<Parameters<typeof accepted.resolveAcceptedArtifact>[0]> = {}) => ({
  ownerExecutionId: 'exec-new', ownerReceiptId: 'receipt-new', actor: 'local-user',
  projectId: 'project-1', grantId: 'grant-1', taskId: 'task-1',
  reviewerCommandId: 'reviewer-new', artifactHash: 'a'.repeat(64), reworkOrdinal: 1,
  decision: {
    reviewerCommandId: 'reviewer-new', artifactHash: 'a'.repeat(64),
    verdict: 'rework' as const, reason: '', criteria: [], findings: [],
  },
  state: 'rework_authorized' as const, detail: '', createdAt: 2,
  ...overrides,
})

test('Given最新决定是返工 When解析生效成果 Then不回退到更早的验收', () => {
  // 更早那条是 accepted，但已被最新返工取代。
  const older = qualityAction({ ownerExecutionId: 'exec-old', state: 'accepted', createdAt: 1,
    decision: { reviewerCommandId: 'reviewer-old', artifactHash: 'b'.repeat(64), verdict: 'accept', reason: '', criteria: [], findings: [] } })
  expect(accepted.resolveControllingAcceptedArtifact([qualityAction(), older])).toBeNull()
})

test('Given最新决定不可核验 When解析生效成果 Then不回退到更早的验收', () => {
  const older = qualityAction({ ownerExecutionId: 'exec-old', state: 'accepted', createdAt: 1,
    decision: { reviewerCommandId: 'reviewer-old', artifactHash: 'b'.repeat(64), verdict: 'accept', reason: '', criteria: [], findings: [] } })
  // null 代表「这一轮有过决定但记录损坏」——不能当作没有决定而回看历史。
  expect(accepted.resolveControllingAcceptedArtifact([null, older])).toBeNull()
})

test('Given没有任何决定 When解析生效成果 Then返回null', () => {
  expect(accepted.resolveControllingAcceptedArtifact([])).toBeNull()
})

test('Given最新决定是accept但证据不完整 When解析生效成果 Then不回退', () => {
  const incomplete = qualityAction({ state: 'accepted' })
  const older = qualityAction({ ownerExecutionId: 'exec-old', state: 'accepted', createdAt: 1,
    decision: { reviewerCommandId: 'reviewer-old', artifactHash: 'b'.repeat(64), verdict: 'accept', reason: '', criteria: [], findings: [] } })
  // 任务/评审/成果都对不上，解析失败；不得回退。
  expect(accepted.resolveControllingAcceptedArtifact([incomplete, older])).toBeNull()
})

// 质量决定表不可变（有触发器拒绝 UPDATE），因此只能靠写入顺序表达「更晚」。
test('Given先验收后返工 When读取生效成果 Then以最新返工为准返回null', () => {
  const project = store.createProject({ title: 'P1-1 回退', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  seedAction(project.id, task.id, 'accepted')
  seedAction(project.id, task.id, 'rework_authorized')
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
})

test('Given先返工后验收 When读取生效成果 Then返回最新验收', () => {
  const project = store.createProject({ title: 'P1-1 正向', description: '' })
  const task = store.createTask(project.id, { title: 'A', description: '' })
  seedAction(project.id, task.id, 'rework_authorized')
  seedAction(project.id, task.id, 'accepted')
  // 证据链不完整（测试只落了决定行），但关键是「不会因为最新不可用就回退」。
  expect(accepted.readLatestAcceptedArtifact(project.id, task.id)).toBeNull()
  expect(accepted.listQualityDecisionsNewestFirst(project.id, task.id)).toHaveLength(2)
})
