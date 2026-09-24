/**
 * Agent 会话当前 Project 上下文服务 BDD 测试
 *
 * 验证 Project ↔ Workspace 绑定是写入会话 projectId 的前置授权：
 * - 已绑定项目可切换，且同步打开 project 知识范围；
 * - 未绑定项目 / 无工作空间会话 / 会话运行中均被拒绝；
 * - 清空 projectId 会关闭项目范围，不删除项目或工作空间数据。
 *
 * 测试隔离：PROMA_TEST_CONFIG_DIR 指向临时目录，结束后清理。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'

mock.module('electron', () => buildElectronMock())

// agent-session-manager 模块加载时会解析 SDK 配置目录；先挂到 bootstrap 临时目录，避免触碰真实 ~/.gravitas。
const bootstrapDir = mkdtempSync(join(tmpdir(), `gravitas-session-project-bootstrap-${process.pid}-`))
process.env.PROMA_TEST_CONFIG_DIR = bootstrapDir

const { updateAgentSessionProjectContext } = await import('./agent-session-project-service')

let tempDir = ''
let sessionManager: typeof import('./agent-session-manager')
let projectStore: typeof import('./project-sqlite-store')
let workspaceManager: typeof import('./agent-workspace-manager')
let bindings: typeof import('./project-workspace-bindings')
const originalEnv = { ...process.env }

beforeEach(async () => {
  tempDir = join(tmpdir(), `gravitas-session-project-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.PROMA_TEST_CONFIG_DIR = tempDir
  mkdirSync(tempDir, { recursive: true })
  sessionManager = await import('./agent-session-manager')
  projectStore = await import('./project-sqlite-store')
  workspaceManager = await import('./agent-workspace-manager')
  bindings = await import('./project-workspace-bindings')
  await projectStore.initProjectDb()
})

afterEach(() => {
  projectStore.closeProjectDb()
  process.env = { ...originalEnv }
  rmSync(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(bootstrapDir, { recursive: true, force: true })
})

describe('会话当前 Project 授权切换', () => {
  it('Given 工作空间已与项目绑定 When 切换会话项目 Then 保存 projectId 并打开项目知识范围', () => {
    const project = projectStore.createProject({ title: '会话项目授权项目', description: '' })
    const workspace = workspaceManager.createAgentWorkspace(`会话项目授权工作区-${Date.now()}`)
    const session = sessionManager.createAgentSession('授权会话', undefined, workspace.id)
    bindings.bindWorkspaceToProject(project.id, workspace.id)

    try {
      const updated = updateAgentSessionProjectContext(session.id, project.id)
      expect(updated.projectId).toBe(project.id)
      expect(updated.knowledgeScopeMode).toBe('project')
      expect(updated.explicitKnowledgeBaseIds).toEqual([])
    } finally {
      workspaceManager.deleteAgentWorkspace(workspace.id)
      projectStore.deleteProject(project.id)
    }
  })

  it('Given 工作空间未与项目绑定 When 切换会话项目 Then 拒绝且保留原会话状态', () => {
    const project = projectStore.createProject({ title: '未绑定项目', description: '' })
    const workspace = workspaceManager.createAgentWorkspace(`未绑定工作区-${Date.now()}`)
    const session = sessionManager.createAgentSession('未绑定会话', undefined, workspace.id)

    try {
      expect(() => updateAgentSessionProjectContext(session.id, project.id))
        .toThrow('当前工作空间未与该项目绑定')
      expect(sessionManager.getAgentSessionMeta(session.id)?.projectId).toBeUndefined()
    } finally {
      workspaceManager.deleteAgentWorkspace(workspace.id)
      projectStore.deleteProject(project.id)
    }
  })

  it('Given 会话没有工作空间 When 切换会话项目 Then 拒绝写入项目上下文', () => {
    const project = projectStore.createProject({ title: '无工作空间项目', description: '' })
    const session = sessionManager.createAgentSession('无工作空间会话')

    try {
      expect(() => updateAgentSessionProjectContext(session.id, project.id))
        .toThrow('当前会话没有工作空间')
    } finally {
      projectStore.deleteProject(project.id)
    }
  })

  it('Given 会话已有项目 When 清空项目 Then 关闭项目知识范围但保留项目实体', () => {
    const project = projectStore.createProject({ title: '清空项目上下文', description: '' })
    const workspace = workspaceManager.createAgentWorkspace(`清空项目工作区-${Date.now()}`)
    const session = sessionManager.createAgentSession('清空项目会话', undefined, workspace.id)
    bindings.bindWorkspaceToProject(project.id, workspace.id)

    try {
      const bound = updateAgentSessionProjectContext(session.id, project.id)
      expect(bound.projectId).toBe(project.id)
      const cleared = updateAgentSessionProjectContext(session.id, null)
      expect(cleared.projectId).toBeUndefined()
      expect(cleared.knowledgeScopeMode).toBe('none')
      expect(projectStore.getProject(project.id)).not.toBeNull()
    } finally {
      workspaceManager.deleteAgentWorkspace(workspace.id)
      projectStore.deleteProject(project.id)
    }
  })

  it('Given 会话正在运行 When 切换项目 Then 拒绝避免扩大当前上下文范围', () => {
    const project = projectStore.createProject({ title: '运行中项目', description: '' })
    const workspace = workspaceManager.createAgentWorkspace(`运行中工作区-${Date.now()}`)
    const session = sessionManager.createAgentSession('运行中会话', undefined, workspace.id)
    bindings.bindWorkspaceToProject(project.id, workspace.id)

    try {
      expect(() => updateAgentSessionProjectContext(session.id, project.id, { isSessionActive: () => true }))
        .toThrow('会话正在运行中')
      expect(sessionManager.getAgentSessionMeta(session.id)?.projectId).toBeUndefined()
    } finally {
      workspaceManager.deleteAgentWorkspace(workspace.id)
      projectStore.deleteProject(project.id)
    }
  })
})
