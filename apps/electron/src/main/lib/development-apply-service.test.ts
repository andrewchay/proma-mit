/**
 * M3 / W08：确认应用服务 BDD。
 * T20 漂移拒绝、T22 字节级应用、T23 恢复分类、T24 完成闸门、T29 幂等。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-apply-'))
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
const apply = await import('./development-apply-service')

beforeAll(async () => {
  await store.initProjectDb()
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
  repo: string
  taskId: string
  executionId: string
  worktreePath: string
}

function fixture(): World {
  const repo = join(directory, `repo-${randomUUID().slice(0, 8)}`); mkdirSync(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'original\n')
  writeFileSync(join(repo, 'src', 'old.ts'), 'to-delete\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline')

  const workspace = createAgentWorkspace(`apply-${randomUUID().slice(0, 6)}`, repo)
  const channel = createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = service.createAgentEmployee({ name: '研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi' })
  const project = store.createProject({ title: '应用闭环', description: '' })
  const decision = chainService.updateProjectChain(project.id, 0, { kind: 'decision', title: '修复方向', rationale: '最小增量', evidence: 'issue#1' })

  const session = sessionManager.createAgentSession('应用测试', channel.id, workspace.id)
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, session.id)
  const executionId = `exec-${randomUUID()}`
  const worktree = createDevelopmentWorktree(repo, sessionDirectory, executionId)
  // 修改 + 新增 + 删除，覆盖三种变更类型
  writeFileSync(join(worktree.path, 'src', 'a.ts'), 'fixed\n')
  writeFileSync(join(worktree.path, 'src', 'new.ts'), 'brand-new\n')
  rmSync(join(worktree.path, 'src', 'old.ts'))

  const task = store.createTask(project.id, {
    title: '应用闭环', description: '',
    developmentScope: {
      workspaceId: workspace.id, targetPaths: ['src/a.ts'], allowedPaths: ['src'],
      reviewerId: 'local-user', decisionIds: [decision.decisions[0]!.id],
    },
    assignee: { userId: `agent-${employee.id}`, displayName: employee.name },
  })
  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: session.id, prompt: 'p' })
  store.updateAgentExecution(executionId, { status: 'completed', resultSummary: 'done', completedAt: Date.now() })
  return { repo, taskId: task.id, executionId, worktreePath: worktree.path }
}

function acceptLatestDelivery(w: World): void {
  submitDevelopmentDelivery(w.executionId)
  const projectId = store.getTask(w.taskId)!.projectId
  const chain = chainService.getProjectChain(projectId)
  const draft = chain.drafts.find((item) => item.executionId === w.executionId)!
  chainService.updateProjectChain(projectId, chain.revision, { kind: 'accept', draftId: draft.id, comment: '通过', evidence: 'diff 核对', completedCriteria: [] })
}

describe('确认应用（T20/T22/T24）', () => {
  test('Given 已验收交付与干净仓库 When prepare+confirm Then 字节级写入且无 commit', async () => {
    const w = fixture()
    acceptLatestDelivery(w)
    const manifest = apply.prepareApply(w.taskId)
    expect(manifest.files.map((f) => `${f.path}:${f.changeType}`).sort()).toEqual(['src/a.ts:modify', 'src/new.ts:add', 'src/old.ts:delete'].sort())

    const headBefore = git(w.repo, 'rev-parse', 'HEAD')
    const result = await apply.confirmApply(manifest.operationId)
    expect(result.status).toBe('applied')
    expect(readFileSync(join(w.repo, 'src', 'a.ts'), 'utf8')).toBe('fixed\n')
    expect(readFileSync(join(w.repo, 'src', 'new.ts'), 'utf8')).toBe('brand-new\n')
    expect(() => readFileSync(join(w.repo, 'src', 'old.ts'))).toThrow()
    // 无 commit / 无 push：HEAD 不变，改动为未提交
    expect(git(w.repo, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(w.repo, 'status', '--porcelain').split('\n').filter(Boolean).length).toBe(3)
    expect(git(w.repo, 'diff', '--cached', '--name-only')).toBe('')

    // T24：无 DoD 时任务自动完成
    expect(result.taskCompleted).toBe(true)
    expect(store.getTask(w.taskId)!.status).toBe('completed')
  })

  test('Given 未验收交付 When prepare Then 拒绝', () => {
    const w = fixture()
    submitDevelopmentDelivery(w.executionId)
    expect(() => apply.prepareApply(w.taskId)).toThrow('人工验收')
  })

  test('Given 验收后源仓库 HEAD 漂移 When prepare Then 拒绝且不改仓库（T20/R03）', () => {
    const w = fixture()
    acceptLatestDelivery(w)
    writeFileSync(join(w.repo, 'drift.txt'), 'user change\n')
    git(w.repo, 'add', '.')
    expect(() => apply.prepareApply(w.taskId)).toThrow('未提交改动')
    rmSync(join(w.repo, 'drift.txt'))
    // 提交式漂移：HEAD 变化
    writeFileSync(join(w.repo, 'drift2.txt'), 'x\n'); git(w.repo, 'add', '.'); git(w.repo, 'commit', '-m', 'user commit')
    expect(() => apply.prepareApply(w.taskId)).toThrow('偏离交付基线')
  })

  test('Given prepare 与 confirm 之间源仓库被改 When confirm Then 拒绝过期确认单（T21）', async () => {
    const w = fixture()
    acceptLatestDelivery(w)
    const manifest = apply.prepareApply(w.taskId)
    writeFileSync(join(w.repo, 'late.txt'), 'late\n')
    await expect(apply.confirmApply(manifest.operationId)).rejects.toThrow('未提交改动')
    // 操作记录标记 blocked，未写入任何目标文件
    expect(readFileSync(join(w.repo, 'src', 'a.ts'), 'utf8')).toBe('original\n')
    const status = apply.getApplyStatus(w.taskId)
    expect(status.latest!.status).toBe('blocked')
  })

  test('Given 重复确认 When confirm Then 幂等不重复应用（T29）', async () => {
    const w = fixture()
    acceptLatestDelivery(w)
    const manifest = apply.prepareApply(w.taskId)
    await apply.confirmApply(manifest.operationId)
    const head = git(w.repo, 'rev-parse', 'HEAD')
    const second = await apply.confirmApply(manifest.operationId)
    expect(second.status).toBe('applied')
    expect(git(w.repo, 'rev-parse', 'HEAD')).toBe(head)
  })

  test('Given applying 中断 When 重开查询 Then 按文件状态分类恢复（T23）', async () => {
    const w = fixture()
    acceptLatestDelivery(w)
    const manifest = apply.prepareApply(w.taskId)
    const status = apply.getApplyStatus(w.taskId)
    expect(status.confirmable).toBe(true)
    // 模拟中断：状态置 applying 且仅 modify 已写入（new/old 未处理 → 混合态）
    writeFileSync(join(w.repo, 'src', 'a.ts'), 'fixed\n')
    store.getProjectDb().prepare("UPDATE development_apply_operations SET status = 'applying' WHERE id = ?").run(manifest.operationId)
    const after = apply.getApplyStatus(w.taskId)
    expect(after.latest!.status).toBe('recovery_required')
    expect(after.recoveryFiles?.map((f) => f.path).sort()).toEqual(['src/new.ts', 'src/old.ts'])
    // 混合态禁止确认
    await expect(apply.confirmApply(manifest.operationId)).rejects.toThrow('恢复')
  })

  test('Given DoD 未满足 When 应用后完成任务 Then 保留应用但任务不伪标完成（T24）', async () => {
    const w = fixture()
    acceptLatestDelivery(w)
    // 配置项目 DoD，但交付验收未逐项满足 → assertTaskCompletionAllowed 拒绝
    const projectId = store.getTask(w.taskId)!.projectId
    chainService.updateProjectChain(projectId, chainService.getProjectChain(projectId).revision, { kind: 'set_project_dod', criteria: ['外部依据核对'] })
    const manifest = apply.prepareApply(w.taskId)
    const result = await apply.confirmApply(manifest.operationId)
    expect(result.status).toBe('applied')
    expect(result.taskCompleted).toBe(false)
    expect(result.taskError).toBeTruthy()
    expect(store.getTask(w.taskId)!.status).not.toBe('completed')
    // 文件已应用的事实保持
    expect(readFileSync(join(w.repo, 'src', 'a.ts'), 'utf8')).toBe('fixed\n')
  })
})
