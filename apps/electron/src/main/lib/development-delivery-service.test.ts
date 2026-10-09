/**
 * W03：受限员工交付服务的 BDD 契约（T13/T17/T18/T19 + 快照衔接）。
 * 使用临时真实 Git 仓库、worktree 与项目链路；运行器不调用真实模型。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-rd-delivery-'))
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
const { applyChainCommand, emptyProjectChain } = await import('./project-chain')
const chainService = await import('./project-chain-service')
const identity = await import('./workflow-identity-service')
const { submitDevelopmentDelivery, shouldSubmitDevelopmentDelivery } = await import('./development-delivery-service')

beforeAll(async () => {
  await store.initProjectDb()
  // 追加一名非本地验收人，用于 T13 责任隔离断言
  const dir = identity.getWorkflowIdentityDirectory()
  if (!dir.users.some((user) => user.id === 'reviewer-1')) {
    identity.saveWorkflowIdentityDirectory({ ...dir, users: [...dir.users, { id: 'reviewer-1', displayName: '验收人一', roleIds: [], enabled: true }] })
  }
})
afterAll(() => {
  store.closeProjectDb()
  if (originalConfig === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = originalConfig
  rmSync(directory, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

interface World {
  taskId: string
  projectId: string
  executionId: string
  worktreePath: string
  sessionDirectory: string
  employeeId: string
  sessionId: string
}

/** 建立完整最小闭环：干净仓库 → 工作区 → 员工/项目/任务（带范围）→ 决策 → 会话/worktree → 已完成执行 */
function fixture(options: { reviewerId?: string; withDecision?: boolean; dirtyWork?: (wt: string) => void } = {}): World {
  const repo = join(directory, `repo-${randomUUID().slice(0, 8)}`); mkdirSync(repo)
  git(repo, 'init'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid')
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'src', 'a.ts'), 'original\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'baseline')

  const workspace = createAgentWorkspace(`delivery-${randomUUID().slice(0, 6)}`, repo)
  const channel = createChannel({ name: `ch-${randomUUID().slice(0, 6)}`, provider: 'openai', baseUrl: 'https://example.invalid', apiKey: 'not-a-real-key', enabled: true, models: [{ id: 'model', name: 'model', enabled: true }] })
  const employee = service.createAgentEmployee({ name: '研发', role: '工程师', description: '', executionProfile: 'development', permissionMode: 'auto', workspaceId: workspace.id, channelId: channel.id, modelId: 'model', runtime: 'pi' })
  const project = store.createProject({ title: '交付闭环', description: '' })

  // 关联真实决策（无 DACI 的低风险决策兼容为 decided）
  let revision = 0
  if (options.withDecision !== false) {
    const chain = chainService.updateProjectChain(project.id, revision, { kind: 'decision', title: '修复方向', rationale: '最小增量修复', evidence: 'issue#1' })
    revision = chain.revision
  }

  const scope = {
    workspaceId: workspace.id,
    targetPaths: ['src/a.ts'],
    allowedPaths: ['src'],
    reviewerId: options.reviewerId ?? 'reviewer-1',
    decisionIds: options.withDecision !== false ? [chainService.getProjectChain(project.id).decisions[0]!.id] : [],
    verificationCommands: ['bun test src/a.test.ts'],
  }
  const task = store.createTask(project.id, {
    title: '修复小问题', description: '', developmentScope: scope,
    assignee: { userId: `agent-${employee.id}`, displayName: employee.name },
  })

  const session = sessionManager.createAgentSession('交付测试', channel.id, workspace.id)
  const sessionDirectory = getAgentSessionWorkspacePath(workspace.slug, session.id)
  const executionId = `exec-${randomUUID()}`
  const worktree = createDevelopmentWorktree(repo, sessionDirectory, executionId)
  options.dirtyWork?.(worktree.path)

  store.createAgentExecution({ id: executionId, projectId: project.id, entityType: 'task', entityId: task.id, agentId: employee.id, sessionId: session.id, prompt: 'p' })
  store.updateAgentExecution(executionId, { status: 'completed', resultSummary: '已修复并验证', completedAt: Date.now() })
  return { taskId: task.id, projectId: project.id, executionId, worktreePath: worktree.path, sessionDirectory, employeeId: employee.id, sessionId: session.id }
}

describe('受限员工交付（T13/T17/T18）', () => {
  test('Given 完整范围与真实决策 When 提交 Then 冻结快照并停在 submitted', () => {
    const w = fixture({ dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 'fixed\n') })
    const result = submitDevelopmentDelivery(w.executionId)
    expect(result.status).toBe('submitted')
    expect(result.snapshotId).toMatch(/^snap-/)

    const chain = chainService.getProjectChain(w.projectId)
    const draft = chain.drafts.find((item) => item.id === result.deliveryId)!
    expect(draft.status).toBe('submitted')
    expect(draft.responsibilities?.ownerId).toBe(`agent-${w.employeeId}`)
    expect(draft.responsibilities?.reviewerId).toBe('reviewer-1')
    expect(draft.artifactRef).toContain(result.snapshotId)

    // 员工不能验收：accept 的责任人是人类 reviewer（T13）
    expect(() => chainService.updateProjectChainAsActor(w.projectId, chain.revision, { kind: 'accept', draftId: draft.id, comment: '自验收' }, `agent-${w.employeeId}`)).toThrow('不具备此步骤的责任权限')
    // 本机用户也不是验收人，不能代为验收
    expect(() => chainService.updateProjectChainAsActor(w.projectId, chain.revision, { kind: 'accept', draftId: draft.id, comment: '代办' }, 'local-user')).toThrow('不具备此步骤的责任权限')
    // 人类 reviewer 验收成功
    const accepted = chainService.updateProjectChainAsActor(w.projectId, chain.revision, { kind: 'accept', draftId: draft.id, comment: '通过', evidence: 'diff 核对', completedCriteria: [] }, 'reviewer-1')
    expect(accepted.drafts.find((item) => item.id === draft.id)?.status).toBe('accepted')
  })

  test('Given 伪造的员工操作身份 When 调用链路入口 Then 拒绝（T17）', () => {
    const project = store.createProject({ title: '伪造身份', description: '' })
    expect(() => chainService.updateProjectChainAsActor(project.id, 0, { kind: 'decision', title: 'x', rationale: 'y', evidence: 'z' }, 'agent-not-exist')).toThrow('无效的员工操作身份')
    expect(() => chainService.updateProjectChainAsActor(project.id, 0, { kind: 'decision', title: 'x', rationale: 'y', evidence: 'z' }, 'agent-')).toThrow('无效的员工操作身份')
  })

  test('Given 缺少范围/决策/验收人 When 提交 Then 明确卡点', () => {
    const noScope = fixture({ dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 'x\n') })
    // 显式清除范围（undefined 表示删除该字段，沿用 workspaceId 清空语义）
    store.updateTask(noScope.taskId, { developmentScope: undefined } as never)
    expect(store.getTask(noScope.taskId)?.developmentScope).toBeUndefined()
    expect(() => submitDevelopmentDelivery(noScope.executionId)).toThrow('研发执行范围')

    const noDecision = fixture({ withDecision: false, dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 'y\n') })
    expect(() => submitDevelopmentDelivery(noDecision.executionId)).toThrow('缺少关联决策')
  })

  test('Given 重复回调与旧运行 When 提交 Then 幂等且拒绝负责人变更', () => {
    const w = fixture({ dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 'v1\n') })
    const first = submitDevelopmentDelivery(w.executionId)
    const revisionAfter = chainService.getProjectChain(w.projectId).revision
    const second = submitDevelopmentDelivery(w.executionId)
    expect(second).toMatchObject({ deliveryId: first.deliveryId, version: first.version })
    expect(chainService.getProjectChain(w.projectId).revision).toBe(revisionAfter)

    // 负责人改派后旧运行再提交：拒绝
    store.updateTask(w.taskId, { assignee: { userId: 'local-user', displayName: '用户' } })
    expect(() => submitDevelopmentDelivery(w.executionId)).toThrow('负责人已变更')
  })

  test('Given 同任务返工 When 再次提交 Then 同一交付 id 的新版本（D2）', () => {
    const w = fixture({ dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 'v1\n') })
    const first = submitDevelopmentDelivery(w.executionId)
    // 返工：同一 worktree 继续修改，新 execution 绑定同一会话（沿用原 worktree 绑定）
    writeFileSync(join(w.worktreePath, 'src', 'a.ts'), 'v2\n')
    const executionId2 = `exec-${randomUUID()}`
    store.createAgentExecution({ id: executionId2, projectId: w.projectId, entityType: 'task', entityId: w.taskId, agentId: w.employeeId, sessionId: w.sessionId, prompt: 'p' })
    store.updateAgentExecution(executionId2, { status: 'completed', resultSummary: '返工完成', completedAt: Date.now() })
    const rework = submitDevelopmentDelivery(executionId2)
    expect(rework.deliveryId).toBe(first.deliveryId)
    expect(rework.version).toBe(first.version + 1)
    expect(rework.status).toBe('submitted')
  })
})

describe('受限提交不触发自动验收（T19）', () => {
  test('Given 低风险自动验收策略 When 员工提交 Then 停在 submitted；纯函数路径 Without 抑制则 accepted', () => {
    // 纯函数层：同样的链路状态，suppress 开关决定是否自动验收
    let chain = emptyProjectChain()
    chain = applyChainCommand(chain, { kind: 'decision', title: '修复方向', rationale: '最小增量', evidence: 'issue#1' }, 'local-user')
    const decisionId = chain.decisions[0]!.id
    chain = applyChainCommand(chain, { kind: 'set_project_dod', criteria: ['测试通过'] }, 'local-user')
    chain = applyChainCommand(chain, { kind: 'set_task_dod_auto_acceptance', taskId: 't1', enabled: true, riskLevel: 'low', rules: [{ criterion: '测试通过', verifier: 'artifact_reference_present' }] }, 'local-user')
    chain = applyChainCommand(chain, { kind: 'draft', taskId: 't1', title: '交付', content: '内容', criteria: '测试通过', recipient: 'local-user', decisionIds: [decisionId], artifactRef: 'ref-1', responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' } }, 'local-user')
    const draft = chain.drafts[0]!
    // 无 artifact verifier 规则命中 artifactRef → 通过 → 默认自动验收
    const auto = applyChainCommand(chain, { kind: 'submit', draftId: draft.id }, 'local-user')
    expect(auto.drafts[0]!.status).toBe('accepted')
    const suppressed = applyChainCommand(chain, { kind: 'submit', draftId: draft.id }, 'local-user', { suppressDodAutoAccept: true })
    expect(suppressed.drafts[0]!.status).toBe('submitted')
  })

  test('Given 真实链路员工提交 When 项目配置自动验收 Then 仍停在 submitted（T19）', () => {
    const w = fixture({ dirtyWork: (wt) => writeFileSync(join(wt, 'src', 'a.ts'), 't19\n') })
    // 开启低风险自动验收：DoD 条目与规则命中 artifact 引用
    let revision = chainService.getProjectChain(w.projectId).revision
    revision = chainService.updateProjectChain(w.projectId, revision, { kind: 'set_project_dod', criteria: ['测试通过'] }).revision
    revision = chainService.updateProjectChain(w.projectId, revision, { kind: 'set_task_dod_auto_acceptance', taskId: w.taskId, enabled: true, riskLevel: 'low', rules: [{ criterion: '测试通过', verifier: 'artifact_reference_present' }] }).revision
    const result = submitDevelopmentDelivery(w.executionId)
    expect(result.status).toBe('submitted')
    expect(chainService.getProjectChain(w.projectId).drafts.find((item) => item.id === result.deliveryId)?.status).toBe('submitted')
  })
})

describe('完成回调门控', () => {
  test('Given 无范围任务 When 完成回调判断 Then 静默跳过保持旧行为', () => {
    expect(shouldSubmitDevelopmentDelivery({ assignee: { userId: 'agent-1' } })).toBe(false)
    expect(shouldSubmitDevelopmentDelivery({ assignee: { userId: 'local-user' }, developmentScope: {} })).toBe(false)
    expect(shouldSubmitDevelopmentDelivery(null)).toBe(false)
    expect(shouldSubmitDevelopmentDelivery({ assignee: { userId: 'agent-1' }, developmentScope: { workspaceId: 'w' } })).toBe(true)
  })
})

test('Given legacy执行与Owner异常执行共用真实session When direct交付 Then 先拒用途且快照/chain不变', async () => {
  const w = fixture({dirtyWork: wt => writeFileSync(join(wt,'src','a.ts'),'session-purpose-fixture\n')})
  const owner = store.createTask(w.projectId,{title:'同会话异常Owner目的',description:''})
  store.createAgentExecution({id:randomUUID(),projectId:w.projectId,entityType:'task',entityId:owner.id,agentId:'fake',sessionId:w.sessionId,prompt:'只模拟旧账本'})
  store.getProjectDb().prepare("UPDATE tasks SET owner_step_link_id='' WHERE id=?").run(owner.id)
  const evidence = await import('./project-owner-task-evidence')
  expect(evidence.hasOwnerBusinessExecutionEvidence(w.executionId)).toBe(false)
  expect(evidence.hasOwnerBusinessSessionEvidence(w.sessionId)).toBe(true)
  const before = chainService.getProjectChain(w.projectId)
  const snapshotPath = join(w.sessionDirectory, `development-snapshot-${w.executionId}.json`)
  expect(existsSync(snapshotPath)).toBe(false)
  expect(() => submitDevelopmentDelivery(w.executionId)).toThrow('Owner')
  expect(existsSync(snapshotPath)).toBe(false)
  expect(chainService.getProjectChain(w.projectId)).toEqual(before)
})
