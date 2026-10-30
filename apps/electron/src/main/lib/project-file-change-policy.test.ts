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
