/**
 * 项目管理 SQLite 数据层 — Project SQLite Store
 *
 * 本地 SQLite 作为项目管理唯一数据源（弃用 NocoBase）。
 * 全部数据操作在此实现，project-service.ts 保持对外接口不变。
 *
 * 技术选型：better-sqlite3（同步 API，Electron 39 / ABI 140 直接可用）。
 * 存储位置：~/.paa/projects/paa.db
 *
 * v1.0 — 本地 SQLite 唯一数据源
 */

import { randomUUID } from 'node:crypto'
import initSqlJs from 'sql.js'
import { getProjectsDir } from './config-paths'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  Project,
  Task,
  TaskAssignee,
  MeetingNote,
  UserMapping,
  CreateProjectInput,
  CreateTaskInput,
  ListTasksFilter,
  KanbanBoard,
  ProjectProgress,
  SaveUserMappingInput,
  SubTask,
  CreateExecutionSubTaskInput,
  TodoRetryEvent,
  TaskDependency,
  TaskDependencyType,
  TaskBlocker,
  MyWorkItem,
  ProjectActivity,
  ProjectTemplate,
  BriefReceipt,
} from './project-types'

// ===== 数据库连接 =====

// sql.js 兼容包装：向业务代码暴露 better-sqlite3 风格的 prepare().get/all/run + transaction。
// sql.js 为内存库 + 手动 export 持久化，写操作后同步落盘（项目管理写频率低，可接受）。

let db: SqliteCompat | null = null
let sqlJsPromise: Promise<any> | null = null

function loadSqlJs(): Promise<any> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      // esbuild 打包后模块路径变化，显式从 node_modules 定位 wasm 文件
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    })
  }
  return sqlJsPromise
}

/** 获取（或初始化）项目管理数据库 */
export function getProjectDb(): SqliteCompat {
  if (db) return db
  throwIfNotReady()
  return db!
}

let dbReady = false
let dbInitPromise: Promise<void> | null = null

/** 异步初始化数据库（Electron 启动时调用） */
export async function initProjectDb(): Promise<void> {
  if (dbReady) return
  if (dbInitPromise) return dbInitPromise
  dbInitPromise = (async () => {
    const SQL = await loadSqlJs()
    const dir = getProjectsDir()
    const dbPath = join(dir, 'paa.db')
    const existing = existsSync(dbPath) ? readFileSync(dbPath) : undefined
    const database = new SQL.Database(existing as Uint8Array | undefined)
    db = new SqliteCompat(database, dbPath)
    migrate(database)
    dbReady = true
  })()
  await dbInitPromise
}

function throwIfNotReady(): void {
  if (!dbReady) throw new Error('项目管理数据库未初始化，请先调用 initProjectDb()')
}

/** 关闭数据库（测试/退出时调用） */
export function closeProjectDb(): void {
  if (db) {
    db.persist()
    db.close()
    db = null
    dbReady = false
    dbInitPromise = null
  }
}

// ===== sql.js 兼容包装 =====

class SqliteCompat {
  private database: any
  private filePath: string
  private inTransaction = false

  constructor(database: any, filePath: string) {
    this.database = database
    this.filePath = filePath
  }

  /** 持久化：将内存库导出写入磁盘 */
  persist(): void {
    if (this.inTransaction) return
    try {
      const data = this.database.export()
      writeFileSync(this.filePath, data)
    } catch (error) {
      console.error('[ProjectStore] SQLite 持久化失败:', error)
    }
  }

  prepare(sql: string): StmtCompat {
    return new StmtCompat(this.database, sql, this)
  }

  /** 执行多条 SQL（迁移用） */
  exec(sql: string): void {
    this.database.exec(sql)
    this.persist()
  }

  /** 返回最近一次写操作影响的行数 */
  getRowsModified(): number {
    return this.database.getRowsModified()
  }

  /** 事务：返回一个执行函数（与 better-sqlite3 的 transaction() 行为一致，支持嵌套） */
  transaction(fn: () => void): () => void {
    return () => {
      if (this.inTransaction) {
        // 已在外层事务中：直接执行，由外层统一提交/回滚
        fn()
        return
      }
      this.database.run('BEGIN')
      this.inTransaction = true
      try {
        fn()
        this.database.run('COMMIT')
      } catch (error) {
        try {
          this.database.run('ROLLBACK')
        } catch {
          // 回滚失败不掩盖原始错误
        }
        throw error
      } finally {
        this.inTransaction = false
        this.persist()
      }
    }
  }

  close(): void {
    this.database.close()
  }
}

class StmtCompat {
  private statement: any
  private owner: SqliteCompat

  constructor(database: any, sql: string, owner: SqliteCompat) {
    this.statement = database.prepare(sql)
    this.owner = owner
  }

  get(...params: Array<string | number | null>): unknown {
    try {
      this.statement.bind(params as never[])
      const row = this.statement.step() ? this.statement.getAsObject() : undefined
      return row
    } finally {
      this.statement.free()
    }
  }

  all(...params: Array<string | number | null>): unknown[] {
    try {
      this.statement.bind(params as never[])
      const rows: unknown[] = []
      while (this.statement.step()) rows.push(this.statement.getAsObject())
      return rows
    } finally {
      this.statement.free()
    }
  }

  run(...params: Array<string | number | null>): { changes: number } {
    try {
      this.statement.bind(params as never[])
      this.statement.step()
      return { changes: this.owner.getRowsModified() }
    } finally {
      this.statement.free()
      this.owner.persist()
    }
  }
}

// ===== Schema 迁移 =====

function migrate(database: any): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      assignee_user_id TEXT,
      assignee_display_name TEXT,
      start_date INTEGER,
      due_date INTEGER,
      completed_at INTEGER,
      completion_notes TEXT,
      risk_level TEXT,
      external_sync TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_user_id);

    CREATE TABLE IF NOT EXISTS execution_subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assignee_user_id TEXT,
      assignee_display_name TEXT,
      start_date INTEGER,
      due_date INTEGER,
      completed_at INTEGER,
      completion_notes TEXT,
      external_sync TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subtasks_task ON execution_subtasks(task_id);

    CREATE TABLE IF NOT EXISTS meeting_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      raw_content TEXT NOT NULL DEFAULT '',
      extracted_task_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_project ON meeting_notes(project_id);

    CREATE TABLE IF NOT EXISTS user_mappings (
      paa_user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      feishu_user_id TEXT,
      dingtalk_user_id TEXT,
      dingtalk_union_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      event_type TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox_events(status);

    CREATE TABLE IF NOT EXISTS task_dependencies (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'finish_to_start',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deps_task ON task_dependencies(task_id);

    CREATE TABLE IF NOT EXISTS project_activities (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      action TEXT,
      summary TEXT,
      payload TEXT,
      actor TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_project ON project_activities(project_id);

    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      template_data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS risk_assessments (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      sub_task_id TEXT,
      project_id TEXT,
      overall_level TEXT,
      requires_completion_notes INTEGER NOT NULL DEFAULT 0,
      risk_items TEXT,
      suggestion TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS brief_receipts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      union_id TEXT NOT NULL,
      brief TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      content TEXT,
      form_url TEXT,
      created_at INTEGER NOT NULL,
      responded_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_briefs_task ON brief_receipts(task_id);
  `)
}

// ===== 行映射工具 =====

type ProjectRow = {
  id: string; title: string; description: string; status: string;
  created_at: number; updated_at: number;
}

type TaskRow = {
  id: string; project_id: string; parent_id: string | null;
  title: string; description: string; status: string; priority: string;
  assignee_user_id: string | null; assignee_display_name: string | null;
  start_date: number | null; due_date: number | null; completed_at: number | null;
  completion_notes: string | null; risk_level: string | null; external_sync: string | null;
  created_at: number; updated_at: number;
}

type SubTaskRow = {
  id: string; task_id: string; title: string; status: string;
  assignee_user_id: string | null; assignee_display_name: string | null;
  start_date: number | null; due_date: number | null; completed_at: number | null;
  completion_notes: string | null; external_sync: string | null;
  created_at: number; updated_at: number;
}

function now(): number {
  return Date.now()
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as Project['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToTask(row: TaskRow): Task {
  const assignee: TaskAssignee | undefined =
    row.assignee_user_id ? { userId: row.assignee_user_id, displayName: row.assignee_display_name ?? row.assignee_user_id } : undefined
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id ?? undefined,
    title: row.title,
    description: row.description,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    assignee,
    startDate: row.start_date ?? undefined,
    dueDate: row.due_date ?? undefined,
    completedAt: row.completed_at ?? undefined,
    completionNotes: row.completion_notes ?? undefined,
    riskLevel: (row.risk_level as Task['riskLevel'] | undefined) ?? undefined,
    externalSync: row.external_sync ? JSON.parse(row.external_sync) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToSubTask(row: SubTaskRow, projectId: string, taskId?: string): SubTask {
  const assignee: TaskAssignee | undefined =
    row.assignee_user_id ? { userId: row.assignee_user_id, displayName: row.assignee_display_name ?? row.assignee_user_id } : undefined
  return {
    entityType: 'subTask',
    id: row.id,
    taskId: taskId ?? row.task_id,
    projectId,
    title: row.title,
    status: row.status as Task['status'],
    assignee,
    startDate: row.start_date ?? undefined,
    dueDate: row.due_date ?? undefined,
    completedAt: row.completed_at ?? undefined,
    completionNotes: row.completion_notes ?? undefined,
    externalSync: row.external_sync ? JSON.parse(row.external_sync) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ===== 项目 CRUD =====

export function createProject(input: CreateProjectInput): Project {
  const database = getProjectDb()
  const id = randomUUID()
  const timestamp = now()
  database.prepare(
    `INSERT INTO projects (id, title, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.title, input.description ?? '', input.status ?? 'active', timestamp, timestamp)
  const row = database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow
  return rowToProject(row)
}

export function listProjects(): Project[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as ProjectRow[]
  return rows.map(rowToProject)
}

export function getProject(id: string): Project | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined
  return row ? rowToProject(row) : null
}

export function updateProject(id: string, updates: Partial<Omit<Project, 'id' | 'createdAt'>>): Project | null {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined
  if (!existing) return null
  const next: ProjectRow = {
    ...existing,
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    status: updates.status ?? existing.status,
    updated_at: now(),
  }
  database.prepare(
    `UPDATE projects SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?`
  ).run(next.title, next.description, next.status, next.updated_at, id)
  return rowToProject(next)
}

export function deleteProject(id: string): boolean {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined
  if (!existing) return false
  const tx = database.transaction(() => {
    // 级联删除项目下所有数据
    const tasks = database.prepare(`SELECT id FROM tasks WHERE project_id = ?`).all(id) as Array<{ id: string }>
    for (const task of tasks) deleteTask(task.id)
    database.prepare(`DELETE FROM meeting_notes WHERE project_id = ?`).run(id)
    database.prepare(`DELETE FROM project_activities WHERE project_id = ?`).run(id)
    database.prepare(`DELETE FROM outbox_events WHERE project_id = ?`).run(id)
    database.prepare(`DELETE FROM risk_assessments WHERE project_id = ?`).run(id)
    database.prepare(`DELETE FROM projects WHERE id = ?`).run(id)
  })
  tx()
  return (getProjectDb().prepare(`SELECT COUNT(*) AS c FROM projects WHERE id = ?`).get(id) as { c: number }).c === 0
}

// ===== 任务 CRUD =====

export function createTask(projectId: string, input: CreateTaskInput): Task {
  const database = getProjectDb()
  const id = randomUUID()
  const timestamp = now()
  database.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, description, status, priority,
      assignee_user_id, assignee_display_name, start_date, due_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, input.parentId ?? null, input.title, input.description ?? '',
    'pending', input.priority ?? 'medium',
    input.assignee?.userId ?? null, input.assignee?.displayName ?? null,
    input.startDate ?? null, input.dueDate ?? null, timestamp, timestamp
  )
  recordProjectActivity({
    projectId,
    entityType: 'task',
    entityId: id,
    action: 'created',
    summary: `创建任务「${input.title}」`,
  })
  return getTask(id)!
}

export function listTasks(projectId: string, filter?: ListTasksFilter): Task[] {
  const database = getProjectDb()
  const conditions: string[] = ['project_id = ?']
  const params: Array<string | number> = [projectId]
  if (filter?.status) {
    conditions.push('status = ?')
    params.push(filter.status)
  } else if (!filter?.includeDrafts) {
    conditions.push("status != 'draft'")
  }
  const sql = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`
  let rows = database.prepare(sql).all(...params) as TaskRow[]
  if (!filter?.includeSubTasks) {
    rows = rows.filter((row) => !row.parent_id)
  }
  let tasks = rows.map(rowToTask)
  if (filter?.assigneeUserId) {
    tasks = tasks.filter((task) => task.assignee?.userId === filter.assigneeUserId)
  }
  return tasks
}

export function getTask(id: string): Task | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

export function updateTask(id: string, updates: Partial<Omit<Task, 'id' | 'projectId' | 'createdAt'>>): Task | null {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  if (!existing) return null
  let completedAt = existing.completed_at
  if (updates.status === 'completed') completedAt = now()
  else if (updates.status !== undefined) completedAt = null
  const next: TaskRow = {
    ...existing,
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    status: updates.status ?? existing.status,
    priority: updates.priority ?? existing.priority,
    parent_id: updates.parentId !== undefined ? updates.parentId : existing.parent_id,
    assignee_user_id: updates.assignee ? updates.assignee.userId : existing.assignee_user_id,
    assignee_display_name: updates.assignee ? updates.assignee.displayName : existing.assignee_display_name,
    start_date: updates.startDate !== undefined ? updates.startDate : existing.start_date,
    due_date: updates.dueDate !== undefined ? updates.dueDate : existing.due_date,
    completed_at: completedAt,
    completion_notes: updates.completionNotes !== undefined ? updates.completionNotes : existing.completion_notes,
    risk_level: updates.riskLevel !== undefined ? updates.riskLevel : existing.risk_level,
    external_sync: updates.externalSync !== undefined ? JSON.stringify(updates.externalSync) : existing.external_sync,
    updated_at: now(),
  }
  database.prepare(
    `UPDATE tasks SET
      title = ?, description = ?, status = ?, priority = ?,
      parent_id = ?, assignee_user_id = ?, assignee_display_name = ?,
      start_date = ?, due_date = ?, completed_at = ?, completion_notes = ?, risk_level = ?, external_sync = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    next.title, next.description, next.status, next.priority,
    next.parent_id, next.assignee_user_id, next.assignee_display_name,
    next.start_date, next.due_date, next.completed_at, next.completion_notes, next.risk_level, next.external_sync,
    next.updated_at, id
  )
  recordProjectActivity({
    projectId: next.project_id,
    entityType: 'task',
    entityId: id,
    action: 'updated',
    summary: `更新任务「${next.title}」`,
  })
  return rowToTask(next)
}

export function deleteTask(id: string): boolean {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  if (!existing) return false
  const tx = database.transaction(() => {
    // 级联删除子任务
    const children = database.prepare(`SELECT id FROM tasks WHERE parent_id = ?`).all(id) as Array<{ id: string }>
    for (const child of children) deleteTask(child.id)
    // 删除独立执行子任务
    database.prepare(`DELETE FROM execution_subtasks WHERE task_id = ?`).run(id)
    // 删除依赖
    database.prepare(`DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?`).run(id, id)
    // 删除风险与回执
    database.prepare(`DELETE FROM risk_assessments WHERE task_id = ?`).run(id)
    database.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
  })
  tx()
  return true
}

// ===== WBS 子任务 =====

export function createSubTask(parentId: string, input: Omit<CreateTaskInput, 'parentId'>): Task | null {
  const parent = getTask(parentId)
  if (!parent) return null
  return createTask(parent.projectId, {
    ...input,
    parentId,
    assignee: input.assignee ?? parent.assignee,
  })
}

export function listSubTasks(parentId: string): Task[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC`
  ).all(parentId) as TaskRow[]
  return rows.map(rowToTask)
}

// ===== 独立执行 subTask =====

export function createExecutionSubTask(taskId: string, input: CreateExecutionSubTaskInput): SubTask | null {
  const database = getProjectDb()
  const parent = getTask(taskId)
  if (!parent) return null
  const id = randomUUID()
  const timestamp = now()
  database.prepare(
    `INSERT INTO execution_subtasks (
      id, task_id, title, status, assignee_user_id, assignee_display_name,
      start_date, due_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, taskId, input.title, 'pending',
    (input.assignee ?? parent.assignee)?.userId ?? null,
    (input.assignee ?? parent.assignee)?.displayName ?? null,
    input.startDate ?? null, input.dueDate ?? null, timestamp, timestamp
  )
  const row = database.prepare(`SELECT * FROM execution_subtasks WHERE id = ?`).get(id) as SubTaskRow
  return rowToSubTask(row, parent.projectId, taskId)
}

export function listExecutionSubTasks(taskId: string): SubTask[] {
  const database = getProjectDb()
  const parent = getTask(taskId)
  if (!parent) return []
  const rows = database.prepare(
    `SELECT * FROM execution_subtasks WHERE task_id = ? ORDER BY created_at ASC`
  ).all(taskId) as SubTaskRow[]
  return rows.map((row) => rowToSubTask(row, parent.projectId, taskId))
}

export function updateExecutionSubTask(
  id: string,
  updates: Partial<Omit<SubTask, 'id' | 'taskId' | 'projectId' | 'entityType' | 'createdAt'>>,
): SubTask | null {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM execution_subtasks WHERE id = ?`).get(id) as SubTaskRow | undefined
  if (!existing) return null
  const parent = getTask(existing.task_id)
  if (!parent) return null
  let completedAt = existing.completed_at
  if (updates.status === 'completed') completedAt = now()
  else if (updates.status !== undefined) completedAt = null
  database.prepare(
    `UPDATE execution_subtasks SET
      title = ?, status = ?, assignee_user_id = ?, assignee_display_name = ?,
      start_date = ?, due_date = ?, completed_at = ?, completion_notes = ?, external_sync = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    updates.title ?? existing.title,
    updates.status ?? existing.status,
    updates.assignee ? updates.assignee.userId : existing.assignee_user_id,
    updates.assignee ? updates.assignee.displayName : existing.assignee_display_name,
    updates.startDate !== undefined ? updates.startDate : existing.start_date,
    updates.dueDate !== undefined ? updates.dueDate : existing.due_date,
    completedAt,
    updates.completionNotes !== undefined ? updates.completionNotes : existing.completion_notes,
    updates.externalSync !== undefined ? JSON.stringify(updates.externalSync) : existing.external_sync,
    now(), id
  )
  const row = database.prepare(`SELECT * FROM execution_subtasks WHERE id = ?`).get(id) as SubTaskRow
  return rowToSubTask(row, parent.projectId)
}

export function deleteExecutionSubTask(id: string): boolean {
  return getProjectDb().prepare(`DELETE FROM execution_subtasks WHERE id = ?`).run(id).changes > 0
}

// ===== 任务草稿模式 =====

export function createTaskDraft(projectId: string, input: CreateTaskInput): Task {
  const database = getProjectDb()
  const id = randomUUID()
  const timestamp = now()
  database.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, description, status, priority,
      assignee_user_id, assignee_display_name, start_date, due_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, input.parentId ?? null, input.title, input.description ?? '',
    input.priority ?? 'medium',
    input.assignee?.userId ?? null, input.assignee?.displayName ?? null,
    input.startDate ?? null, input.dueDate ?? null, timestamp, timestamp
  )
  return getTask(id)!
}

export function confirmTaskDraft(id: string): Task | null {
  const task = getTask(id)
  if (!task || task.status !== 'draft') return null
  return updateTask(id, { status: 'pending' })
}

export function rejectTaskDraft(id: string): boolean {
  const task = getTask(id)
  if (!task || task.status !== 'draft') return false
  return deleteTask(id)
}

// ===== 会议纪要 =====

export function updateMeetingNoteExtractedTasks(id: string, extractedTaskIds: string[]): void {
  getProjectDb().prepare(
    `UPDATE meeting_notes SET extracted_task_ids = ? WHERE id = ?`
  ).run(JSON.stringify(extractedTaskIds), id)
}

export function importMeetingNote(
  projectId: string,
  input: { title: string; rawContent: string; extractedTaskIds?: string[] }
): MeetingNote {
  const database = getProjectDb()
  const id = randomUUID()
  const timestamp = now()
  database.prepare(
    `INSERT INTO meeting_notes (id, project_id, title, raw_content, extracted_task_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, input.title, input.rawContent, JSON.stringify(input.extractedTaskIds ?? []), timestamp)
  return getMeetingNote(id)!
}

export function listMeetingNotes(projectId: string): MeetingNote[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM meeting_notes WHERE project_id = ? ORDER BY created_at ASC`
  ).all(projectId) as Array<{
    id: string; project_id: string; title: string; raw_content: string;
    extracted_task_ids: string; created_at: number;
  }>
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    rawContent: row.raw_content,
    extractedTaskIds: JSON.parse(row.extracted_task_ids) as string[],
    createdAt: row.created_at,
  }))
}

export function getMeetingNote(id: string): MeetingNote | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM meeting_notes WHERE id = ?`).get(id) as {
    id: string; project_id: string; title: string; raw_content: string;
    extracted_task_ids: string; created_at: number;
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    rawContent: row.raw_content,
    extractedTaskIds: JSON.parse(row.extracted_task_ids) as string[],
    createdAt: row.created_at,
  }
}

// ===== 看板与进度 =====

export function getKanbanBoard(projectId: string): KanbanBoard {
  const tasks = listTasks(projectId, { includeSubTasks: false, includeDrafts: true })
  return {
    draft: tasks.filter((t) => t.status === 'draft'),
    pending: tasks.filter((t) => t.status === 'pending'),
    in_progress: tasks.filter((t) => t.status === 'in_progress'),
    completed: tasks.filter((t) => t.status === 'completed'),
  }
}

export function getProjectProgress(projectId: string): ProjectProgress {
  const tasks = listTasks(projectId, { includeSubTasks: false })
  const nonDraftTasks = tasks.filter((t) => t.status !== 'draft')
  const total = nonDraftTasks.length
  const completed = nonDraftTasks.filter((t) => t.status === 'completed').length
  const percentage = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0
  return { total, completed, percentage }
}

// ===== 任务依赖与阻塞 =====

export function listTaskDependencies(projectId: string): TaskDependency[] {
  const database = getProjectDb()
  const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
  const taskIds = tasks.map((task) => task.id)
  if (taskIds.length === 0) return []
  const placeholders = taskIds.map(() => '?').join(',')
  const rows = database.prepare(
    `SELECT * FROM task_dependencies WHERE task_id IN (${placeholders}) ORDER BY created_at ASC`
  ).all(...taskIds) as Array<{ id: string; task_id: string; depends_on_task_id: string; type: string; created_at: number }>
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    type: row.type as TaskDependencyType,
    createdAt: row.created_at,
  }))
}

function dependencyWouldCycle(taskId: string, dependsOnTaskId: string, projectId: string): boolean {
  const task = getTask(taskId)
  const dependsOn = getTask(dependsOnTaskId)
  if (!task || !dependsOn || task.projectId !== dependsOn.projectId) return true
  const dependencies = listTaskDependencies(projectId)
  const outgoing = new Map<string, string[]>()
  for (const dependency of dependencies) {
    const targets = outgoing.get(dependency.taskId) ?? []
    targets.push(dependency.dependsOnTaskId)
    outgoing.set(dependency.taskId, targets)
  }
  const visited = new Set<string>()
  const stack = [dependsOnTaskId]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === taskId) return true
    if (visited.has(current)) continue
    visited.add(current)
    stack.push(...(outgoing.get(current) ?? []))
  }
  return false
}

export function createTaskDependency(
  taskId: string,
  dependsOnTaskId: string,
  type: TaskDependencyType = 'finish_to_start',
): TaskDependency {
  const database = getProjectDb()
  if (taskId === dependsOnTaskId) throw new Error('任务不能依赖自身')
  const task = getTask(taskId)
  if (!task) throw new Error('任务不存在')
  if (dependencyWouldCycle(taskId, dependsOnTaskId, task.projectId)) {
    throw new Error('该依赖会形成循环，无法保存')
  }
  const existing = database.prepare(
    `SELECT * FROM task_dependencies WHERE task_id = ? AND depends_on_task_id = ?`
  ).get(taskId, dependsOnTaskId) as { id: string; task_id: string; depends_on_task_id: string; type: string; created_at: number } | undefined
  if (existing) {
    return {
      id: existing.id, taskId: existing.task_id, dependsOnTaskId: existing.depends_on_task_id,
      type: existing.type as TaskDependencyType, createdAt: existing.created_at,
    }
  }
  const id = randomUUID()
  database.prepare(
    `INSERT INTO task_dependencies (id, task_id, depends_on_task_id, type, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, taskId, dependsOnTaskId, type, now())
  return { id, taskId, dependsOnTaskId, type, createdAt: now() }
}

export function deleteTaskDependency(id: string): boolean {
  return getProjectDb().prepare(`DELETE FROM task_dependencies WHERE id = ?`).run(id).changes > 0
}

export function listTaskBlockers(projectId: string): TaskBlocker[] {
  const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
  const dependencies = listTaskDependencies(projectId)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  return dependencies.flatMap((dependency) => {
    const prerequisite = taskById.get(dependency.dependsOnTaskId)
    if (!prerequisite || prerequisite.status === 'completed') return []
    return [{
      taskId: dependency.taskId,
      dependsOnTaskId: dependency.dependsOnTaskId,
      dependsOnTitle: prerequisite.title,
      type: dependency.type,
      reason: `等待「${prerequisite.title}」完成`,
    }]
  })
}

// ===== 我的工作 =====

export function listProjectWorkItems(projectId: string): MyWorkItem[] {
  const project = getProject(projectId)
  if (!project) return []
  const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
  const nowTimestamp = Date.now()
  const taskItems: MyWorkItem[] = tasks.map((task) => ({
    entityType: 'task',
    id: task.id,
    projectId: task.projectId,
    projectTitle: project.title,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    startDate: task.startDate,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    completionNotes: task.completionNotes,
    externalSync: task.externalSync,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    isOverdue: task.status !== 'completed' && task.dueDate !== undefined && task.dueDate < nowTimestamp,
  }))
  const executionItems = tasks.flatMap((task) =>
    listExecutionSubTasks(task.id).map((subTask): MyWorkItem => ({
      ...subTask,
      projectTitle: project.title,
      parentTaskTitle: task.title,
      isOverdue: subTask.status !== 'completed' && subTask.dueDate !== undefined && subTask.dueDate < nowTimestamp,
    }))
  )
  return [...taskItems, ...executionItems]
}

export function listMyWork(assigneeUserId: string): MyWorkItem[] {
  const projects = listProjects()
  const items = projects.flatMap((project) => listProjectWorkItems(project.id))
  return items
    .filter((item) => item.assignee?.userId === assigneeUserId)
    .sort((left, right) => (left.dueDate ?? Number.MAX_SAFE_INTEGER) - (right.dueDate ?? Number.MAX_SAFE_INTEGER))
}

// ===== 项目活动 =====

export function listProjectActivities(projectId: string): ProjectActivity[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM project_activities WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`
  ).all(projectId) as Array<{
    id: string; project_id: string; entity_type: string | null; entity_id: string | null;
    action: string | null; summary: string | null; payload: string | null; actor: string | null; created_at: number;
  }>
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type as ProjectActivity['entityType'],
    entityId: row.entity_id ?? '',
    action: row.action ?? '',
    summary: row.summary ?? '',
    payload: row.payload ? JSON.parse(row.payload) : undefined,
    actor: row.actor ?? undefined,
    createdAt: row.created_at,
  }))
}

export function recordProjectActivity(input: Omit<ProjectActivity, 'id' | 'createdAt'>): void {
  const database = getProjectDb()
  database.prepare(
    `INSERT INTO project_activities (id, project_id, entity_type, entity_id, action, summary, payload, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(), input.projectId, input.entityType ?? null, input.entityId ?? null,
    input.action, input.summary, input.payload ? JSON.stringify(input.payload) : null, input.actor ?? null, now()
  )
}

// ===== 项目模板 =====

export function listProjectTemplates(): ProjectTemplate[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM project_templates ORDER BY created_at DESC`).all() as Array<{
    id: string; name: string; description: string; template_data: string; created_at: number;
  }>
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    taskCount: ((JSON.parse(row.template_data) as { tasks?: unknown[] }).tasks ?? []).length,
    createdAt: row.created_at,
  }))
}

export function createProjectTemplateFromProject(
  projectId: string,
  name: string,
  description = '',
): ProjectTemplate {
  const project = getProject(projectId)
  if (!project) throw new Error('项目不存在')
  const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
  const keyByTaskId = new Map(tasks.map((task, index) => [task.id, `task-${index + 1}`]))
  const base = Date.now()
  const templateTasks = tasks.map((task) => ({
    key: keyByTaskId.get(task.id)!,
    parentKey: task.parentId ? keyByTaskId.get(task.parentId) : undefined,
    title: task.title,
    description: task.description,
    priority: task.priority,
    assignee: task.assignee,
    startOffsetDays: task.startDate ? Math.round((task.startDate - base) / 86_400_000) : undefined,
    dueOffsetDays: task.dueDate ? Math.round((task.dueDate - base) / 86_400_000) : undefined,
    executionSubTasks: listExecutionSubTasks(task.id).map((subTask) => ({
      title: subTask.title,
      assignee: subTask.assignee,
      startOffsetDays: subTask.startDate ? Math.round((subTask.startDate - base) / 86_400_000) : undefined,
      dueOffsetDays: subTask.dueDate ? Math.round((subTask.dueDate - base) / 86_400_000) : undefined,
    })),
  }))
  const database = getProjectDb()
  const id = randomUUID()
  database.prepare(
    `INSERT INTO project_templates (id, name, description, template_data, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, description, JSON.stringify({ tasks: templateTasks }), now())
  return {
    id, name, description, taskCount: templateTasks.length, createdAt: now(),
  }
}

export function applyProjectTemplate(templateId: string, projectName: string): Project {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM project_templates WHERE id = ?`).get(templateId) as {
    id: string; name: string; description: string; template_data: string; created_at: number;
  } | undefined
  if (!row) throw new Error('模板不存在')
  const data = JSON.parse(row.template_data) as { tasks?: Array<{
    key: string; parentKey?: string; title: string; description: string; priority: Task['priority'];
    assignee?: TaskAssignee; startOffsetDays?: number; dueOffsetDays?: number;
    executionSubTasks: Array<{ title: string; assignee?: TaskAssignee; startOffsetDays?: number; dueOffsetDays?: number }>;
  }> }
  const tasks = data.tasks ?? []
  const project = createProject({ title: projectName, description: row.description, status: 'planning' })
  const taskByKey = new Map<string, Task>()
  const base = Date.now()
  const pending = [...tasks]
  while (pending.length > 0) {
    const index = pending.findIndex((item) => !item.parentKey || taskByKey.has(item.parentKey))
    if (index < 0) throw new Error('模板 WBS 层级无效')
    const item = pending.splice(index, 1)[0]!
    const created = createTask(project.id, {
      title: item.title, description: item.description, priority: item.priority, assignee: item.assignee,
      parentId: item.parentKey ? taskByKey.get(item.parentKey)!.id : undefined,
      startDate: item.startOffsetDays === undefined ? undefined : base + item.startOffsetDays * 86_400_000,
      dueDate: item.dueOffsetDays === undefined ? undefined : base + item.dueOffsetDays * 86_400_000,
    })
    taskByKey.set(item.key, created)
    for (const subTask of item.executionSubTasks) createExecutionSubTask(created.id, {
      title: subTask.title, assignee: subTask.assignee,
      startDate: subTask.startOffsetDays === undefined ? undefined : base + subTask.startOffsetDays * 86_400_000,
      dueDate: subTask.dueOffsetDays === undefined ? undefined : base + subTask.dueOffsetDays * 86_400_000,
    })
  }
  return project
}

// ===== 用户映射 =====

export function saveUserMapping(input: SaveUserMappingInput): UserMapping {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM user_mappings WHERE paa_user_id = ?`).get(input.paaUserId) as {
    paa_user_id: string; display_name: string; feishu_user_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  } | undefined
  const mapping: UserMapping = {
    paaUserId: input.paaUserId,
    displayName: input.displayName,
    feishuUserId: input.feishuUserId ?? undefined,
    dingtalkUserId: input.dingtalkUserId ?? undefined,
    dingTalkUnionId: input.dingTalkUnionId ?? undefined,
    source: 'manual',
    updatedAt: now(),
  }
  if (existing) {
    database.prepare(
      `UPDATE user_mappings SET display_name = ?, feishu_user_id = ?, dingtalk_user_id = ?, dingtalk_union_id = ?, updated_at = ? WHERE paa_user_id = ?`
    ).run(
      mapping.displayName, mapping.feishuUserId ?? null, mapping.dingtalkUserId ?? null,
      mapping.dingTalkUnionId ?? null, mapping.updatedAt, input.paaUserId
    )
  } else {
    database.prepare(
      `INSERT INTO user_mappings (paa_user_id, display_name, feishu_user_id, dingtalk_user_id, dingtalk_union_id, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mapping.paaUserId, mapping.displayName, mapping.feishuUserId ?? null, mapping.dingtalkUserId ?? null,
      mapping.dingTalkUnionId ?? null, 'manual', mapping.updatedAt
    )
  }
  return mapping
}

export function getUserMapping(paaUserId: string): UserMapping | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM user_mappings WHERE paa_user_id = ?`).get(paaUserId) as {
    paa_user_id: string; display_name: string; feishu_user_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  } | undefined
  if (!row) return null
  return {
    paaUserId: row.paa_user_id,
    displayName: row.display_name,
    feishuUserId: row.feishu_user_id ?? undefined,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    dingTalkUnionId: row.dingtalk_union_id ?? undefined,
    source: row.source as UserMapping['source'],
    updatedAt: row.updated_at,
  }
}

export function listUserMappings(): UserMapping[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM user_mappings ORDER BY updated_at DESC`).all() as Array<{
    paa_user_id: string; display_name: string; feishu_user_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  }>
  return rows.map((row) => ({
    paaUserId: row.paa_user_id,
    displayName: row.display_name,
    feishuUserId: row.feishu_user_id ?? undefined,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    dingTalkUnionId: row.dingtalk_union_id ?? undefined,
    source: row.source as UserMapping['source'],
    updatedAt: row.updated_at,
  }))
}

export function deleteUserMapping(paaUserId: string): boolean {
  return getProjectDb().prepare(`DELETE FROM user_mappings WHERE paa_user_id = ?`).run(paaUserId).changes > 0
}

// ===== Outbox（钉钉调用失败重试） =====

export function listDingTalkTodoRetries(projectId: string): TodoRetryEvent[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM outbox_events
     WHERE project_id = ? AND event_type IN ('dingtalk.create_todo', 'dingtalk.update_todo_status', 'feishu.create_todo', 'feishu.update_todo_status')
       AND status IN ('pending', 'failed', 'processing')
     ORDER BY created_at DESC`
  ).all(projectId) as Array<{
    id: string; project_id: string | null; entity_type: string | null; entity_id: string | null;
    event_type: string | null; retry_count: number; status: string; error_message: string | null; created_at: number;
  }>
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id ?? undefined,
    entityType: row.entity_type as TodoRetryEvent['entityType'],
    entityId: row.entity_id ?? '',
    eventType: row.event_type as TodoRetryEvent['eventType'],
    retryCount: row.retry_count,
    status: row.status as TodoRetryEvent['status'],
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
  }))
}

export function getOutboxEvent(id: string): {
  id: string; projectId?: string; entityType: 'task' | 'subTask'; entityId: string;
  eventType: TodoRetryEvent['eventType']; status: string; retryCount: number; errorMessage?: string;
} | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM outbox_events WHERE id = ?`).get(id) as {
    id: string; project_id: string | null; entity_type: string | null; entity_id: string | null;
    event_type: string | null; retry_count: number; status: string; error_message: string | null; created_at: number;
  } | undefined
  if (!row) return null
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    entityType: row.entity_type as 'task' | 'subTask',
    entityId: row.entity_id ?? '',
    eventType: row.event_type as TodoRetryEvent['eventType'],
    status: row.status,
    retryCount: row.retry_count,
    errorMessage: row.error_message ?? undefined,
  }
}

export function enqueueOutboxEvent(input: {
  projectId?: string; entityType: 'task' | 'subTask'; entityId: string;
  eventType: TodoRetryEvent['eventType']; errorMessage?: string;
}): string {
  const database = getProjectDb()
  const id = randomUUID()
  database.prepare(
    `INSERT INTO outbox_events (id, project_id, entity_type, entity_id, event_type, retry_count, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?)`
  ).run(id, input.projectId ?? null, input.entityType, input.entityId, input.eventType, input.errorMessage ?? null, now())
  return id
}

export function markOutboxEvent(id: string, status: TodoRetryEvent['status'], errorMessage?: string): boolean {
  const database = getProjectDb()
  const row = database.prepare(`SELECT retry_count FROM outbox_events WHERE id = ?`).get(id) as { retry_count: number } | undefined
  if (!row) return false
  database.prepare(
    `UPDATE outbox_events SET status = ?, error_message = ?, retry_count = ? WHERE id = ?`
  ).run(status, errorMessage ?? null, status === 'failed' ? row.retry_count + 1 : row.retry_count, id)
  return true
}

// ===== 风险评估 =====

export function saveRiskAssessment(input: {
  taskId?: string; subTaskId?: string; projectId: string;
  overallLevel: string; requiresCompletionNotes: boolean; riskItems?: unknown[]; suggestion?: string;
}): string {
  const database = getProjectDb()
  const id = randomUUID()
  database.prepare(
    `INSERT INTO risk_assessments (id, task_id, sub_task_id, project_id, overall_level, requires_completion_notes, risk_items, suggestion, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, input.taskId ?? null, input.subTaskId ?? null, input.projectId,
    input.overallLevel, input.requiresCompletionNotes ? 1 : 0,
    input.riskItems ? JSON.stringify(input.riskItems) : null, input.suggestion ?? null, now()
  )
  return id
}

export function listRiskAssessments(projectId: string): Array<{
  id: string; taskId?: string; subTaskId?: string; projectId: string;
  overallLevel: string; requiresCompletionNotes: boolean; riskItems?: unknown[]; suggestion?: string; createdAt: number;
}> {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM risk_assessments WHERE project_id = ? ORDER BY created_at DESC`
  ).all(projectId) as Array<{
    id: string; task_id: string | null; sub_task_id: string | null; project_id: string;
    overall_level: string; requires_completion_notes: number; risk_items: string | null; suggestion: string | null; created_at: number;
  }>
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id ?? undefined,
    subTaskId: row.sub_task_id ?? undefined,
    projectId: row.project_id,
    overallLevel: row.overall_level,
    requiresCompletionNotes: row.requires_completion_notes === 1,
    riskItems: row.risk_items ? JSON.parse(row.risk_items) : undefined,
    suggestion: row.suggestion ?? undefined,
    createdAt: row.created_at,
  }))
}

// ===== Brief 回执 =====

export interface BriefReceiptRow {
  id: string; task_id: string; project_id: string; union_id: string; brief: string;
  status: string; content: string | null; form_url: string | null;
  created_at: number; responded_at: number | null;
}

export function createBriefReceipt(input: {
  taskId: string; projectId: string; unionId: string; brief: string; formUrl?: string;
}): BriefReceipt {
  const database = getProjectDb()
  const id = randomUUID()
  database.prepare(
    `INSERT INTO brief_receipts (id, task_id, project_id, union_id, brief, status, content, form_url, created_at, responded_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`
  ).run(id, input.taskId, input.projectId, input.unionId, input.brief, input.formUrl ?? null, now())
  return getBriefReceipt(id)!
}

export function getBriefReceipt(id: string): BriefReceipt | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM brief_receipts WHERE id = ?`).get(id) as BriefReceiptRow | undefined
  return row ? rowToBriefReceipt(row) : null
}

export function listBriefReceiptsByTask(taskId: string): BriefReceipt[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM brief_receipts WHERE task_id = ? ORDER BY created_at DESC`
  ).all(taskId) as BriefReceiptRow[]
  return rows.map(rowToBriefReceipt)
}

export function listBriefReceiptsByProject(projectId: string): BriefReceipt[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM brief_receipts WHERE project_id = ? ORDER BY created_at DESC`
  ).all(projectId) as BriefReceiptRow[]
  return rows.map(rowToBriefReceipt)
}

export function updateBriefReceipt(id: string, patch: { status?: BriefReceipt['status']; content?: string; respondedAt?: number; formUrl?: string }): BriefReceipt | null {
  const database = getProjectDb()
  const existing = getBriefReceipt(id)
  if (!existing) return null
  database.prepare(
    `UPDATE brief_receipts SET status = ?, content = ?, responded_at = ?, form_url = ? WHERE id = ?`
  ).run(
    patch.status ?? existing.status,
    patch.content !== undefined ? patch.content : existing.content ?? null,
    patch.respondedAt ?? existing.respondedAt ?? null,
    patch.formUrl !== undefined ? patch.formUrl : existing.formUrl ?? null,
    id
  )
  return getBriefReceipt(id)
}

function rowToBriefReceipt(row: BriefReceiptRow): BriefReceipt {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    unionId: row.union_id,
    brief: row.brief,
    status: row.status as BriefReceipt['status'],
    content: row.content ?? undefined,
    formUrl: row.form_url ?? undefined,
    createdAt: row.created_at,
    respondedAt: row.responded_at ?? undefined,
  }
}
