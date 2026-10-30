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
  expect(recordProjectFileChangeObservation(project.id, workspace.id, [{ ...event, observedAt: policy.enabledAt }])).toBeNull()
  setProjectFileChangePolicy(project.id, workspace.id, false)
  expect(getAuthorizedProjectFileChangeObservation(project.id, first.id)).toBeNull()
  setProjectFileChangePolicy(project.id, workspace.id, true)
  expect(getAuthorizedProjectFileChangeObservation(project.id, first.id)).toBeNull()
})
