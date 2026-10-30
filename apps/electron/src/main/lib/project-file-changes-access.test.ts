import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { createAgentWorkspace } from './agent-workspace-manager'
import { bindWorkspaceToProject, unbindWorkspaceFromProject } from './project-workspace-bindings'
import { scanProjectFileChanges } from './project-file-changes'
import { getProjectWorkspaceFileChanges } from './project-file-changes-access'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-change-access-'))
const root = join(temp, 'project')
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); mkdirSync(root); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

test('Given 项目与工作区解绑 When 查看文件变化 Then 拒绝读取，重新绑定后可见', async () => {
  const project = createProject({ title: '项目', description: '' })
  const other = createProject({ title: '其他项目', description: '' })
  const workspace = createAgentWorkspace('文件变化测试', root)
  await scanProjectFileChanges(workspace.id, workspace.rootPath!)
  writeFileSync(join(root, 'new.txt'), 'new')
  await scanProjectFileChanges(workspace.id, workspace.rootPath!)
  await expect(getProjectWorkspaceFileChanges(project.id, workspace.id)).rejects.toThrow('未绑定')
  bindWorkspaceToProject(project.id, workspace.id)
  expect((await getProjectWorkspaceFileChanges(project.id, workspace.id)).changes[0]?.path).toBe('new.txt')
  await expect(getProjectWorkspaceFileChanges(other.id, workspace.id)).rejects.toThrow('未绑定')
  unbindWorkspaceFromProject(project.id, workspace.id)
  await expect(getProjectWorkspaceFileChanges(project.id, workspace.id)).rejects.toThrow('未绑定')
})
