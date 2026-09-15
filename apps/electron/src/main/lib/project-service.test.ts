/**
 * listAllProjectTasksLite 测试 — 跨项目轻量任务聚合
 *
 * 过滤规则：无 dueDate 剔除、completed/cancelled 语义组剔除、draft 剔除；
 * 输出带 projectTitle 与 stateGroup，按 dueDate 升序。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { closeProjectDb, initProjectDb } from './project-sqlite-store'
import { createProject, createTask, createTaskDraft, listAllProjectTasksLite, updateTask } from './project-service'

const testDir = join(tmpdir(), `gravitas-tasklite-${Date.now()}`)

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  await initProjectDb()
})

afterAll(() => {
  closeProjectDb()
  try {
    rmSync(testDir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响测试 */
  }
})

describe('listAllProjectTasksLite', () => {
  test('过滤无 dueDate / 完成组 / draft，拼装 projectTitle 与 stateGroup，按 dueDate 升序', async () => {
    const p1 = await createProject({ title: '项目一', description: '' })
    const p2 = await createProject({ title: '项目二', description: '' })
    const today = new Date()
    const dayOffset = (n: number) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate() + n, 12).getTime()

    // p1：逾期未完成（保留）+ 无 dueDate（剔除）+ 已完成（剔除）
    const tOverdue = await createTask(p1.id, { title: '逾期任务', description: '', dueDate: dayOffset(-1) })
    await createTask(p1.id, { title: '无期限任务', description: '' })
    const tDone = await createTask(p1.id, { title: '已完成任务', description: '', dueDate: dayOffset(1) })
    await updateTask(tDone.id, { status: 'completed' })

    // p2：未来任务（保留）+ 草稿（剔除）
    const tFuture = await createTask(p2.id, { title: '未来任务', description: '', dueDate: dayOffset(3) })
    const tDraft = await createTaskDraft(p2.id, { title: '草稿任务', description: '', dueDate: dayOffset(2) })

    const result = await listAllProjectTasksLite()
    const ids = result.map((t) => t.id)
    expect(ids).toContain(tOverdue.id)
    expect(ids).toContain(tFuture.id)
    expect(ids).not.toContain(tDone.id)
    expect(ids).not.toContain(tDraft.id)

    const overdue = result.find((t) => t.id === tOverdue.id)!
    expect(overdue.projectTitle).toBe('项目一')
    // createTask 默认落 'pending' 状态，语义组为 unstarted（非 in_progress/paused 的 started）
    expect(overdue.stateGroup).toBe('unstarted')
    expect(overdue.dueDate).toBeTypeOf('number')

    // 升序
    const dues = result.map((t) => t.dueDate)
    expect([...dues].sort((a, b) => a - b)).toEqual(dues)
  })
})
