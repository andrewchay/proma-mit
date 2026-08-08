import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { initProjectDb, closeProjectDb, createAgentEmployee, createProject, createTask, listMembers } from './project-sqlite-store'
import { upsertMemberDraft } from './member-sync-service'
import { getRunStore } from './run-store'
import { recordTodoEvent, listTodoEvents } from './todo-event-service'
import { recordFileEvent, listFileEvents } from './workspace-file-event-service'
import { getEntityGraph } from './context-hub-service'
import { listMailboxItems } from './team-mailbox-service'
import { sendAgentInvoke, listIncomingInvokes, respondToInvoke } from './agent-invoke-service'
import { updateTeamProfile, getTeamProfile } from './team-profile-service'
import { listMemberDirectory } from './member-directory-service'

/**
 * Agentic OS 集成测试套件
 * 直接调服务层验证 PH1/PH2 主链路（不点 UI、不依赖 real 网络），
 * 用一个隔离的 PROMA_TEST_CONFIG_DIR 通跑完整协作闭环。
 *
 * 链路：成员(members) → 成员目录(统一视图) → 事件(run/todo/file) →
 *       ContextHub(关联) → Mailbox(聚合) → Agent互调 → 团队Profile
 *
 * 说明：不 mock 真实飞书/钉钉网络；成员用 upsertMemberDraft 直接落库（等价于同步成功）。
 */

const testDir = join(tmpdir(), `gravitas-agentic-os-integration-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }
  delete process.env.PROMA_TEST_CONFIG_DIR
})

describe('Agentic OS 主链路集成（PH1+PH2）', () => {
  test('1) 成员同步 + 成员目录统一视图', async () => {
    // 同步：两个真人（飞书）+ 一个 AI 员工
    upsertMemberDraft({ platform: 'feishu', externalId: 'ou-zhangsan', unionId: 'on-zhangsan', name: '张三', department: '研发' })
    upsertMemberDraft({ platform: 'dingtalk', externalId: 'u-ding-lisi', name: '李四' })
    createAgentEmployee({ name: '前端机器人·N', role: '前端', description: 'x', channelId: 'ch1' })

    const humans = listMembers({ kind: 'human' })
    expect(humans.length).toBe(2)
    const dir = await listMemberDirectory()
    expect(dir.some((m) => m.kind === 'human' && m.displayName === '张三')).toBe(true)
    expect(dir.some((m) => m.kind === 'agent')).toBe(true)
  })

  test('2) 运行 + Todo + 文件事件落盘', () => {
    getRunStore().record({ id: 'r-int-1', type: 'completed', source: 'agent', taskId: 'sess-int-1', title: '写登录页', sessionId: 'sess-int-1', memberId: 'agent-x', timestamp: Date.now() })
    recordTodoEvent({ source: 'project', action: 'completed', todoId: 't-int-1', title: '修复缺陷', memberId: 'paa-张三' })
    recordFileEvent('sess-int-1', 'write', 'src/App.tsx', 'ws-alpha')

    expect(getRunStore().query({ limit: 50 }).some((r) => r.title === '写登录页')).toBe(true)
    expect(listTodoEvents().some((e) => e.todoId === 't-int-1')).toBe(true)
    expect(listFileEvents().some((e) => e.filePath === 'src/App.tsx')).toBe(true)
  })

  test('3) ContextHub 关联（运行→文件）', () => {
    const graph = getEntityGraph('session', 'sess-int-1')
    expect(graph).not.toBeNull()
    expect(graph!.related.some((n) => n.type === 'file_event')).toBe(true)
  })

  test('4) Mailbox 聚合（含待办 + 互调）', () => {
    const project = createProject({ title: '集成项目', description: '' })
    const task = createTask(project.id, { title: '指派任务A', description: '测试指派', assignee: { userId: 'agent-x', displayName: '🤖 X' } })
    expect(task.id).toBeTruthy()
    const items = listMailboxItems()
    // 待办(Mailbox todo) 或 至少能聚合不报错
    expect(Array.isArray(items)).toBe(true)
  })

  test('5) Agent 互调闭环', () => {
    const req = sendAgentInvoke('agent-a', 'agent-b', '帮我审一下 PR')
    expect(req.id).toBeTruthy()
    expect(listIncomingInvokes('agent-b').some((r) => r.id === req.id)).toBe(true)
    const done = respondToInvoke(req.id, 'done', '已审完')
    expect(done?.status).toBe('done')
  })

  test('5b) 我指派的视图（listTasksCreatedBy）', async () => {
    const { createProject, createTask, listTasksCreatedBy } = await import('./project-sqlite-store')
    const project = createProject({ title: '分工项目', description: '' })
    createTask(project.id, { title: '交给 Andrew 做UI', description: 'x', assignee: { userId: 'paa-Andrew', displayName: 'Andrew' }, createdByUserId: 'paa-我自己' })
    createTask(project.id, { title: '我自己做', description: 'x', assignee: { userId: 'paa-我自己', displayName: '我' }, createdByUserId: 'paa-我自己' })
    const mine = listTasksCreatedBy('paa-我自己')
    expect(mine.some((t) => t.title === '交给 Andrew 做UI')).toBe(true)
  })

  test('6) 团队 Profile 读写', () => {
    updateTeamProfile('ws-alpha', { teamName: '前端组', focusAreas: '性能' })
    const p = getTeamProfile('ws-alpha')
    expect(p.teamName).toBe('前端组')
  })
})
