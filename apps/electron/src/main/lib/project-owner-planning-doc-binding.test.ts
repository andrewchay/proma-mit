import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWorkspace, ProjectOwnerPlanDraft } from '@gravitas/shared'

const root = mkdtempSync(join(tmpdir(), 'owner-plan-doc-authorized-'))
const previousConfigDir = process.env.PROMA_TEST_CONFIG_DIR
const configRoot = mkdtempSync(join(tmpdir(), 'owner-plan-doc-config-'))
process.env.PROMA_TEST_CONFIG_DIR = configRoot
let authorized = true
const workspace: AgentWorkspace = { id: 'workspace-a', slug: 'workspace-a', name: '已授权项目工作区', rootPath: root, createdAt: 1, updatedAt: 1 }
const binding = { schemaVersion: 1, projectId: 'project-a', revision: 1, ownerRole: 'project_owner', ownerName: '项目Owner', carrierId: 'carrier', workspaceId: workspace.id, channelId: 'channel', modelId: 'model', runtime: 'ai-sdk', carrierFingerprint: 'a'.repeat(64), actor: 'local-user', savedAt: 1, changeReason: '首次配置' }
mock.module('./project-sqlite-store', () => ({
  getProject: (projectId: string) => projectId === 'project-a' ? { id: projectId, title: '小游戏项目' } : null,
  getProjectDb: () => ({ prepare: () => ({ all: () => [{ revision: 1, payload: JSON.stringify(binding) }] }) }),
}))
mock.module('./project-workspace-bindings', () => ({ hasProjectWorkspaceBinding: (projectId: string, workspaceId: string) => authorized && projectId === 'project-a' && workspaceId === workspace.id }))
mock.module('./agent-workspace-manager', () => ({ getAgentWorkspace: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined }))
const { archiveProjectOwnerPlanHistory } = await import('./project-owner-planning-doc-service')

const plan: ProjectOwnerPlanDraft = {
  projectId: 'project-a', schemaVersion: 1, revision: 1, planVersion: 1, goalRevision: 1, goalVersion: 1,
  state: 'proposed', actor: 'system:owner-planner', origin: 'generated', savedAt: 1, changeReason: '提案',
  contextFingerprint: 'context', planFingerprint: 'plan',
  sources: { project: { id: 'project-a', title: '小游戏项目', description: '' }, roles: [] },
  proposal: { projectId: 'project-a', goalVersion: 1, mode: 'proposal_only', summary: '可审阅的摘要', assumptions: [], risks: [], steps: [{ key: 's1', title: '建立验收清单', outcome: '形成可审阅成果', acceptanceCriteria: ['标准明确'], dependencies: [], roleKey: 'research' }] },
}

test('Given Owner workspace 仍绑定当前项目 When 归档 Then 仅写入该工作区固定文档', () => {
  expect(archiveProjectOwnerPlanHistory('project-a', [plan])).toBeNull()
  expect(readFileSync(join(root, 'docs', 'owner-planning-log.md'), 'utf8')).toContain('建立验收清单')
})

test('Given 工作区授权已撤销 When 归档 Then 返回不含路径的提示且不创建文档', () => {
  authorized = false
  const warning = archiveProjectOwnerPlanHistory('project-a', [plan])
  expect(warning).toContain('项目文档归档失败')
  expect(warning).not.toContain(root)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(configRoot, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousConfigDir
})
