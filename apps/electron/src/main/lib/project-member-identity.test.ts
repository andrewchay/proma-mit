/**
 * 成员身份统一存储层测试 — Member Identity Store Test
 *
 * 覆盖：ensureMemberByName 幂等创建、backfillTaskMemberIds 存量回填与幂等、
 * listMyWork 按 member_id 精确匹配与归一化名字兑底。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  backfillTaskMemberIds,
  closeProjectDb,
  createMember,
  createProject,
  createTask,
  ensureMemberByName,
  getMember,
  getProjectDb,
  initProjectDb,
  listMembers,
  listMyWork,
} from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-member-identity-test-${Date.now()}`)

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

describe('ensureMemberByName', () => {
  test('Given 首次按名字确保 When 调用两次 Then 返回同一成员且不重复创建', () => {
    const first = ensureMemberByName('  identity user ')
    const second = ensureMemberByName('Identity   User')
    expect(first.memberId).toBe(second.memberId)
    const all = listMembers({ q: 'identity' })
    expect(all.filter((m) => m.displayName === 'identity user').length).toBe(1)
  })
})

describe('backfillTaskMemberIds', () => {
  test('Given 旧格式 assignee/creator 的任务 When 回填 Then member_id 写入且幂等（不重复建成员）', () => {
    const project = createProject({ title: '回填测试项目', description: '' })
    // 预建同名成员（大小写+空格差异），验证归一化命中而不新建
    const member = createMember({ kind: 'human', displayName: 'Carol W', source: 'manual' })
    const membersBefore = listMembers({}).length
    // 直接 SQL 插入旧格式行（member_id 为空）
    const database = getProjectDb()
    database.prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_user_id, assignee_display_name, created_by_user_id, created_at, updated_at, sort_order)
       VALUES (?, ?, ?, ?, 'pending', 'medium', ?, ?, ?, ?, ?, 0)`,
    ).run('legacy-task-1', project.id, '旧格式任务', '', 'paa-carol  w', 'Carol W', 'paa-Carol W', Date.now(), Date.now())

    backfillTaskMemberIds(database)
    const row = database.prepare(`SELECT * FROM tasks WHERE id = 'legacy-task-1'`).get() as {
      assignee_member_id: string | null; created_by_member_id: string | null
    }
    expect(row.assignee_member_id).toBe(member.memberId)
    expect(row.created_by_member_id).toBe(member.memberId)

    // 幂等：二次回填不新建成员
    backfillTaskMemberIds(database)
    expect(listMembers({}).length).toBe(membersBefore)
  })

  test('Given 目录中无同名成员的旧任务 When 回填 Then 自动创建 human 成员并回填', () => {
    const project = createProject({ title: '回填自动建成员项目', description: '' })
    const database = getProjectDb()
    database.prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_user_id, assignee_display_name, created_at, updated_at, sort_order)
       VALUES (?, ?, ?, ?, 'pending', 'medium', ?, ?, ?, ?, 0)`,
    ).run('legacy-task-2', project.id, '新名字任务', '', 'paa-brand-new-person', 'Brand New Person', Date.now(), Date.now())

    backfillTaskMemberIds(database)
    const row = database.prepare(`SELECT assignee_member_id FROM tasks WHERE id = 'legacy-task-2'`).get() as { assignee_member_id: string }
    expect(row.assignee_member_id).toBeTruthy()
    expect(getMember(row.assignee_member_id!)?.displayName).toBe('Brand New Person')
  })

  test('Given agent- 前缀的旧任务 When 回填 Then 不迁移不建成员', () => {
    const project = createProject({ title: 'AI 员工不迁移项目', description: '' })
    const database = getProjectDb()
    database.prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, assignee_user_id, created_at, updated_at, sort_order)
       VALUES (?, ?, ?, ?, 'pending', 'medium', ?, ?, ?, 0)`,
    ).run('legacy-task-3', project.id, 'AI 任务', '', 'agent-abc', Date.now(), Date.now())
    const membersBefore = listMembers({}).length

    backfillTaskMemberIds(database)
    const row = database.prepare(`SELECT assignee_member_id FROM tasks WHERE id = 'legacy-task-3'`).get() as { assignee_member_id: string | null }
    expect(row.assignee_member_id).toBeNull()
    expect(listMembers({}).length).toBe(membersBefore)
  })
})

describe('listMyWork 按 member_id', () => {
  test('Given member_id 指派与旧格式指派 When 以 memberId 查询 Then 精确与兑底都能命中，他人不误匹配', () => {
    const project = createProject({ title: 'member 查询项目', description: '' })
    const carol = ensureMemberByName('Carol Query')
    createTask(project.id, {
      title: 'member 指派任务',
      description: '',
      assignee: { userId: 'paa-Carol Query', displayName: 'Carol Query' },
      assigneeMemberId: carol.memberId,
    })
    createTask(project.id, {
      title: '旧格式指派任务',
      description: '',
      assignee: { userId: 'paa-carol  query', displayName: 'CAROL QUERY' },
    })
    createTask(project.id, {
      title: '他人任务',
      description: '',
      assignee: { userId: 'paa-someone', displayName: 'Someone' },
    })

    const items = listMyWork(carol.memberId)
    const titles = items.map((item) => item.title)
    expect(titles).toContain('member 指派任务')
    expect(titles).toContain('旧格式指派任务')
    expect(titles).not.toContain('他人任务')
  })
})
