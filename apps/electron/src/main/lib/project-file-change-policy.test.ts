import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { createAgentWorkspace } from './agent-workspace-manager'
import { bindWorkspaceToProject, unbindWorkspaceFromProject } from './project-workspace-bindings'
import { getProjectFileChangePolicy, setProjectFileChangePolicy } from './project-file-change-policy'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-file-policy-'))
const root = join(temp, 'project')
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); mkdirSync(root); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

test('Given 用户开启分析后解绑 When 重新绑定 Then 授权不会恢复且再次开启具有新版本', () => {
  const project = createProject({ title: '项目', description: '' })
  const workspace = createAgentWorkspace('资料', root)
  expect(() => setProjectFileChangePolicy(project.id, workspace.id, true)).toThrow('绑定无效')
  bindWorkspaceToProject(project.id, workspace.id)
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  const first = setProjectFileChangePolicy(project.id, workspace.id, true)!
  expect(setProjectFileChangePolicy(project.id, workspace.id, true)).toEqual(first)
  unbindWorkspaceFromProject(project.id, workspace.id)
  bindWorkspaceToProject(project.id, workspace.id)
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  const second = setProjectFileChangePolicy(project.id, workspace.id, true)!
  expect(second.revision).not.toBe(first.revision)
  setProjectFileChangePolicy(project.id, workspace.id, false)
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
})

test('Given 用户授权文件变化 When 重复接收同一批观察或撤销授权 Then 去重且旧观察不可再用', async () => {
  const { recordProjectFileChangeObservation, getAuthorizedProjectFileChangeObservation } = await import('./project-file-change-observations')
  const project = createProject({ title: '观察项目', description: '' })
  const observationRoot = join(temp, 'observation'); mkdirSync(observationRoot)
  const workspace = createAgentWorkspace('观察资料', observationRoot)
  bindWorkspaceToProject(project.id, workspace.id)
  const policy = setProjectFileChangePolicy(project.id, workspace.id, true)!
  const event = { path: 'src/file.ts', kind: 'modified' as const, observedAt: policy.enabledAt + 1 }
  const first = recordProjectFileChangeObservation(project.id, workspace.id, [event])!
  expect(recordProjectFileChangeObservation(project.id, workspace.id, [event])?.id).toBe(first.id)
  expect(getAuthorizedProjectFileChangeObservation(project.id, first.id)).toEqual(first)
  expect(() => recordProjectFileChangeObservation(project.id, workspace.id, [{ ...event, path: 'different.ts' }])).toThrow('内容不一致')
  expect(recordProjectFileChangeObservation(project.id, workspace.id, [{ ...event, observedAt: policy.enabledAt }])).toBeNull()
  setProjectFileChangePolicy(project.id, workspace.id, false)
  expect(getAuthorizedProjectFileChangeObservation(project.id, first.id)).toBeNull()
  setProjectFileChangePolicy(project.id, workspace.id, true)
  expect(getAuthorizedProjectFileChangeObservation(project.id, first.id)).toBeNull()
})

test('Given 扫描后尚未建立观察 When 从快照重复恢复 Then 只保存一次且不追溯授权前变化', async () => {
  const { scanProjectFileChanges } = await import('./project-file-changes')
  const { reconcileProjectFileChangeObservations } = await import('./project-file-change-observations')
  const { getProjectDb } = await import('./project-sqlite-store')
  const { writeFileSync } = await import('node:fs')
  const project = createProject({ title: '恢复项目', description: '' })
  const path = join(temp, 'recovery'); mkdirSync(path)
  const workspace = createAgentWorkspace('恢复资料', path)
  bindWorkspaceToProject(project.id, workspace.id)
  await scanProjectFileChanges(workspace.id, workspace.rootPath!)
  writeFileSync(join(path, 'old.txt'), 'old')
  await scanProjectFileChanges(workspace.id, workspace.rootPath!)
  setProjectFileChangePolicy(project.id, workspace.id, true)
  await new Promise(resolve => setTimeout(resolve, 5))
  writeFileSync(join(path, 'new.txt'), 'new')
  await scanProjectFileChanges(workspace.id, workspace.rootPath!)
  await reconcileProjectFileChangeObservations(workspace.id, workspace.rootPath!)
  await reconcileProjectFileChangeObservations(workspace.id, workspace.rootPath!)
  const rows = getProjectDb().prepare('SELECT payload FROM project_file_change_observations WHERE project_id = ?').all(project.id) as Array<{ payload: string }>
  expect(rows).toHaveLength(1)
  expect(JSON.parse(rows[0]!.payload).changes.map((event: { path: string }) => event.path)).toEqual(['new.txt'])
})

test('Given 持久化观察被更改或被其他项目引用 When 校验 Then 拒绝使用', async () => {
  const { recordProjectFileChangeObservation, getAuthorizedProjectFileChangeObservation } = await import('./project-file-change-observations')
  const { getProjectDb } = await import('./project-sqlite-store')
  const project = createProject({ title: '完整性项目', description: '' })
  const other = createProject({ title: '其他项目', description: '' })
  const path = join(temp, 'integrity'); mkdirSync(path)
  const workspace = createAgentWorkspace('完整性资料', path)
  bindWorkspaceToProject(project.id, workspace.id)
  const policy = setProjectFileChangePolicy(project.id, workspace.id, true)!
  const source = recordProjectFileChangeObservation(project.id, workspace.id, [{ path: 'a.txt', kind: 'modified', observedAt: policy.enabledAt + 1 }])!
  expect(getAuthorizedProjectFileChangeObservation(other.id, source.id)).toBeNull()
  const altered = { ...source, changes: [{ ...source.changes[0]!, path: 'tampered.txt' }] }
  getProjectDb().prepare('UPDATE project_file_change_observations SET payload = ? WHERE id = ?').run(JSON.stringify(altered), source.id)
  expect(getAuthorizedProjectFileChangeObservation(project.id, source.id)).toBeNull()
})

test('Given 已授权的文件变化 When 忽略规则变化并恢复 Then 旧授权和观察不会恢复', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { recordProjectFileChangeObservation, getAuthorizedProjectFileChangeObservation } = await import('./project-file-change-observations')
  const project = createProject({ title: '范围变更', description: '' })
  const path = join(temp, 'scope'); mkdirSync(path)
  const workspace = createAgentWorkspace('范围资料', path)
  bindWorkspaceToProject(project.id, workspace.id)
  const policy = setProjectFileChangePolicy(project.id, workspace.id, true)!
  const observation = recordProjectFileChangeObservation(project.id, workspace.id, [{ path: 'private/file.txt', kind: 'modified', observedAt: policy.enabledAt + 1 }])!
  writeFileSync(join(path, '.gravitasignore'), 'private/\n')
  expect(getAuthorizedProjectFileChangeObservation(project.id, observation.id)).toBeNull()
  rmSync(join(path, '.gravitasignore'))
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  expect(getAuthorizedProjectFileChangeObservation(project.id, observation.id)).toBeNull()
  const renewed = setProjectFileChangePolicy(project.id, workspace.id, true)!
  expect(renewed.revision).not.toBe(policy.revision)
  expect(getAuthorizedProjectFileChangeObservation(project.id, observation.id)).toBeNull()
})

test('Given 忽略规则短暂变化后恢复 When 文件监听收到事件 Then 原授权仍然撤销', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const { startWorkspaceWatcher, stopWorkspaceWatcher } = await import('./workspace-watcher')
  const project = createProject({ title: '监听范围变化', description: '' })
  const path = join(temp, 'watched-scope'); mkdirSync(path)
  const workspace = createAgentWorkspace('监听范围资料', path)
  bindWorkspaceToProject(project.id, workspace.id)
  setProjectFileChangePolicy(project.id, workspace.id, true)
  startWorkspaceWatcher({ isDestroyed: () => false, webContents: { send: () => {} } } as never)
  try {
    writeFileSync(join(path, '.gravitasignore'), 'private/\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    rmSync(join(path, '.gravitasignore'))
    await new Promise(resolve => setTimeout(resolve, 500))
    expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  } finally { stopWorkspaceWatcher() }
})

test('Given 旧版本授权没有忽略范围凭据 When 升级 Then 默认停用且重新开启创建新版本', async () => {
  const { getProjectDb } = await import('./project-sqlite-store')
  const project = createProject({ title: '旧授权升级', description: '' })
  const path = join(temp, 'legacy-scope'); mkdirSync(path)
  const workspace = createAgentWorkspace('旧范围资料', path)
  bindWorkspaceToProject(project.id, workspace.id)
  getProjectDb().prepare('INSERT INTO project_file_change_policies (project_id, workspace_id, revision, enabled_at) VALUES (?, ?, ?, ?)').run(project.id, workspace.id, 'old-revision', Date.now())
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  const renewed = setProjectFileChangePolicy(project.id, workspace.id, true)!
  expect(renewed.revision).not.toBe('old-revision')
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toEqual(renewed)
})

test('Given 授权后的忽略规则无法安全读取 When 恢复规则 Then 必须重新授权', () => {
  const project = createProject({ title: '规则不可读', description: '' })
  const path = join(temp, 'invalid-scope'); mkdirSync(path)
  const workspace = createAgentWorkspace('不可读范围', path)
  bindWorkspaceToProject(project.id, workspace.id)
  setProjectFileChangePolicy(project.id, workspace.id, true)
  mkdirSync(join(path, '.gravitasignore'))
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
  rmSync(join(path, '.gravitasignore'), { recursive: true })
  expect(getProjectFileChangePolicy(project.id, workspace.id)).toBeNull()
})
