/**
 * M2：研发 Review 服务的 BDD 契约（T02 关联、T12 幂等返工、验收/退回责任边界、快照 Diff 读取）。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-review-'))
const originalConfig = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = join(directory, 'config')
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { getAgentSessionWorkspacePath } = await import('./config-paths')
const sessionManager = await import('./agent-session-manager')
const { createChannel } = await import('./channel-manager')
const service = await import('./agent-employee-service')
const { createDevelopmentWorktree } = await import('./agent-development-worktree')
const chainService = await import('./project-chain-service')
const { submitDevelopmentDelivery } = await import('./development-delivery-service')
const review = await import('./development-review-service')

beforeAll(async () => {
  await store.initProjectDb()
  // 确定性运行器：立即返回不触发回调，使执行停在 running（供幂等断言）
  const { setHeadlessAgentRunner } = await import('./agent-headless-runner-registry')
  setHeadlessAgentRunner(async () => {})
  // 追加一名非本机验收人，验证 local-user 不能代验收
  const identity = await import('./workflow-identity-service')
  const dir = identity.getWorkflowIdentityDirectory()
  if (!dir.users.some((user) => user.id === 'reviewer-1')) {
    identity.saveWorkflowIdentityDirectory({ ...dir, users: [...dir.users, { id: 'reviewer-1', displayName: '验收人一', roleIds: [], enabled: true }] })
  }
})
afterAll(() => {
  service.stopAgentEmployeeHeartbeat()
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

interface World {
  projectId: string
  taskId: string
  executionId: string
  employeeId: string
  worktreePath: string
  sessionDirectory: string
  sessionId: string
  decisionId: string
}

function fixture(options: { reviewerId?: string } = {}): World {
  const repo = join(directory, `repo-${randomUUID().slice(0, 8)}`); mkdirSync(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'original\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline')

  const workspace = createAgentWorkspace(`review-${randomUUID().slice(0, 6)}`, repo)
  const channel = createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = service.createAgentEmployee({ name: '研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi' })
  const project = store.createProject({ title: 'Review 闭环', description: '' })
  const decision = chainService.updateProjectChain(project.id, 0, { kind: 'decision', title: '修复方向', rationale: '最小增量', evidence: 'issue#1' })

  const session = sessionManager.createAgentSession('Review 测试', channel.id, workspace.id)
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, session.id)
  const executionId = `exec-${randomUUID()}`
  const worktree = createDevelopmentWorktree(repo, sessionDirectory, executionId)
  writeFileSync(join(worktree.path, 'src', 'a.ts'), 'fixed\n')

  const task = store.createTask(project.id, {
    title: '修复 a.ts', description: '',
    developmentScope: {
      workspaceId: workspace.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'],
      reviewerId: options.reviewerId ?? 'local-user', decisionIds: [decision.decisions[0]!.id],
      verificationCommands: ['bun test'],
    },
    assignee: { userId: `agent-${employee.id}`, displayName: employee.name },
  })
  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: session.id, prompt: 'p' })
  store.updateAgentExecution(executionId, { status: 'completed', resultSummary: '已修复', completedAt: Date.now() })
  return { projectId: project.id, taskId: task.id, executionId, employeeId: employee.id, worktreePath: worktree.path, sessionDirectory, sessionId: session.id, decisionId: decision.decisions[0]!.id }
}

describe('Review 汇总与快照 Diff（T10 数据层）', () => {
  test('Given 已交付任务 When 读取 Review Then 含范围、执行记录与交付版本', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    const summary = await review.getTaskReview(w.taskId)
    expect(summary.scope?.targetPaths).toEqual(['src/a.ts'])
    expect(summary.reviewerId).toBe('local-user')
    expect(summary.executions.length).toBeGreaterThanOrEqual(1)
    expect(summary.deliveries[0]!.status).toBe('submitted')
    expect(summary.decidedDecisions.length).toBe(1)
  })

  test('Given 冻结快照 When 读取 Diff Then 返回新旧内容且不读 live worktree', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    // 快照冻结后继续改 live worktree：Diff 必须仍显示冻结内容
    writeFileSync(join(w.worktreePath, 'src', 'a.ts'), 'LATER CHANGE\n')
    const diff = review.getSnapshotDiff(w.executionId, 'src/a.ts')
    expect(diff.changeType).toBe('modify')
    expect(diff.oldContent).toBe('original\n')
    expect(diff.newContent).toBe('fixed\n')
    expect(() => review.getSnapshotDiff(w.executionId, 'src/nope.ts')).toThrow('没有该文件')
  })
})

describe('文件委派准备（T01/T02/T15）', () => {
  test('Given 关联已有任务 When 准备委派 Then 保留原 taskId 不复制', async () => {
    const w = fixture()
    const result = await review.prepareFileDelegation({
      projectId: w.projectId, workspaceId: store.getTask(w.taskId)!.developmentScope!.workspaceId,
      employeeId: w.employeeId, targetPaths: ['src/a.ts'], allowedPaths: ['src'],
      decisionIds: [w.decisionId], reviewerId: 'local-user',
      existingTaskId: w.taskId,
    })
    expect(result).toEqual({ taskId: w.taskId, created: false })
    expect(store.listTasks(w.projectId).filter((task) => task.title.includes('a.ts'))).toHaveLength(1)
  })

  test('Given 缺决策/员工范围外工作区/伪造决策 When 准备 Then 拒绝（T15）', async () => {
    const w = fixture()
    const workspaceId = store.getTask(w.taskId)!.developmentScope!.workspaceId
    await expect(review.prepareFileDelegation({
      projectId: w.projectId, workspaceId, employeeId: w.employeeId,
      targetPaths: ['src/a.ts'], allowedPaths: ['src'], decisionIds: [],
      newTask: { title: 'x' },
    })).rejects.toThrow('真实决策')
    await expect(review.prepareFileDelegation({
      projectId: w.projectId, workspaceId, employeeId: w.employeeId,
      targetPaths: ['src/a.ts'], allowedPaths: ['src'], decisionIds: ['ghost'],
      newTask: { title: 'x' },
    })).rejects.toThrow('不存在')
    await expect(review.prepareFileDelegation({
      projectId: w.projectId, workspaceId: 'ws-other', employeeId: w.employeeId,
      targetPaths: ['src/a.ts'], allowedPaths: ['src'], decisionIds: ['d1'],
      newTask: { title: 'x' },
    })).rejects.toThrow('可用范围')
  })
})

describe('验收 / 退回 / 返工（T12）', () => {
  test('Given 非本机验收人 When local-user 验收 Then 拒绝代验收', async () => {
    const w = fixture({ reviewerId: 'reviewer-1' })
    submitDevelopmentDelivery(w.executionId)
    const summary = await review.getTaskReview(w.taskId)
    expect(summary.reviewerId).toBe('reviewer-1')
    const delivery = summary.deliveries[0]!
    await expect(review.acceptDelivery(w.taskId, delivery.id, { evidence: '代办' })).rejects.toThrow('不能代为验收')
    await expect(review.rejectDelivery(w.taskId, delivery.id, '代办退回')).rejects.toThrow('不能代为退回')
  })

  test('Given 已交付任务 When 退回意见 Then 幂等返工沿用任务且不重复派发（T12）', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    const first = await review.requestChanges(w.taskId, '请补充边界测试')
    expect(first).not.toBeNull()
    const afterFirst = store.getTask(w.taskId)!
    expect(afterFirst.status).toBe('pending')
    expect(afterFirst.completionNotes).toBe('请补充边界测试')

    // 已有 queued/running 执行时再次退回：意见保存、不重复派发
    const second = await review.requestChanges(w.taskId, '再补充')
    expect(second).toBeNull()
    expect(store.getTask(w.taskId)!.completionNotes).toBe('再补充')

    // 空意见拒绝
    await expect(review.requestChanges(w.taskId, '   ')).rejects.toThrow('返工意见')
  })

  test('Given 空证据 When 验收通过 Then 拒绝', async () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    const summary = await review.getTaskReview(w.taskId)
    await expect(review.acceptDelivery(w.taskId, summary.deliveries[0]!.id, { evidence: '  ' })).rejects.toThrow('依据')
  })
})
