import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

const directory = mkdtempSync(join(tmpdir(), 'owner-dev-recovery-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())

const store = await import('./project-sqlite-store')
const recovery = await import('./project-owner-development-recovery')
const { createDevelopmentWorktree } = await import('./agent-development-worktree')
const { createAgentWorkspace } = await import('./agent-workspace-manager')
const { createAgentSession, getAgentSessionMeta } = await import('./agent-session-manager')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(directory, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(directory, 'repo-'))
  git(root, 'init')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'user.name', 'test')
  writeFileSync(join(root, 'README.md'), 'base\n')
  git(root, 'add', '.')
  git(root, 'commit', '-m', 'base')
  return root
}

test('Given失败工作树留有改动 When盘点 Then返回可核对的相对路径与基线', () => {
  const root = repo()
  const worktree = join(root, '..', `wt-${Date.now()}`)
  git(root, 'worktree', 'add', '-b', `employee/${Date.now()}`, worktree, 'HEAD')
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'game.ts'), 'export const x = 1\n')
  writeFileSync(join(worktree, 'README.md'), 'changed\n')
  const inventory = recovery.inspectFailedDevelopmentWorktree(worktree, root)
  expect(inventory.baseCommit).toBe(git(root, 'rev-parse', 'HEAD'))
  expect(inventory.changedFiles).toEqual(['README.md'])
  expect(inventory.untrackedFiles).toEqual(['src/game.ts'])
  expect(inventory.hasChanges).toBe(true)
})

test('Given工作树干净 When盘点 Then明确报告没有可交接内容', () => {
  const root = repo()
  const worktree = join(root, '..', `wt-clean-${Date.now()}`)
  git(root, 'worktree', 'add', '-b', `employee/clean-${Date.now()}`, worktree, 'HEAD')
  expect(recovery.inspectFailedDevelopmentWorktree(worktree, root)).toMatchObject({
    changedFiles: [], untrackedFiles: [], hasChanges: false,
  })
})

test('Given工作树属于其他仓库 When盘点 Then拒绝而不是静默继续', () => {
  const root = repo(), other = repo()
  expect(() => recovery.inspectFailedDevelopmentWorktree(other, root)).toThrow('不属于当前仓库')
})

test('Given路径不是仓库根 When盘点 Then拒绝', () => {
  const root = repo()
  mkdirSync(join(root, 'sub'))
  expect(() => recovery.inspectFailedDevelopmentWorktree(join(root, 'sub'), root)).toThrow()
})

// 旧工作树被用户清理、或换机后只剩数据库时，realpathSync 会抛 ENOENT。
// 这不是「有半成品要保护」，而是「没有现场可交接」——必须放行干净重试，否则恢复永久卡死。
test('Given旧工作树已不存在 When盘点 Then报告现场缺失而不是抛错', () => {
  const root = repo()
  const missing = join(directory, 'removed-worktree')
  const inventory = recovery.inspectFailedDevelopmentWorktree(missing, root)
  expect(inventory).toMatchObject({ hasChanges: false, changedFiles: [], untrackedFiles: [] })
  expect(inventory.worktreeMissing).toBe(true)
})

test('Given旧工作树已不存在 When交接 Then不抛错并返回null（从干净基线重试）', async () => {
  const root = repo()
  const targetDir = mkdtempSync(join(directory, 'target-missing-'))
  const targetWorktree = createDevelopmentWorktree(root, targetDir, randomUUID()).path
  await expect(recovery.seedFailedDevelopmentWorktree({
    repository: root,
    failedWorktreePath: join(directory, 'removed-worktree'),
    failedSessionDirectory: join(directory, 'removed-session'),
    failedExecutionId: randomUUID(),
    workspaceId: 'ws-1',
    targetWorktreePath: targetWorktree, targetSessionDirectory: targetDir,
    scope: { workspaceId: 'ws-1', targetPaths: ['index.html'], allowedPaths: ['index.html'] },
  })).resolves.toBeNull()
})

// 路径存在但不是 Git 仓库是真实故障，不能被「现场缺失」吞掉。
test('Given路径存在但不是仓库 When盘点 Then保留原诊断而不是当作缺失', () => {
  const root = repo()
  const plain = mkdtempSync(join(directory, 'plain-dir-'))
  expect(() => recovery.inspectFailedDevelopmentWorktree(plain, root)).toThrow()
})

test('Given失败工作树有改动 When交接 Then新工作树包含同样的文件内容', async () => {
  const root = repo()
  // 走生产路径建 worktree：会话目录必须带 development-worktree.json 基线绑定，执行 ID 必须是 UUID。
  const failedDir = mkdtempSync(join(directory, 'failed-session-'))
  const failedExecutionId = randomUUID()
  const failedWorktree = createDevelopmentWorktree(root, failedDir, failedExecutionId).path
  writeFileSync(join(failedWorktree, 'index.html'), '<html>done</html>\n')
  writeFileSync(join(failedWorktree, 'README.md'), 'modified\n')

  const targetDir = mkdtempSync(join(directory, 'target-session-'))
  const targetWorktree = createDevelopmentWorktree(root, targetDir, randomUUID()).path

  // 路径策略按段前缀匹配，'.' 允许不到任何文件；这里显式列出两个目标文件。
  const workspaceId = 'ws-1'
  const scope = { workspaceId, targetPaths: ['index.html'], allowedPaths: ['README.md', 'index.html'] }
  const snapshot = await recovery.seedFailedDevelopmentWorktree({
    repository: root, failedWorktreePath: failedWorktree, failedSessionDirectory: failedDir,
    failedExecutionId, workspaceId,
    targetWorktreePath: targetWorktree, targetSessionDirectory: targetDir, scope,
  })
  expect(snapshot).not.toBeNull()
  expect(snapshot!.files.map(f => f.path).sort()).toEqual(['README.md', 'index.html'])
  // 新工作树里能读到同样内容
  expect(execFileSync('cat', [join(targetWorktree, 'index.html')], { encoding: 'utf8' })).toBe('<html>done</html>\n')
  expect(execFileSync('cat', [join(targetWorktree, 'README.md')], { encoding: 'utf8' })).toBe('modified\n')
})

interface SupersessionChain {
  executionId: string
  sessionId: string
  taskId: string
  materializationId: string
  nextMaterializationId: string
}

/**
 * 直接落库构造「接替记录 → 授权 → 命令 → 执行 → step 关联」链路。
 * 不走 Owner 派发链：这里只想验查找 SQL，材料化/重验证的成本与断言无关。
 */
function seedSupersessionChain(options: {
  projectId: string
  stepKey: string
  status?: 'failed' | 'completed' | 'running'
  sessionId?: string
  createdAt?: number
  /** 每项目只允许一条 active 授权；多次接替时旧授权按生产语义归档。 */
  grantState?: 'active' | 'archived'
  /** 同一 step link 上的额外执行者轮次（返工共用 link），用于验证「取最近一次」。 */
  extraCommands?: Array<{ reworkOrdinal: number; status: 'failed' | 'completed'; createdAt: number }>
}): SupersessionChain {
  const db = store.getProjectDb()
  const createdAt = options.createdAt ?? Date.now()
  const task = store.createTask(options.projectId, { title: `步骤 ${options.stepKey}`, description: '' })
  const materializationId = randomUUID()
  const nextMaterializationId = randomUUID()
  const nextTask = store.createTask(options.projectId, { title: '接替步骤', description: '' })
  db.prepare(`INSERT INTO project_owner_task_step_links
    (id, materialization_id, project_id, subject_key, plan_fingerprint, step_key, task_id, payload, integrity_hash)
    VALUES (?,?,?,'project',?,?,?,'{}','link-hash')`)
    .run(randomUUID(), nextMaterializationId, options.projectId, randomUUID().replaceAll('-', ''), options.stepKey, nextTask.id)
  const grantId = randomUUID()
  const commandId = randomUUID()
  const linkId = randomUUID()
  const executionId = randomUUID()
  const sessionId = options.sessionId ?? `sess-${randomUUID()}`
  const employeeId = randomUUID()
  db.prepare(`INSERT INTO project_owner_task_step_links
    (id, materialization_id, project_id, subject_key, plan_fingerprint, step_key, task_id, payload, integrity_hash)
    VALUES (?,?,?,'project',?,?,?,'{}','link-hash')`)
    .run(linkId, materializationId, options.projectId, randomUUID().replaceAll('-', ''), options.stepKey, task.id)
  db.prepare(`INSERT INTO project_owner_execution_grants
    (id,project_id,task_id,purpose,state,revalidation_id,revalidation_revision,revalidation_integrity_hash,
     materialization_id,materialization_revision,materialization_integrity_hash,policy_revision,executor_employee_id,
     reviewer_employee_id,workspace_id,channel_id,model_id,runtime,max_cost_micros,max_runs,max_rework,expires_at,
     approval_fingerprint,source_hash,request_id,input_hash,issued_at)
    VALUES (?,?,?,'owner_business_execution',?,?,1,?,?,1,?,1,?,?,?,?,?,'ai-sdk',1000,1,0,?,?,?,?,?,?)`)
    .run(grantId, options.projectId, task.id, options.grantState ?? 'active', randomUUID(), 'revalidation-hash', materializationId, 'materialization-hash',
      employeeId, randomUUID(), 'workspace-fixture', 'channel-fixture', 'model-fixture', createdAt + 60_000,
      randomUUID(), randomUUID(), randomUUID(), randomUUID(), createdAt)
  const insertRound = (round: { commandId: string; executionId: string; sessionId: string; reworkOrdinal: number; status: string; at: number }) => {
    db.prepare(`INSERT INTO project_owner_execution_commands
      (id,project_id,grant_id,idempotency_key,source_task_id,source_step_link_id,source_version,source_hash,
       employee_id,role,rework_ordinal,reserved_cost_micros,state,execution_id,ack_fingerprint,created_at,updated_at)
      VALUES (?,?,?,?,?,?,1,?,?,'executor',?,1000,'running',?,?,?,?)`)
      .run(round.commandId, options.projectId, grantId, randomUUID(), task.id, linkId, randomUUID(), employeeId,
        round.reworkOrdinal, round.executionId, randomUUID(), round.at, round.at)
    db.prepare(`INSERT INTO agent_executions
      (id,project_id,entity_type,entity_id,agent_id,session_id,status,started_at,owner_command_id)
      VALUES (?,?,'task',?,?,?,?,?,?)`)
      .run(round.executionId, options.projectId, task.id, employeeId, round.sessionId, round.status, round.at, round.commandId)
  }
  insertRound({ commandId, executionId, sessionId, reworkOrdinal: 0, status: options.status ?? 'failed', at: createdAt })
  for (const extra of options.extraCommands ?? []) {
    insertRound({
      commandId: randomUUID(), executionId: randomUUID(), sessionId: `sess-${randomUUID()}`,
      reworkOrdinal: extra.reworkOrdinal, status: extra.status, at: extra.createdAt,
    })
  }
  db.prepare(`INSERT INTO project_owner_execution_batch_supersessions
    (id,project_id,previous_materialization_id,next_materialization_id,payload,integrity_hash,created_at)
    VALUES (?,?,?,?,'{}','supersession-hash',?)`)
    .run(randomUUID(), options.projectId, materializationId, nextMaterializationId, createdAt)
  return { executionId, sessionId, taskId: nextTask.id, materializationId, nextMaterializationId }
}

test('Given接替记录关联的失败执行 When按step查找 Then返回该执行的session', () => {
  const project = store.createProject({ title: '交接查找', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toEqual({
    executionId: chain.executionId, sessionId: chain.sessionId,
  })
})

test('Given同一step的执行已完成 When按step查找 Then不把它当作可交接现场', () => {
  const project = store.createProject({ title: '交接非失败', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery', status: 'completed' })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toBeNull()
})

test('Given失败执行没有session When按step查找 Then返回null', () => {
  const project = store.createProject({ title: '交接空会话', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery', sessionId: '' })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toBeNull()
})

test('Givenstep不匹配 When按step查找 Then返回null（不跨步骤串现场）', () => {
  const project = store.createProject({ title: '交接跨步骤', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  expect(recovery.findFailedExecutionForStep(project.id, 'review', chain.nextMaterializationId)).toBeNull()
})

test('Given其他项目有失败执行 When按step查找 Then返回null（不跨项目串现场）', () => {
  const project = store.createProject({ title: '交接本项目', description: '' })
  const other = store.createProject({ title: '交接其他项目', description: '' })
  const chain = seedSupersessionChain({ projectId: other.id, stepKey: 'delivery' })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toBeNull()
})

test('Given接替记录指向不存在的批次 When按step查找 Then返回null（跨界不猜）', () => {
  const project = store.createProject({ title: '交接悬空批次', description: '' })
  store.getProjectDb().prepare(`INSERT INTO project_owner_execution_batch_supersessions
    (id,project_id,previous_materialization_id,next_materialization_id,payload,integrity_hash,created_at)
    VALUES (?,?,?,?,'{}','supersession-hash',?)`)
    .run(randomUUID(), project.id, randomUUID(), randomUUID(), Date.now())
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', randomUUID())).toBeNull()
})

test('Given多次接替 When按step查找 Then取最近一次接替的失败执行', () => {
  const project = store.createProject({ title: '交接取最近', description: '' })
  const older = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery', createdAt: Date.now() - 10_000, grantState: 'archived' })
  const latest = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery', createdAt: Date.now() })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', latest.nextMaterializationId)).toEqual({
    executionId: latest.executionId, sessionId: latest.sessionId,
  })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', latest.nextMaterializationId)!.executionId).not.toBe(older.executionId)
})

test('Given同一step有多次失败返工 When按step查找 Then取最近的失败轮次', () => {
  const project = store.createProject({ title: '交接返工轮次', description: '' })
  const base = Date.now() - 10_000
  // 返工轮次共用同一条 step link，只能靠命令时间区分新旧。
  const chain = seedSupersessionChain({
    projectId: project.id, stepKey: 'delivery', createdAt: base,
    extraCommands: [{ reworkOrdinal: 1, status: 'failed', createdAt: base + 5_000 }],
  })
  const found = recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)
  expect(found).not.toBeNull()
  expect(found!.executionId).not.toBe(chain.executionId)
  expect(found!.sessionId).not.toBe(chain.sessionId)
})

test('Given最近一轮已成功而更早一轮失败 When按step查找 Then仍返回失败的现场', () => {
  const project = store.createProject({ title: '交接最近成功', description: '' })
  const base = Date.now() - 10_000
  const chain = seedSupersessionChain({
    projectId: project.id, stepKey: 'delivery', createdAt: base,
    extraCommands: [{ reworkOrdinal: 1, status: 'completed', createdAt: base + 5_000 }],
  })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toEqual({
    executionId: chain.executionId, sessionId: chain.sessionId,
  })
})

test('Given失败执行属于其他工作区 When按step查找 Then仍返回它（工作区隔离由调用方负责）', () => {
  const project = store.createProject({ title: '交接跨工作区', description: '' })
  const foreignWorkspace = createAgentWorkspace(`recovery-foreign-${randomUUID()}`)
  const session = createAgentSession('失败现场', undefined, foreignWorkspace.id, 'glm-5.3-flash', 'ai-sdk')
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery', sessionId: session.id })
  // 查找本身只按 step 建映射，不按工作区过滤；`seedMixedBatchFailure` 必须自己比对
  // 会话所属工作区与当前工作区，否则会把别的仓库基线的快照应用过来。
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)).toEqual({
    executionId: chain.executionId, sessionId: session.id,
  })
  expect(getAgentSessionMeta(session.id)?.workspaceId).toBe(foreignWorkspace.id)
})

test('Given项目或step为空 When按step查找 Then直接返回null', () => {
  expect(recovery.findFailedExecutionForStep('', 'delivery', 'batch')).toBeNull()
  expect(recovery.findFailedExecutionForStep('   ', 'delivery', 'batch')).toBeNull()
  expect(recovery.findFailedExecutionForStep('project', '', 'batch')).toBeNull()
})

test('Given失败工作树没有改动 When交接 Then返回null且不创建快照', async () => {
  const root = repo()
  const failedDir = mkdtempSync(join(directory, 'failed-empty-'))
  const failedExecutionId = randomUUID()
  const failedWorktree = createDevelopmentWorktree(root, failedDir, failedExecutionId).path
  const targetDir = mkdtempSync(join(directory, 'target-empty-'))
  const targetWorktree = createDevelopmentWorktree(root, targetDir, randomUUID()).path
  expect(await recovery.seedFailedDevelopmentWorktree({
    repository: root, failedWorktreePath: failedWorktree, failedSessionDirectory: failedDir,
    failedExecutionId, workspaceId: 'ws-1',
    targetWorktreePath: targetWorktree, targetSessionDirectory: targetDir,
    scope: { workspaceId: 'ws-1', targetPaths: ['index.html'], allowedPaths: ['README.md', 'index.html'] },
  })).toBeNull()
  // 无改动时不得写出任何快照清单
  expect(existsSync(join(failedDir, `development-snapshot-${failedExecutionId}.json`))).toBe(false)
})

test('Given失败执行属于当前工作区 When解析交接目标 Then返回worktree路径', () => {
  const project = store.createProject({ title: '交接目标同区', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  const workspace = { id: 'ws-current', slug: 'slug-current', rootPath: mkdtempSync(join(directory, 'repo-target-')) }
  const target = recovery.resolveMixedBatchHandoffTarget({
    projectId: project.id, taskId: chain.taskId, currentWorkspace: workspace,
    lookupSessionWorkspaceId: () => workspace.id,
    lookupWorkspace: () => workspace,
    resolveSessionDirectory: (slug, sessionId) => join(directory, slug, sessionId),
  })
  expect(target).toEqual({
    taskId: chain.taskId,
    failedExecutionId: chain.executionId,
    failedSessionDirectory: join(directory, workspace.slug, chain.sessionId),
    failedWorktreePath: join(directory, workspace.slug, chain.sessionId, 'source'),
  })
})

test('Given失败执行属于其他工作区 When解析交接目标 Then拒绝跨区交接', () => {
  const project = store.createProject({ title: '交接目标跨区', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  const current = { id: 'ws-current', slug: 'slug-current', rootPath: mkdtempSync(join(directory, 'repo-cur-')) }
  const foreign = { id: 'ws-foreign', slug: 'slug-foreign', rootPath: mkdtempSync(join(directory, 'repo-for-')) }
  expect(recovery.resolveMixedBatchHandoffTarget({
    projectId: project.id, taskId: chain.taskId, currentWorkspace: current,
    lookupSessionWorkspaceId: () => foreign.id,
    lookupWorkspace: () => foreign,
    resolveSessionDirectory: (slug, sessionId) => join(directory, slug, sessionId),
  })).toBeNull()
})

test('Given当前工作区没有本地仓库 When解析交接目标 Then拒绝', () => {
  const project = store.createProject({ title: '交接目标无仓库', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  expect(recovery.resolveMixedBatchHandoffTarget({
    projectId: project.id, taskId: chain.taskId,
    currentWorkspace: { id: 'ws', slug: 'slug' },
    lookupSessionWorkspaceId: () => 'ws',
    lookupWorkspace: () => ({ id: 'ws', slug: 'slug' }),
    resolveSessionDirectory: (slug, sessionId) => join(directory, slug, sessionId),
  })).toBeNull()
})

test('Given失败执行没有关联工作区 When解析交接目标 Then拒绝', () => {
  const project = store.createProject({ title: '交接目标无会话', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  const workspace = { id: 'ws-current', slug: 'slug-current', rootPath: mkdtempSync(join(directory, 'repo-nosess-')) }
  expect(recovery.resolveMixedBatchHandoffTarget({
    projectId: project.id, taskId: chain.taskId, currentWorkspace: workspace,
    lookupSessionWorkspaceId: () => undefined,
    lookupWorkspace: () => workspace,
    resolveSessionDirectory: (slug, sessionId) => join(directory, slug, sessionId),
  })).toBeNull()
})

test('Given任务没有step关联 When解析交接目标 Then返回null', () => {
  const project = store.createProject({ title: '交接目标无step', description: '' })
  const workspace = { id: 'ws-current', slug: 'slug-current', rootPath: mkdtempSync(join(directory, 'repo-nostep-')) }
  expect(recovery.resolveMixedBatchHandoffTarget({
    projectId: project.id, taskId: randomUUID(), currentWorkspace: workspace,
    lookupSessionWorkspaceId: () => workspace.id,
    lookupWorkspace: () => workspace,
    resolveSessionDirectory: (slug, sessionId) => join(directory, slug, sessionId),
  })).toBeNull()
})

test('Given历史接替与当前批次无关 When解析目标 Then不继承旧现场', () => {
  const project = store.createProject({ title: '不同批次', description: '' })
  const chain = seedSupersessionChain({ projectId: project.id, stepKey: 'delivery' })
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', randomUUID())).toBeNull()
  expect(recovery.findFailedExecutionForStep(project.id, 'delivery', chain.nextMaterializationId)?.executionId).toBe(chain.executionId)
})
