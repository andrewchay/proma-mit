/**
 * 任务排序存储层测试 — Project Reorder Store Test
 *
 * 覆盖：sort_order 迁移回填、reorderTask 中点法、跨列移动（含完成语义）、
 * 整列重编号、任务创建默认序（最新在前）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import {
  closeProjectDb,
  createProject,
  createTask,
  getProjectDb,
  getTask,
  initProjectDb,
  listTasks,
  reorderTask,
} from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-reorder-test-${Date.now()}`)

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

describe('sort_order 迁移与默认序', () => {
  test('Given 新建项目与任务 When 查询列表 Then 新任务排在最前（负 created_at 序）', async () => {
    const project = createProject({ title: '排序测试项目', description: '' })
    const first = createTask(project.id, { title: '旧任务', description: '' })
    // 确保 created_at 可区分
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = createTask(project.id, { title: '新任务', description: '' })

    expect(first.sortOrder).toBeLessThan(0)
    expect(second.sortOrder).toBeLessThan(first.sortOrder)

    const tasks = listTasks(project.id)
    expect(tasks[0]!.id).toBe(second.id)
    expect(tasks[1]!.id).toBe(first.id)
  })
})

describe('reorderTask 列内排序', () => {
  test('Given 列内两任务 When 移动到末尾 Then 位于旧末尾之后', async () => {
    const project = createProject({ title: '列内排序项目', description: '' })
    const a = createTask(project.id, { title: 'A', description: '' })
    const b = createTask(project.id, { title: 'B', description: '' })
    // 当前顺序（升序）：A -> B（A 更早创建，sort_order 更大）
    const result = reorderTask(a.id, { afterTaskId: b.id })
    expect(result.task.sortOrder).toBeGreaterThan(b.sortOrder)
    expect(result.rewrittenTasks).toEqual([])

    const tasks = listTasks(project.id)
    expect(tasks.map((t) => t.id)).toEqual([b.id, a.id])
  })

  test('Given 列内两任务 When 移动到首位 Then 位于旧首位之前', async () => {
    const project = createProject({ title: '列内排序项目二', description: '' })
    const a = createTask(project.id, { title: 'A', description: '' })
    const b = createTask(project.id, { title: 'B', description: '' })
    const result = reorderTask(b.id, { beforeTaskId: a.id })
    expect(result.task.sortOrder).toBeLessThan(a.sortOrder)
  })

  test('Given 未指定邻居 When 重排 Then 追加到列尾', async () => {
    const project = createProject({ title: '列内排序项目三', description: '' })
    const a = createTask(project.id, { title: 'A', description: '' })
    createTask(project.id, { title: 'B', description: '' })
    const result = reorderTask(a.id, {})
    const tasks = listTasks(project.id)
    expect(tasks[tasks.length - 1]!.id).toBe(a.id)
  })
})

describe('reorderTask 跨列移动', () => {
  test('Given pending 任务 When 拖入 completed 列 Then 状态与 completed_at 同步更新', async () => {
    const project = createProject({ title: '跨列项目', description: '' })
    const task = createTask(project.id, { title: '待办', description: '' })
    const done = createTask(project.id, { title: '锚点', description: '' })
    const finished = reorderTask(task.id, { newStatusId: 'completed', afterTaskId: done.id })

    expect(finished.task.status).toBe('completed')
    expect(finished.task.completedAt).toBeDefined()
    // completed 列内排序在锚点之后
    expect(finished.task.sortOrder).toBeGreaterThan(done.sortOrder)
  })

  test('Given completed 任务 When 拖回 pending 列 Then completed_at 被清空', async () => {
    const project = createProject({ title: '跨列项目二', description: '' })
    const task = createTask(project.id, { title: '待办二', description: '' })
    reorderTask(task.id, { newStatusId: 'completed' })
    const restored = reorderTask(task.id, { newStatusId: 'pending' })
    expect(restored.task.status).toBe('pending')
    expect(restored.task.completedAt).toBeUndefined()
  })
})

describe('reorderTask 邻居契约（跨列落点）', () => {
  test('Given 跨列拖到指定任务之前（仅 beforeTaskId）When 重排 Then 精确落在该任务之前（不回退列尾）', async () => {
    const project = createProject({ title: '跨列列首项目', description: '' })
    const task = createTask(project.id, { title: '移动物', description: '' })
    const anchor = createTask(project.id, { title: '锚点A', description: '' })
    const newer = createTask(project.id, { title: '锚点B-更新', description: '' })
    // 初始展示序（sort_order 升序 = 最新在前）：锚点B → 锚点A → 移动物
    expect(listTasks(project.id).map((t) => t.title)).toEqual(['锚点B-更新', '锚点A', '移动物'])
    // 跨列拖到"锚点A"之前：前端只带 beforeTaskId（上方无邻居，afterTaskId 缺失）
    reorderTask(task.id, { newStatusId: 'pending', beforeTaskId: anchor.id })

    // 旧实现 `after ?? before` 在 after 缺失时才看 before，但邻居不在列首时回退列尾；
    // 修复后必须精确落在锚点A 之前
    expect(listTasks(project.id).map((t) => t.title)).toEqual(['锚点B-更新', '移动物', '锚点A'])
  })

  test('Given 同列两邻居同时给出 When 重排 Then 落在两邻居之间', async () => {
    const project = createProject({ title: '双邻居项目', description: '' })
    // 展示序 = 最新在前（sort_order=-created_at 升序）：后创建的排前面
    const lower = createTask(project.id, { title: '下邻居', description: '' })
    const upper = createTask(project.id, { title: '上邻居', description: '' })
    const moved = createTask(project.id, { title: '移动物', description: '' })
    // 初始展示序：移动物(最新) → 上邻居 → 下邻居（最旧，列尾）
    expect(listTasks(project.id).map((t) => t.title)).toEqual(['移动物', '上邻居', '下邻居'])
    const result = reorderTask(moved.id, { afterTaskId: upper.id, beforeTaskId: lower.id })

    // 落点：上邻居之后、下邻居之前
    expect(listTasks(project.id).map((t) => t.title)).toEqual(['上邻居', '移动物', '下邻居'])
    expect(result.task.sortOrder).toBeGreaterThan(upper.sortOrder)
    expect(result.task.sortOrder).toBeLessThan(lower.sortOrder)
  })

  test('Given 仅 beforeTaskId 且目标在列中 When 重排 Then 精确头插到该任务前', async () => {
    const project = createProject({ title: '头插项目', description: '' })
    const moved = createTask(project.id, { title: '移动物', description: '' })
    const anchor = createTask(project.id, { title: '列首锚点-更新', description: '' })
    // 初始展示序：锚点(最新) → 移动物
    const result = reorderTask(moved.id, { beforeTaskId: anchor.id })

    expect(listTasks(project.id).map((t) => t.title)).toEqual(['移动物', '列首锚点-更新'])
    expect(result.task.sortOrder).toBeLessThan(anchor.sortOrder)
  })
})

describe('sort_order 精度耗尽兜底', () => {
  test('Given 相邻间隙不足 When 插入两任务中间 Then 整列重编号且顺序正确', async () => {
    const project = createProject({ title: '重编号项目', description: '' })
    const a = createTask(project.id, { title: 'A', description: '' })
    const b = createTask(project.id, { title: 'B', description: '' })
    // 人为把间隙压到阈值以下
    const database = getProjectDb()
    database.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`).run(10.0001, b.id)
    database.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`).run(10, a.id)

    const c = createTask(project.id, { title: 'C', description: '' })
    database.prepare(`UPDATE tasks SET sort_order = ? WHERE id = ?`).run(99999, c.id)
    // 把 C 从列尾移到 A 与 B 中间
    const result = reorderTask(c.id, { afterTaskId: a.id, beforeTaskId: b.id })

    expect(result.rewrittenTasks.length).toBe(2) // A、B 重编号（C 本身在插入位单独写）
    // 重编号后顺序：A -> C(插入位) -> B，且各自 sort_order 严格递增
    const tasks = listTasks(project.id)
    const orders = tasks.map((t) => t.sortOrder)
    expect(orders).toEqual([...orders].sort((x, y) => x - y))
    expect(tasks.map((t) => t.id)).toEqual([a.id, c.id, b.id])
  })
})
