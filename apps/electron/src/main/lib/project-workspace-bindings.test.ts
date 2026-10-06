/**
 * Project ↔ AgentWorkspace 绑定测试 — Project Workspace Bindings Test
 *
 * BDD 行为驱动：覆盖绑定/重复绑定/错误 ID/解绑/项目删除级联清理/数据库重开。
 * 测试隔离：全程使用 PROMA_TEST_CONFIG_DIR 临时目录，结束后清理，
 * 绝不写入真实 ~/.gravitas/ 配置目录。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  closeProjectDb,
  createProject,
  deleteProject,
  initProjectDb,
} from './project-sqlite-store'
import {
  bindWorkspaceToProject,
  hasProjectWorkspaceBinding,
  listProjectWorkspaceBindings,
  listWorkspaceProjectBindings,
  unbindWorkspaceFromProject,
} from './project-workspace-bindings'
import { createAgentWorkspace, deleteAgentWorkspace } from './agent-workspace-manager'

const testDir = join(tmpdir(), `gravitas-pwb-test-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略清理失败
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('绑定项目与工作区', () => {
  test('Given 已存在的项目与工作区 When 绑定 Then 返回绑定记录且双向可列出', () => {
    const project = createProject({ title: '绑定项目A', description: '' })
    const workspace = createAgentWorkspace(`绑定工作区A-${Date.now()}`)
    try {
      const binding = bindWorkspaceToProject(project.id, workspace.id)
      expect(binding).not.toBeNull()
      expect(binding!.projectId).toBe(project.id)
      expect(binding!.workspaceId).toBe(workspace.id)

      const byProject = listProjectWorkspaceBindings(project.id)
      expect(byProject.map((b) => b.workspaceId)).toEqual([workspace.id])

      const byWorkspace = listWorkspaceProjectBindings(workspace.id)
      expect(byWorkspace.map((b) => b.projectId)).toEqual([project.id])
    } finally {
      deleteAgentWorkspace(workspace.id)
    }
  })

  test('Given 同一对项目与工作区 When 重复绑定 Then 幂等返回原绑定且不产生重复记录', () => {
    const project = createProject({ title: '绑定项目B', description: '' })
    const workspace = createAgentWorkspace(`绑定工作区B-${Date.now()}`)
    try {
      const first = bindWorkspaceToProject(project.id, workspace.id)!
      const second = bindWorkspaceToProject(project.id, workspace.id)!
      expect(second.createdAt).toBe(first.createdAt)
      expect(listProjectWorkspaceBindings(project.id)).toHaveLength(1)
    } finally {
      deleteAgentWorkspace(workspace.id)
    }
  })

  test('Given 不存在的项目或工作区 When 绑定 Then 返回 null 且不写入记录', () => {
    const project = createProject({ title: '绑定项目C', description: '' })
    const workspace = createAgentWorkspace(`绑定工作区C-${Date.now()}`)
    try {
      expect(bindWorkspaceToProject('no-such-project', workspace.id)).toBeNull()
      expect(bindWorkspaceToProject(project.id, 'no-such-workspace')).toBeNull()
      expect(listProjectWorkspaceBindings(project.id)).toHaveLength(0)
      expect(listWorkspaceProjectBindings(workspace.id)).toHaveLength(0)
    } finally {
      deleteAgentWorkspace(workspace.id)
    }
  })
})

describe('解绑项目与工作区', () => {
  test('Given 已绑定的项目与工作区 When 解绑 Then 双向列表均移除且返回 true', () => {
    const project = createProject({ title: '解绑项目A', description: '' })
    const workspace = createAgentWorkspace(`解绑工作区A-${Date.now()}`)
    try {
      bindWorkspaceToProject(project.id, workspace.id)
      expect(unbindWorkspaceFromProject(project.id, workspace.id)).toBe(true)
      expect(listProjectWorkspaceBindings(project.id)).toHaveLength(0)
      expect(listWorkspaceProjectBindings(workspace.id)).toHaveLength(0)
    } finally {
      deleteAgentWorkspace(workspace.id)
    }
  })

  test('Given 未绑定的组合 When 解绑 Then 返回 false', () => {
    const project = createProject({ title: '解绑项目B', description: '' })
    expect(unbindWorkspaceFromProject(project.id, 'no-such-workspace')).toBe(false)
  })
})

describe('删除项目级联清理绑定', () => {
  test('Given 项目绑定多个工作区 When 删除项目 Then 绑定全部失效', () => {
    const project = createProject({ title: '删除项目A', description: '' })
    const w1 = createAgentWorkspace(`删除工作区A1-${Date.now()}`)
    const w2 = createAgentWorkspace(`删除工作区A2-${Date.now()}`)
    try {
      bindWorkspaceToProject(project.id, w1.id)
      bindWorkspaceToProject(project.id, w2.id)
      expect(deleteProject(project.id)).toBe(true)
      expect(listProjectWorkspaceBindings(project.id)).toHaveLength(0)
      expect(listWorkspaceProjectBindings(w1.id)).toHaveLength(0)
      expect(listWorkspaceProjectBindings(w2.id)).toHaveLength(0)
    } finally {
      deleteAgentWorkspace(w1.id)
      deleteAgentWorkspace(w2.id)
    }
  })
})

describe('工作空间删除后的实时授权校验', () => {
  test('Given 绑定后删除工作区索引 When 查询绑定 Then 视为失效且不显示在列表', () => {
    const project = createProject({ title: '删除工作区授权项目', description: '' })
    const workspace = createAgentWorkspace(`删除工作区授权-${Date.now()}`)
    bindWorkspaceToProject(project.id, workspace.id)

    deleteAgentWorkspace(workspace.id)

    expect(hasProjectWorkspaceBinding(project.id, workspace.id)).toBe(false)
    expect(listProjectWorkspaceBindings(project.id)).toHaveLength(0)
    expect(listWorkspaceProjectBindings(workspace.id)).toHaveLength(0)
  })
})

describe('数据库重开可用', () => {
  test('Given 已写入绑定 When 关闭并重开数据库 Then 绑定记录仍在', async () => {
    const project = createProject({ title: '重开项目A', description: '' })
    const workspace = createAgentWorkspace(`重开工作区A-${Date.now()}`)
    try {
      bindWorkspaceToProject(project.id, workspace.id)
      closeProjectDb()
      await initProjectDb()
      const byProject = listProjectWorkspaceBindings(project.id)
      expect(byProject.map((b) => b.workspaceId)).toEqual([workspace.id])
    } finally {
      deleteAgentWorkspace(workspace.id)
    }
  })
})
