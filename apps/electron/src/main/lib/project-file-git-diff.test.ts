import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { createAgentWorkspace } from './agent-workspace-manager'
import { bindWorkspaceToProject, unbindWorkspaceFromProject } from './project-workspace-bindings'
import { getProjectWorkspaceGitDiff } from './project-file-git-diff'

const temp = mkdtempSync(join(tmpdir(), 'gravitas-change-diff-'))
const root = join(temp, 'project')
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' })
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = join(temp, 'config'); mkdirSync(root); await initProjectDb() })
afterAll(() => { closeProjectDb(); rmSync(temp, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

test('Given 已绑定 Git 工作区 When 查看当前差异 Then 返回 HEAD 差异且解绑和路径穿越被拒绝', async () => {
  git('init', '--template=')
  writeFileSync(join(root, 'file.txt'), 'before\n')
  git('add', 'file.txt')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'baseline')
  const project = createProject({ title: '项目', description: '' })
  const workspace = createAgentWorkspace('Git差异测试', root)
  bindWorkspaceToProject(project.id, workspace.id)
  writeFileSync(join(root, 'file.txt'), 'after\n')
  const result = await getProjectWorkspaceGitDiff(project.id, workspace.id, 'file.txt')
  expect(result.status).toBe('available')
  if (result.status === 'available') expect(result.text).toContain('+after')
  expect((await getProjectWorkspaceGitDiff(project.id, workspace.id, 'untracked.txt')).status).toBe('unavailable')
  await expect(getProjectWorkspaceGitDiff(project.id, workspace.id, '../outside')).rejects.toThrow('路径无效')
  unbindWorkspaceFromProject(project.id, workspace.id)
  await expect(getProjectWorkspaceGitDiff(project.id, workspace.id, 'file.txt')).rejects.toThrow('未绑定')
})
