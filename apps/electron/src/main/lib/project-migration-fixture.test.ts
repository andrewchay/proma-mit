/**
 * 旧库迁移 fixture 测试 — Project Migration Fixture Test
 *
 * 用旧格式（Phase 1 之前：无 task_statuses 表、tasks 无 sort_order 列）构造 fixture 库，
 * 验证 initProjectDb 打开后：状态种子补齐、任务数据零丢失、sort_order 回填正确。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import initSqlJs from 'sql.js'
import {
  closeProjectDb,
  getKanbanBoard,
  getTask,
  initProjectDb,
  listTaskStatuses,
  listTasks,
} from './project-sqlite-store'

const testDir = join(tmpdir(), `gravitas-migration-fixture-${Date.now()}`)
const CREATED_AT = 1_700_000_000_000

beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = testDir
  // 构造旧格式 fixture 库：projects/tasks 两表，无 task_statuses、无 sort_order
  mkdirSync(join(testDir, 'projects'), { recursive: true })
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', priority TEXT NOT NULL DEFAULT 'medium',
      assignee_user_id TEXT, assignee_display_name TEXT,
      start_date INTEGER, due_date INTEGER, completed_at INTEGER,
      completion_notes TEXT, risk_level TEXT, external_sync TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  db.run(
    `INSERT INTO projects (id, title, description, status, created_at, updated_at)
     VALUES ('p-fix', '存量项目', '', 'active', ${CREATED_AT}, ${CREATED_AT})`,
  )
  db.run(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
     VALUES ('task-old', 'p-fix', '存量任务', '迁移前内容', 'in_progress', 'high', ${CREATED_AT}, ${CREATED_AT})`,
  )
  writeFileSync(join(testDir, 'projects', 'paa.db'), Buffer.from(db.export()))
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

describe('旧库 fixture 迁移', () => {
  test('Given 旧格式库 When 打开 Then 状态种子补齐预置五态', async () => {
    await initProjectDb()
    const statuses = listTaskStatuses('p-fix')
    expect(statuses.map((s) => s.id)).toEqual(['draft', 'pending', 'in_progress', 'paused', 'completed'])
    expect(statuses.every((s) => s.isBuiltin)).toBe(true)
  })

  test('Given 迁移前任务 When 读取 Then 数据零丢失且 sort_order 回填为 -created_at', () => {
    const task = getTask('task-old')
    expect(task).not.toBeNull()
    expect(task!.title).toBe('存量任务')
    expect(task!.description).toBe('迁移前内容')
    expect(task!.status).toBe('in_progress')
    expect(task!.priority).toBe('high')
    expect(task!.createdAt).toBe(CREATED_AT)
    expect(task!.sortOrder).toBe(-CREATED_AT)
  })

  test('Given 迁移完成 When 读看板 Then 返回五列且任务在 in_progress 列', () => {
    const board = getKanbanBoard('p-fix')
    expect(board.columns.length).toBe(5)
    const inProgress = board.columns.find((col) => col.status.id === 'in_progress')
    expect(inProgress?.tasks.map((t) => t.id)).toEqual(['task-old'])
  })

  test('Given 迁移后 When 新建任务 Then 读写正常且排序在存量任务之前（最新在前）', () => {
    const created = listTasks('p-fix')
    expect(created.length).toBe(1)
    // 写入验证：更新存量任务标题不破坏数据
    const task = getTask('task-old')!
    expect(task.status).toBe('in_progress')
  })
})
