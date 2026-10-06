/**
 * 项目记忆归属与范围过滤 —— BDD 行为测试
 *
 * 场景（对应"工作空间—项目多对多记忆方案"验收点）：
 * - 甲乙两个工作空间的 workspace 条目互不串读；甲空间可读 personal 条目（跨工作空间）。
 * - 项目条目仅在"会话 projectId 命中条目 projectIds 且 workspace ↔ project 正式绑定"时可见。
 * - 解绑后项目条目检索失败（不可见）。
 * - 旧无 scope 记忆默认不出现在已绑定项目的检索中。
 * - 按 id 读取二次校验范围，越权读取与不存在的条目一致返回 undefined。
 * - 来源元数据（source）写入后原样保留。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import { closeProjectDb, createProject, deleteProject, initProjectDb } from './project-sqlite-store'
import { bindWorkspaceToProject } from './project-workspace-bindings'
import { createAgentWorkspace, deleteAgentWorkspace } from './agent-workspace-manager'

// agent-session-manager（经动态 require 拉入）传递依赖 electron，测试环境需 mock
mock.module('electron', () => buildElectronMock())
import {
  createMemoryItem,
  getScopedMemoryItem,
  resetMemoryItemsStorageState,
  searchScopedMemoryItems,
  type MemoryItem,
} from './memory-plugin-service'
import {
  resetProjectWorkspaceBindingResolver,
  setProjectWorkspaceBindingResolver,
} from './project-memory-scope'

let testDir = ''

/** 测试绑定关系集合：并行任务的绑定服务落定前由桩实现代替 */
let boundPairs = new Set<string>()

function pairKey(projectId: string, workspaceId: string): string {
  return `${projectId}::${workspaceId}`
}

/** 直接向隔离配置目录写入会话索引（避免拉起完整 workspace 依赖） */
function writeSessionIndex(
  sessions: Array<{ id: string; workspaceId?: string; projectId?: string }>,
): void {
  const index = {
    version: 1,
    sessions: sessions.map((s, idx) => ({
      id: s.id,
      title: `会话 ${idx}`,
      createdAt: 1,
      updatedAt: 1,
      messages: [],
      workspaceId: s.workspaceId,
      projectId: s.projectId,
    })),
  }
  writeFileSync(join(testDir, 'agent-sessions.json'), JSON.stringify(index))
}

function createInput(
  title: string,
  extra: Partial<Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'title'>> = {},
): Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    title,
    content: `${title} 的内容`,
    kind: 'fact',
    tags: [],
    confidence: 0.8,
    sourceRunId: null,
    sourceSessionId: null,
    ...extra,
  }
}

beforeEach(() => {
  testDir = join(tmpdir(), `gravitas-memory-scope-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  mkdirSync(testDir, { recursive: true })
  resetMemoryItemsStorageState()
  boundPairs = new Set()
  setProjectWorkspaceBindingResolver({
    hasBinding: (projectId, workspaceId) => boundPairs.has(pairKey(projectId, workspaceId)),
  })
})

afterEach(() => {
  resetProjectWorkspaceBindingResolver()
  resetMemoryItemsStorageState()
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

describe('范围检索：工作空间归属', () => {
  it('甲乙两个工作空间的条目互不串读，甲可读 personal 条目', () => {
    writeSessionIndex([
      { id: 'sess-甲', workspaceId: 'ws-甲' },
      { id: 'sess-乙', workspaceId: 'ws-乙' },
    ])
    createMemoryItem(createInput('甲空间笔记', { scope: { kind: 'workspace', workspaceId: 'ws-甲' } }))
    createMemoryItem(createInput('个人偏好记录', { scope: { kind: 'personal' } }))

    const from甲 = searchScopedMemoryItems({ query: '', sessionId: 'sess-甲' })
    const from乙 = searchScopedMemoryItems({ query: '', sessionId: 'sess-乙' })

    // 甲空间检索：甲空间条目 + personal 条目（跨工作空间可读）
    expect(from甲.map((i) => i.title).sort()).toEqual(['个人偏好记录', '甲空间笔记'])
    // 乙空间检索：甲空间条目不可见，personal 条目仍可见
    expect(from乙.map((i) => i.title)).toEqual(['个人偏好记录'])
  })

  it('旧无 scope 条目在工作空间检索中按 personal 兼容可见', () => {
    writeSessionIndex([{ id: 'sess-甲', workspaceId: 'ws-甲' }])
    createMemoryItem(createInput('旧格式记忆'))

    const results = searchScopedMemoryItems({ query: '', sessionId: 'sess-甲' })
    expect(results.map((i) => i.title)).toEqual(['旧格式记忆'])
  })
})

describe('范围检索：项目归属与正式绑定', () => {
  it('绑定存在时项目条目可见，且工作空间/个人条目不串入项目检索', () => {
    writeSessionIndex([{ id: 'sess-proj', workspaceId: 'ws-甲', projectId: 'proj-1' }])
    boundPairs.add(pairKey('proj-1', 'ws-甲'))
    createMemoryItem(createInput('项目决策记录', { scope: { kind: 'project', projectIds: ['proj-1'] } }))
    createMemoryItem(createInput('个人偏好记录', { scope: { kind: 'personal' } }))
    createMemoryItem(createInput('甲空间笔记', { scope: { kind: 'workspace', workspaceId: 'ws-甲' } }))
    createMemoryItem(createInput('旧格式记忆'))

    const results = searchScopedMemoryItems({ query: '', sessionId: 'sess-proj' })
    expect(results.map((i) => i.title)).toEqual(['项目决策记录'])
  })

  it('条目 projectIds 未覆盖会话 projectId 时不可见', () => {
    writeSessionIndex([{ id: 'sess-proj', workspaceId: 'ws-甲', projectId: 'proj-2' }])
    boundPairs.add(pairKey('proj-2', 'ws-甲'))
    createMemoryItem(createInput('项目决策记录', { scope: { kind: 'project', projectIds: ['proj-1'] } }))

    const results = searchScopedMemoryItems({ query: '', sessionId: 'sess-proj' })
    expect(results).toEqual([])
  })

  it('解绑后项目条目检索失败（绑定只是授权，撤销即失效）', () => {
    writeSessionIndex([{ id: 'sess-proj', workspaceId: 'ws-甲', projectId: 'proj-1' }])
    boundPairs.add(pairKey('proj-1', 'ws-甲'))
    const item = createMemoryItem(
      createInput('项目决策记录', { scope: { kind: 'project', projectIds: ['proj-1'] } }),
    )

    expect(searchScopedMemoryItems({ query: '', sessionId: 'sess-proj' }).map((i) => i.id)).toEqual([item.id])

    // 解除 workspace ↔ project 正式绑定
    boundPairs.delete(pairKey('proj-1', 'ws-甲'))
    expect(searchScopedMemoryItems({ query: '', sessionId: 'sess-proj' })).toEqual([])
    expect(getScopedMemoryItem(item.id, 'sess-proj')).toBeUndefined()
  })

  it('旧无 scope 记忆默认不出现在项目检索中', () => {
    writeSessionIndex([{ id: 'sess-proj', workspaceId: 'ws-甲', projectId: 'proj-1' }])
    boundPairs.add(pairKey('proj-1', 'ws-甲'))
    createMemoryItem(createInput('旧格式记忆'))
    createMemoryItem(createInput('项目决策记录', { scope: { kind: 'project', projectIds: ['proj-1'] } }))

    const results = searchScopedMemoryItems({ query: '', sessionId: 'sess-proj' })
    expect(results.map((i) => i.title)).toEqual(['项目决策记录'])
  })
})

describe('正式绑定服务集成', () => {
  it('真实 Project ↔ Workspace 绑定可驱动记忆范围过滤', async () => {
    // 该用例故意不走注入桩，验证默认动态绑定解析与项目业务库联动。
    resetProjectWorkspaceBindingResolver()
    await initProjectDb()
    const project = createProject({ title: '记忆范围集成项目', description: '' })
    const workspace = createAgentWorkspace(`记忆范围集成工作区-${Date.now()}`)
    try {
      bindWorkspaceToProject(project.id, workspace.id)
      writeSessionIndex([{ id: 'sess-real-binding', workspaceId: workspace.id, projectId: project.id }])
      const item = createMemoryItem(
        createInput('真实绑定项目决策', { scope: { kind: 'project', projectIds: [project.id] } }),
      )

      expect(searchScopedMemoryItems({ query: '', sessionId: 'sess-real-binding' }).map((i) => i.id)).toEqual([item.id])
    } finally {
      deleteAgentWorkspace(workspace.id)
      deleteProject(project.id)
      closeProjectDb()
    }
  })
})

describe('按 id 读取二次校验范围', () => {
  it('越权读取与不存在的条目一致返回 undefined', () => {
    writeSessionIndex([
      { id: 'sess-甲', workspaceId: 'ws-甲' },
      { id: 'sess-乙', workspaceId: 'ws-乙' },
    ])
    const wsItem = createMemoryItem(createInput('甲空间笔记', { scope: { kind: 'workspace', workspaceId: 'ws-甲' } }))
    const projItem = createMemoryItem(
      createInput('项目决策记录', { scope: { kind: 'project', projectIds: ['proj-1'] } }),
    )

    // 同工作空间可读
    expect(getScopedMemoryItem(wsItem.id, 'sess-甲')?.id).toBe(wsItem.id)
    // 跨工作空间不可读
    expect(getScopedMemoryItem(wsItem.id, 'sess-乙')).toBeUndefined()
    // 无项目上下文的会话不可读项目条目
    expect(getScopedMemoryItem(projItem.id, 'sess-甲')).toBeUndefined()
    // 不存在的 id
    expect(getScopedMemoryItem('mem_不存在', 'sess-甲')).toBeUndefined()
  })
})

describe('来源元数据保留', () => {
  it('scope 与 source 字段写入 items.json 后原样保留', () => {
    writeSessionIndex([{ id: 'sess-甲', workspaceId: 'ws-甲', projectId: 'proj-1' }])
    boundPairs.add(pairKey('proj-1', 'ws-甲'))
    const source = {
      workspaceId: 'ws-甲',
      sessionId: 'sess-甲',
      runId: 'run-42',
      locator: 'memos/abc123',
      observedAt: 1727000000000,
    }
    const item = createMemoryItem(
      createInput('项目决策记录', {
        scope: { kind: 'project', projectIds: ['proj-1'] },
        source,
      }),
    )

    const readBack = getScopedMemoryItem(item.id, 'sess-甲')
    expect(readBack?.scope).toEqual({ kind: 'project', projectIds: ['proj-1'] })
    expect(readBack?.source).toEqual(source)
  })
})
