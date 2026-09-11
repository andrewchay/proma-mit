/**
 * 项目管理 SQLite 数据层 — Project SQLite Store
 *
 * 本地 SQLite 作为项目管理唯一数据源（弃用 NocoBase）。
 * 全部数据操作在此实现，project-service.ts 保持对外接口不变。
 *
 * 技术选型：Electron 主进程用 better-sqlite3（文件直写 + WAL，无全量导出）；
 * bun test 环境用 sql.js（WASM 内存库 + 导出持久化）——better-sqlite3 的 V8 原生绑定
 * 在 Bun 下会直接崩溃，且 Electron 主进程拿不到 node:sqlite，故测试分支保留 sql.js。
 * 两个驱动实现同一 SqliteCompat 接口，业务 SQL 完全共享。
 * 存储位置：~/.gravitas/projects/paa.db
 *
 * v1.0 — 本地 SQLite 唯一数据源
 */

import { randomUUID } from 'node:crypto'
import initSqlJs, { type Database as SqlDatabase, type Statement, type SqlJsStatic } from 'sql.js'
import { writeFileAtomic } from '@gravitas/shared/utils/node'
import { getProjectsDir } from './config-paths'
import { join } from 'node:path'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { assertTaskCompletionAllowed, emptyProjectChain } from './project-chain'
import type { ProjectChain } from '@gravitas/shared'

// better-sqlite3 类型（仅类型引用；运行时在 loadNativeSqlite 中延迟 require，Bun 下不会加载）
type SqliteNativeConstructor = typeof import('better-sqlite3')
type SqliteNativeDatabase = InstanceType<SqliteNativeConstructor>
type SqliteNativeStatement = ReturnType<SqliteNativeDatabase['prepare']>
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
  AgentEmployee,
  CreateAgentEmployeeInput,
  UpdateAgentEmployeeInput,
  AgentExecution,
  CreateAgentExecutionInput,
  Member,
  MemberKind,
  MemberSource,
  CreateMemberInput,
  UpdateMemberInput,
  ListMembersFilter,
  TaskStatusDef,
  TaskStateGroup,
  CreateTaskStatusInput,
  UpdateTaskStatusInput,
  ReorderTaskInput,
  ReorderTaskResult,
} from './project-types'
import { builtinTaskStatusSeed, isCompletedStatus, isDraftStatusId, resolveStateGroup } from './task-status-logic'
import { computeReorderPlan } from './task-reorder-logic'

// ===== 数据库连接 =====

// 双驱动兼容层：向业务代码暴露统一的 prepare().get/all/run + transaction 接口。
// 生产（Electron）走 better-sqlite3 直写磁盘，测试（bun）走 sql.js 导出持久化。

type SqlParam = string | number | null

interface StmtCompat {
  get(...params: SqlParam[]): unknown
  all(...params: SqlParam[]): unknown[]
  run(...params: SqlParam[]): { changes: number }
}

interface SqliteCompat {
  prepare(sql: string): StmtCompat
  /** 执行多条 SQL（迁移用） */
  exec(sql: string): void
  /** 兼容保留：sql.js 需要显式导出落盘；better-sqlite3 写操作即时落盘，此处为空操作 */
  persist(): void
  /** 返回一个执行函数（支持嵌套：内层直接执行，由外层统一提交/回滚） */
  transaction(fn: () => void): () => void
  close(): void
}

let db: SqliteCompat | null = null
let sqlJsPromise: Promise<SqlJsStatic> | null = null

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({
      // esbuild 打包后模块路径变化，显式从 node_modules 定位 wasm 文件
      locateFile: (file: string) => require.resolve(`sql.js/dist/${file}`),
    })
  }
  return sqlJsPromise
}

/** 是否运行在 Bun（bun test）下：better-sqlite3 的 V8 绑定会让 Bun 直接崩溃，必须走 sql.js */
function isBunRuntime(): boolean {
  return typeof process !== 'undefined' && !!process.versions.bun
}

function loadNativeSqlite(): SqliteNativeConstructor {
  // esbuild --external:better-sqlite3：原生绑定不可打包，运行时从 node_modules 解析
  return require('better-sqlite3') as SqliteNativeConstructor
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
    const dir = getProjectsDir()
    const dbPath = join(dir, 'paa.db')
    if (isBunRuntime()) {
      // 测试分支：sql.js 内存库 + 手动导出持久化（行为与历史版本一致）
      const SQL = await loadSqlJs()
      const existing = existsSync(dbPath) ? readFileSync(dbPath) : undefined
      const store = new SqlJsCompat(new SQL.Database(existing as Uint8Array | undefined), dbPath)
      migrate(store)
      db = store
    } else {
      // 生产分支：better-sqlite3 打开同一 SQLite 文件（格式与驱动无关，无数据迁移）
      const database = new (loadNativeSqlite())(dbPath)
      database.pragma('journal_mode = WAL')
      database.pragma('synchronous = NORMAL')
      backupDatabaseFile(database, dbPath)
      const store = new NativeSqliteCompat(database)
      migrate(store)
      db = store
    }
    dbReady = true
  })()
  await dbInitPromise
}

/** 驱动切换/迁移前的安全网：VACUUM INTO 生成一致性快照（含 WAL 内容），失败不阻塞启动 */
function backupDatabaseFile(database: SqliteNativeDatabase, dbPath: string): void {
  try {
    const backupPath = `${dbPath}.backup`
    if (existsSync(backupPath)) rmSync(backupPath)
    database.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    console.log('[ProjectSqliteStore] 已生成数据库备份:', backupPath)
  } catch (error) {
    console.warn('[ProjectSqliteStore] 数据库备份失败（不阻塞启动）:', error instanceof Error ? error.message : error)
  }
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

// ===== sql.js 实现（bun test 分支） =====

class SqlJsCompat implements SqliteCompat {
  private database: SqlDatabase
  private filePath: string
  private inTransaction = false

  constructor(database: SqlDatabase, filePath: string) {
    this.database = database
    this.filePath = filePath
  }

  /** 持久化：将内存库导出写入磁盘 */
  persist(): void {
    if (this.inTransaction) return
    writeFileAtomic(this.filePath, this.database.export())
  }

  prepare(sql: string): StmtCompat {
    return new SqlJsStmt(this.database, sql, this)
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

  /** 事务：返回一个执行函数（支持嵌套：内层直接执行，由外层统一提交/回滚） */
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

class SqlJsStmt implements StmtCompat {
  private statement: Statement
  private owner: SqlJsCompat

  constructor(database: SqlDatabase, sql: string, owner: SqlJsCompat) {
    this.statement = database.prepare(sql)
    this.owner = owner
  }

  get(...params: SqlParam[]): unknown {
    try {
      this.statement.bind(params as never[])
      const row = this.statement.step() ? this.statement.getAsObject() : undefined
      return row
    } finally {
      this.statement.free()
    }
  }

  all(...params: SqlParam[]): unknown[] {
    try {
      this.statement.bind(params as never[])
      const rows: unknown[] = []
      while (this.statement.step()) rows.push(this.statement.getAsObject())
      return rows
    } finally {
      this.statement.free()
    }
  }

  run(...params: SqlParam[]): { changes: number } {
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

// ===== better-sqlite3 实现（Electron 生产分支） =====

class NativeSqliteCompat implements SqliteCompat {
  private database: SqliteNativeDatabase
  private inTransaction = false

  constructor(database: SqliteNativeDatabase) {
    this.database = database
  }

  /** WAL 模式下写操作直接落盘，无需导出（兼容保留空实现） */
  persist(): void {}

  prepare(sql: string): StmtCompat {
    return new NativeSqliteStmt(this.database, sql)
  }

  exec(sql: string): void {
    this.database.exec(sql)
  }

  transaction(fn: () => void): () => void {
    return () => {
      if (this.inTransaction) {
        fn()
        return
      }
      this.database.exec('BEGIN')
      this.inTransaction = true
      try {
        fn()
        this.database.exec('COMMIT')
      } catch (error) {
        try {
          this.database.exec('ROLLBACK')
        } catch {
          // 回滚失败不掩盖原始错误
        }
        throw error
      } finally {
        this.inTransaction = false
      }
    }
  }

  close(): void {
    this.database.close()
  }
}

class NativeSqliteStmt implements StmtCompat {
  private statement: SqliteNativeStatement

  constructor(database: SqliteNativeDatabase, sql: string) {
    this.statement = database.prepare(sql)
  }

  // better-sqlite3 类型为 (named..., anonymous...) 双 rest 签名，统一断言为单 rest 便于展开
  get(...params: SqlParam[]): unknown {
    return (this.statement.get.bind(this.statement) as (...params: SqlParam[]) => unknown)(...params)
  }

  all(...params: SqlParam[]): unknown[] {
    return (this.statement.all.bind(this.statement) as (...params: SqlParam[]) => unknown[])(...params)
  }

  run(...params: SqlParam[]): { changes: number } {
    const run = this.statement.run.bind(this.statement) as (...params: SqlParam[]) => { changes: number }
    return { changes: run(...params).changes }
  }
}

// ===== Schema 迁移 =====

/**
 * 读取某表现有列名（走兼容层 prepare().all()，两个驱动行为一致）。
 */
function readColumnNames(database: SqliteCompat, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  return rows.map((row) => row.name).filter((name): name is string => !!name)
}

function migrate(database: SqliteCompat): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_chain_revisions (
      project_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (project_id, revision)
    );
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
      created_by_user_id TEXT,
      workspace_id TEXT,
      start_date INTEGER,
      due_date INTEGER,
      completed_at INTEGER,
      completion_notes TEXT,
      risk_level TEXT,
      external_sync TEXT,
      permission_requests TEXT NOT NULL DEFAULT '[]',
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
      feishu_union_id TEXT,
      dingtalk_user_id TEXT,
      dingtalk_union_id TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      member_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'human',
      display_name TEXT NOT NULL DEFAULT '',
      plain_name TEXT,
      feishu_user_id TEXT,
      feishu_union_id TEXT,
      dingtalk_user_id TEXT,
      dingtalk_union_id TEXT,
      department TEXT,
      source TEXT NOT NULL DEFAULT 'sync',
      active INTEGER NOT NULL DEFAULT 1,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_members_fu_id ON members(feishu_union_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_members_du_id ON members(dingtalk_union_id);
    CREATE INDEX IF NOT EXISTS idx_members_name ON members(plain_name);

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

    CREATE TABLE IF NOT EXISTS agent_employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '通用',
      avatar TEXT,
      description TEXT NOT NULL DEFAULT '',
      runtime TEXT NOT NULL DEFAULT 'proma',
      channel_id TEXT NOT NULL,
      model_id TEXT,
      workspace_id TEXT,
      workflow_id TEXT,
      system_prompt TEXT,
      skills TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      total_tasks INTEGER NOT NULL DEFAULT 0,
      completed_tasks INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms INTEGER,
      failure_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_employees_enabled ON agent_employees(enabled);

    CREATE TABLE IF NOT EXISTS agent_executions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      executor TEXT NOT NULL DEFAULT 'headless',
      status TEXT NOT NULL DEFAULT 'queued',
      prompt TEXT NOT NULL DEFAULT '',
      result_summary TEXT,
      output_files TEXT NOT NULL DEFAULT '[]',
      risk_level TEXT,
      error TEXT,
      requested_permissions TEXT NOT NULL DEFAULT '[]',
      last_heartbeat_at INTEGER,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_agent_exec_entity ON agent_executions(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_agent_exec_status ON agent_executions(status);

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  // P1：tasks 表新增 permission_requests 列（兼容旧库）
  const columns = readColumnNames(database, 'tasks')
  if (!columns.includes('permission_requests')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN permission_requests TEXT NOT NULL DEFAULT '[]'`)
  }
  // PH2-⑤：tasks 表新增 created_by_user_id 列（兼容旧库）
  if (!columns.includes('created_by_user_id')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN created_by_user_id TEXT`)
  }
  // PH2-③：tasks 表新增 workspace_id 列（AI 员工执行目标工作区）
  if (!columns.includes('workspace_id')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN workspace_id TEXT`)
  }
  // P3：agent_employees 表新增 workflow_id 列（兼容旧库）
  const empColumns = readColumnNames(database, 'agent_employees')
  if (!empColumns.includes('workflow_id')) {
    database.exec(`ALTER TABLE agent_employees ADD COLUMN workflow_id TEXT`)
  }
  // P3：agent_executions 表新增 executor 列（兼容旧库）
  const execColumns = readColumnNames(database, 'agent_executions')
  if (!execColumns.includes('executor')) {
    database.exec(`ALTER TABLE agent_executions ADD COLUMN executor TEXT NOT NULL DEFAULT 'headless'`)
  }
  // PH1-A：user_mappings 表新增 feishu_union_id 列（兼容旧库）
  const umCols = readColumnNames(database, 'user_mappings')
  if (!umCols.includes('feishu_union_id')) {
    database.exec(`ALTER TABLE user_mappings ADD COLUMN feishu_union_id TEXT`)
  }

  // 任务排序（Phase 2）：sort_order 为 REAL，列内升序即展示顺序；
  // 回填 -created_at 保持历史"最新在前"的展示顺序不变
  if (!columns.includes('sort_order')) {
    database.exec(`ALTER TABLE tasks ADD COLUMN sort_order REAL NOT NULL DEFAULT 0`)
    database.exec(`UPDATE tasks SET sort_order = -created_at WHERE sort_order = 0`)
  }
  // listTasks/reorderTask 均按 (project_id, status) 过滤 + sort_order 排序，覆盖索引
  database.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_sort ON tasks(project_id, sort_order)`)

  // State 分组状态模型（借鉴 Plane）：每项目一组可自定义状态，预置五态沿用旧字符串 id
  database.exec(`
    CREATE TABLE IF NOT EXISTS task_statuses (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      state_group TEXT NOT NULL CHECK (state_group IN ('backlog','unstarted','started','completed','cancelled','triage')),
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      wip_limit INTEGER,
      is_builtin INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_statuses_project ON task_statuses(project_id);
  `)
  // 存量项目补种预置五态（幂等）
  const projectRows = database.prepare('SELECT id FROM projects').all() as Array<{ id: string }>
  for (const row of projectRows) {
    seedTaskStatusesForProject(database, row.id)
  }
}

/** 为项目写入预置状态种子（幂等：INSERT OR IGNORE） */
function seedTaskStatusesForProject(database: SqliteCompat, projectId: string): void {
  const timestamp = now()
  // sql.js 包装层每次 run 后即 free 语句，循环内必须逐次 prepare（与全仓惯用法一致）
  for (const item of builtinTaskStatusSeed()) {
    database.prepare(
      `INSERT OR IGNORE INTO task_statuses (project_id, id, name, state_group, position, is_builtin, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(projectId, item.id, item.name, item.stateGroup, item.position, item.isDefault ? 1 : 0, timestamp)
  }
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
  created_by_user_id: string | null; workspace_id: string | null;
  start_date: number | null; due_date: number | null; completed_at: number | null;
  completion_notes: string | null; risk_level: string | null; external_sync: string | null;
  permission_requests: string | null;
  sort_order: number;
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
    permissionRequests: parseJsonArray(row.permission_requests),
    createdByUserId: row.created_by_user_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    sortOrder: row.sort_order,
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
  seedTaskStatusesForProject(database, id)
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
    database.prepare(`DELETE FROM task_statuses WHERE project_id = ?`).run(id)
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
  const sortOrder = -timestamp
  database.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, description, status, priority,
      assignee_user_id, assignee_display_name, created_by_user_id, workspace_id, start_date, due_date, permission_requests, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, input.parentId ?? null, input.title, input.description ?? '',
    'pending', input.priority ?? 'medium',
    input.assignee?.userId ?? null, input.assignee?.displayName ?? null,
    input.createdByUserId ?? null, input.workspaceId ?? null,
    input.startDate ?? null, input.dueDate ?? null,
    JSON.stringify(input.permissionRequests ?? []), sortOrder, timestamp, timestamp
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
  const sql = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY sort_order ASC, created_at DESC`
  let rows = database.prepare(sql).all(...params) as TaskRow[]
  if (!filter?.includeSubTasks) {
    rows = rows.filter((row) => !row.parent_id)
  }
  let tasks = rows.map(rowToTask)
  if (filter?.statusGroup) {
    // 语义组过滤：状态定义在 task_statuses 表，无法进 SQL，取出后按组过滤
    const statuses = listTaskStatuses(projectId)
    const group = filter.statusGroup
    tasks = tasks.filter((task) => resolveStateGroup(task.status, statuses) === group)
  }
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
  const statuses = listTaskStatuses(existing.project_id)
  const statusChanged = updates.status !== undefined && updates.status !== existing.status
  // draft 组进出规则：草稿是流程外待确认态，只能经 confirmTaskDraft/rejectTaskDraft 链路离开，
  // 也禁止普通更新把已确认任务改回草稿（避免绕过确认闭环）
  if (statusChanged && updates.status !== undefined) {
    const fromDraft = isDraftStatusId(existing.status)
    const toDraft = isDraftStatusId(updates.status)
    if (fromDraft !== toDraft) {
      throw new Error(
        fromDraft
          ? '草稿任务请通过「确认」或「拒绝」操作流转，不能直接改状态'
          : '任务不能通过状态编辑改回草稿（草稿仅由文档提取/AI 生成产生）',
      )
    }
  }
  if (statusChanged && updates.status !== undefined && isCompletedStatus(updates.status, statuses)) {
    const chainRow = database.prepare(
      'SELECT payload FROM project_chain_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1',
    ).get(existing.project_id) as { payload: string } | undefined
    const parsed = chainRow ? (JSON.parse(chainRow.payload) as Partial<ProjectChain>) : {}
    assertTaskCompletionAllowed({
      ...emptyProjectChain(),
      ...parsed,
      projectDefinitionOfDone: parsed.projectDefinitionOfDone ?? [],
      taskDefinitionOfDone: parsed.taskDefinitionOfDone ?? {},
      dependencyHandoffs: parsed.dependencyHandoffs ?? [],
      serviceLevelDays: parsed.serviceLevelDays ?? 7,
    } as ProjectChain, id)
  }
  let completedAt = existing.completed_at
  if (statusChanged && updates.status !== undefined) {
    completedAt = isCompletedStatus(updates.status, statuses) ? now() : null
  }
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
    permission_requests: updates.permissionRequests !== undefined ? JSON.stringify(updates.permissionRequests) : existing.permission_requests,
    updated_at: now(),
  }
  database.prepare(
    `UPDATE tasks SET
      title = ?, description = ?, status = ?, priority = ?,
      parent_id = ?, assignee_user_id = ?, assignee_display_name = ?,
      start_date = ?, due_date = ?, completed_at = ?, completion_notes = ?, risk_level = ?, external_sync = ?, permission_requests = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(
    next.title, next.description, next.status, next.priority,
    next.parent_id, next.assignee_user_id, next.assignee_display_name,
    next.start_date, next.due_date, next.completed_at, next.completion_notes, next.risk_level, next.external_sync, next.permission_requests,
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
    // PH2 修复：删除该任务的 outbox 重试事件与 AI 员工执行记录（避免孤儿"任务不存在"无限重试）
    database.prepare(`DELETE FROM outbox_events WHERE entity_id = ?`).run(id)
    database.prepare(`DELETE FROM agent_executions WHERE entity_id = ?`).run(id)
    database.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
  })
  tx()
  return true
}

// ===== 任务排序（Phase 2：中点法 + 间隙不足整列重编号） =====

/**
 * 拖拽排序：一次拖拽可同时改状态（跨列）与位置（列内）。
 *
 * @param id 被移动任务 ID
 * @param input 目标位置（邻居表达）与可选的新状态
 * @returns 被移动任务；触发整列重编号时附带被一并改写的任务
 */
export function reorderTask(id: string, input: ReorderTaskInput): ReorderTaskResult {
  const database = getProjectDb()
  const existing = database.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined
  if (!existing) throw new Error(`任务不存在: ${id}`)
  const projectId = existing.project_id
  const newStatusId = input.newStatusId ?? existing.status

  // 目标列当前任务（按 sort_order 升序），排除被移动任务
  const columnRows = database.prepare(
    `SELECT * FROM tasks WHERE project_id = ? AND status = ? AND id != ? ORDER BY sort_order ASC, created_at DESC`,
  ).all(projectId, newStatusId, id) as TaskRow[]

  // 解析落点索引：两个邻居分别定位（after=上方邻居→其下一位；before=下方邻居→其位），
  // 两者都命中时必须一致（同一路由产生的相邻对）；任一命中即采用，
  // 全部未命中（跨列拖到列首时 after 天然缺失）才回退列尾。
  let targetIndex = columnRows.length
  const afterIndex = input.afterTaskId ? columnRows.findIndex((row) => row.id === input.afterTaskId) : -1
  const beforeIndex = input.beforeTaskId ? columnRows.findIndex((row) => row.id === input.beforeTaskId) : -1
  if (afterIndex >= 0) {
    targetIndex = afterIndex + 1
  } else if (beforeIndex >= 0) {
    targetIndex = beforeIndex
  }

  const currentOrders = new Map(columnRows.map((row) => [row.id, row.sort_order]))
  const plan = computeReorderPlan(
    columnRows.map((row) => row.id),
    id,
    targetIndex,
    currentOrders,
  )

  const tx = database.transaction(() => {
    // 跨列移动需走 updateTask 的完成语义（completed_at 维护、DoD/依赖校验）
    if (newStatusId !== existing.status) {
      const updated = updateTask(id, { status: newStatusId })
      if (!updated) throw new Error(`任务不存在: ${id}`)
    }
    database.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`).run(plan.movedSortOrder, now(), id)
    for (const item of plan.rewritten) {
      database.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`).run(item.sortOrder, now(), item.taskId)
    }
  })
  tx()

  const task = getTask(id)!
  // 重编号后从库重读，保证返回的是落盘后的最新行
  const rewrittenTasks = plan.rewritten
    .map((item) => getTask(item.taskId))
    .filter((item): item is Task => item !== null)
  return { task, rewrittenTasks }
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
  const sortOrder = -timestamp
  database.prepare(
    `INSERT INTO tasks (
      id, project_id, parent_id, title, description, status, priority,
      assignee_user_id, assignee_display_name, start_date, due_date, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectId, input.parentId ?? null, input.title, input.description ?? '',
    input.priority ?? 'medium',
    input.assignee?.userId ?? null, input.assignee?.displayName ?? null,
    input.startDate ?? null, input.dueDate ?? null, sortOrder, timestamp, timestamp
  )
  return getTask(id)!
}

export function confirmTaskDraft(id: string): Task | null {
  const task = getTask(id)
  if (!task || task.status !== 'draft') return null
  // 确认是 draft 离开的唯一合法通道（updateTask 已禁止普通路径 draft↔非draft），
  // 这里直接落库：draft→pending 不涉及完成组语义，无需 completed_at 维护
  const database = getProjectDb()
  database.prepare(`UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ?`).run(now(), id)
  return getTask(id)
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
  const statuses = listTaskStatuses(projectId)
  const tasks = listTasks(projectId, { includeSubTasks: false, includeDrafts: true })
  const byStatus = new Map<string, Task[]>()
  for (const task of tasks) {
    const list = byStatus.get(task.status) ?? []
    list.push(task)
    byStatus.set(task.status, list)
  }
  return {
    columns: statuses.map((status) => ({ status, tasks: byStatus.get(status.id) ?? [] })),
  }
}

export function getProjectProgress(projectId: string): ProjectProgress {
  const statuses = listTaskStatuses(projectId)
  const tasks = listTasks(projectId, { includeSubTasks: false })
  const nonDraftTasks = tasks.filter((t) => !isDraftStatusId(t.status))
  const total = nonDraftTasks.length
  const completed = nonDraftTasks.filter((t) => isCompletedStatus(t.status, statuses)).length
  const percentage = total > 0 ? Math.round((completed / total) * 10000) / 100 : 0
  return { total, completed, percentage }
}

// ===== 任务状态定义（State 分组） =====

type TaskStatusRow = {
  project_id: string; id: string; name: string; state_group: string;
  position: number; color: string | null; wip_limit: number | null;
  is_builtin: number; is_default: number; created_at: number;
}

function rowToTaskStatus(row: TaskStatusRow): TaskStatusDef {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    stateGroup: row.state_group as TaskStateGroup,
    position: row.position,
    color: row.color ?? undefined,
    wipLimit: row.wip_limit ?? undefined,
    isBuiltin: row.is_builtin === 1,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
  }
}

export function getTaskStatus(projectId: string, statusId: string): TaskStatusDef | null {
  const row = getProjectDb().prepare(
    `SELECT * FROM task_statuses WHERE project_id = ? AND id = ?`
  ).get(projectId, statusId) as TaskStatusRow | undefined
  return row ? rowToTaskStatus(row) : null
}

/** 列出项目状态定义（按 position 排序，即看板列序） */
export function listTaskStatuses(projectId: string): TaskStatusDef[] {
  const rows = getProjectDb().prepare(
    `SELECT * FROM task_statuses WHERE project_id = ? ORDER BY position ASC, created_at ASC`
  ).all(projectId) as TaskStatusRow[]
  return rows.map(rowToTaskStatus)
}

export function createTaskStatus(projectId: string, input: CreateTaskStatusInput): TaskStatusDef {
  const database = getProjectDb()
  const statuses = listTaskStatuses(projectId)
  const insertIndex = input.afterStatusId
    ? statuses.findIndex((status) => status.id === input.afterStatusId) + 1
    : statuses.length
  if (input.afterStatusId && insertIndex === 0) throw new Error('参照状态不存在')
  const id = `sts_${randomUUID()}`
  const timestamp = now()
  const orderedIds = [
    ...statuses.slice(0, insertIndex).map((status) => status.id),
    id,
    ...statuses.slice(insertIndex).map((status) => status.id),
  ]
  const tx = database.transaction(() => {
    database.prepare(
      `INSERT INTO task_statuses (project_id, id, name, state_group, position, color, wip_limit, is_builtin, is_default, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`
    ).run(projectId, id, input.name, input.stateGroup, insertIndex, input.color ?? null, input.wipLimit ?? null, timestamp)
    renumberTaskStatusesByIds(database, projectId, orderedIds)
  })
  tx()
  const created = getTaskStatus(projectId, id)
  if (!created) throw new Error('状态创建失败')
  return created
}

export function updateTaskStatus(projectId: string, statusId: string, patch: UpdateTaskStatusInput): TaskStatusDef | null {
  const database = getProjectDb()
  const existing = getTaskStatus(projectId, statusId)
  if (!existing) return null
  database.prepare(
    `UPDATE task_statuses SET name = ?, state_group = ?, color = ?, wip_limit = ? WHERE project_id = ? AND id = ?`
  ).run(
    patch.name ?? existing.name,
    patch.stateGroup ?? existing.stateGroup,
    patch.color !== undefined ? patch.color : existing.color ?? null,
    patch.wipLimit !== undefined ? patch.wipLimit : existing.wipLimit ?? null,
    projectId, statusId,
  )
  return getTaskStatus(projectId, statusId)
}

/** 删除自定义状态；该状态下任务迁移到指定状态。预置状态不可删。 */
export function deleteTaskStatus(projectId: string, statusId: string, migrateToStatusId: string): boolean {
  const database = getProjectDb()
  const existing = getTaskStatus(projectId, statusId)
  if (!existing) return false
  if (existing.isBuiltin) throw new Error('预置状态不可删除，可改名或调整顺序')
  const target = getTaskStatus(projectId, migrateToStatusId)
  if (!target) throw new Error('目标状态不存在，无法迁移任务')
  if (target.id === statusId) throw new Error('不能迁移到被删除的状态本身')
  const tx = database.transaction(() => {
    database.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE project_id = ? AND status = ?`)
      .run(migrateToStatusId, now(), projectId, statusId)
    database.prepare(`DELETE FROM task_statuses WHERE project_id = ? AND id = ?`).run(projectId, statusId)
  })
  tx()
  return true
}

/** 按给定 id 序列重排状态（必须覆盖项目全部状态）；返回重排后的定义 */
export function reorderTaskStatuses(projectId: string, orderedIds: string[]): TaskStatusDef[] {
  const database = getProjectDb()
  const statuses = listTaskStatuses(projectId)
  const known = new Set(statuses.map((status) => status.id))
  const provided = new Set(orderedIds)
  const unknown = orderedIds.filter((id) => !known.has(id))
  if (unknown.length > 0) throw new Error(`未知状态: ${unknown.join(', ')}`)
  const missing = statuses.filter((status) => !provided.has(status.id)).map((status) => status.id)
  const finalOrder = [...orderedIds, ...missing]
  const tx = database.transaction(() => renumberTaskStatusesByIds(database, projectId, finalOrder))
  tx()
  return listTaskStatuses(projectId)
}

function renumberTaskStatusesByIds(database: SqliteCompat, projectId: string, orderedIds: string[]): void {
  // sql.js 包装层每次 run 后即 free 语句，循环内必须逐次 prepare
  orderedIds.forEach((statusId, index) => {
    database.prepare(`UPDATE task_statuses SET position = ? WHERE project_id = ? AND id = ?`).run(index, projectId, statusId)
  })
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
  const chainRow = getProjectDb()
    .prepare('SELECT payload FROM project_chain_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1')
    .get(projectId) as { payload: string } | undefined
  const handoffs = chainRow
    ? ((JSON.parse(chainRow.payload) as Partial<ProjectChain>).dependencyHandoffs ?? [])
    : []
  const tasks = listTasks(projectId, { includeSubTasks: true, includeDrafts: true })
  const dependencies = listTaskDependencies(projectId)
  const statuses = listTaskStatuses(projectId)
  const taskById = new Map(tasks.map((task) => [task.id, task]))
  return dependencies.flatMap((dependency) => {
    const prerequisite = taskById.get(dependency.dependsOnTaskId)
    const handoff = handoffs.find((item) => item.dependencyId === dependency.id)
    if (handoff?.status === 'accepted') return []
    if (handoff) {
      const reason = handoff.status === 'offered'
        ? `等待下游接收「${handoff.need}」`
        : handoff.status === 'returned'
          ? `依赖交接被退回：「${handoff.receiptComment ?? handoff.need}」`
          : `依赖交接尚未发起：「${handoff.need}」`
      return [{
        taskId: dependency.taskId,
        dependsOnTaskId: dependency.dependsOnTaskId,
        dependsOnTitle: prerequisite?.title ?? handoff.upstreamTaskId,
        type: dependency.type,
        reason,
      }]
    }
    if (!prerequisite || isCompletedStatus(prerequisite.status, statuses)) return []
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
  const statuses = listTaskStatuses(projectId)
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
    isOverdue: !isCompletedStatus(task.status, statuses) && task.dueDate !== undefined && task.dueDate < nowTimestamp,
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

/** PH2-⑤：“我指派的”视图——找出由该用户发起/创建的任务（含项目名）。 */
export function listTasksCreatedBy(creatorUserId: string): MyWorkItem[] {
  const database = getProjectDb()
  const projects = listProjects()
  const result: MyWorkItem[] = []
  for (const project of projects) {
    const statuses = listTaskStatuses(project.id)
    const rows = database.prepare(`SELECT * FROM tasks WHERE created_by_user_id = ? ORDER BY created_at DESC`).all(creatorUserId) as TaskRow[]
    for (const row of rows) {
      const task = rowToTask(row)
      result.push({
        entityType: 'task',
        id: task.id,
        projectId: task.projectId,
        projectTitle: project.title,
        title: task.title,
        status: task.status,
        assignee: task.assignee,
        startDate: task.startDate,
        dueDate: task.dueDate,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        isOverdue: !isCompletedStatus(task.status, statuses) && !!task.dueDate && task.dueDate < Date.now(),
      })
    }
  }
  return result.sort((a, b) => (a.dueDate ?? Number.MAX_SAFE_INTEGER) - (b.dueDate ?? Number.MAX_SAFE_INTEGER))
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
    paa_user_id: string; display_name: string; feishu_user_id: string | null; feishu_union_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  } | undefined
  const mapping: UserMapping = {
    paaUserId: input.paaUserId,
    displayName: input.displayName,
    // 仅覆盖入参提供的字段；未提供的保留既有值（避免把另一平台、同名的旧映射清空）
    feishuUserId: input.feishuUserId ?? existing?.feishu_user_id ?? undefined,
    feishuUnionId: input.feishuUnionId ?? existing?.feishu_union_id ?? undefined,
    dingtalkUserId: input.dingtalkUserId ?? existing?.dingtalk_user_id ?? undefined,
    dingTalkUnionId: input.dingTalkUnionId ?? existing?.dingtalk_union_id ?? undefined,
    source: 'manual',
    updatedAt: now(),
  }
  if (existing) {
    database.prepare(
      `UPDATE user_mappings SET display_name = ?, feishu_user_id = ?, feishu_union_id = ?, dingtalk_user_id = ?, dingtalk_union_id = ?, updated_at = ? WHERE paa_user_id = ?`
    ).run(
      mapping.displayName, mapping.feishuUserId ?? null, mapping.feishuUnionId ?? null,
      mapping.dingtalkUserId ?? null, mapping.dingTalkUnionId ?? null, mapping.updatedAt, input.paaUserId
    )
  } else {
    database.prepare(
      `INSERT INTO user_mappings (paa_user_id, display_name, feishu_user_id, feishu_union_id, dingtalk_user_id, dingtalk_union_id, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      mapping.paaUserId, mapping.displayName, mapping.feishuUserId ?? null, mapping.feishuUnionId ?? null,
      mapping.dingtalkUserId ?? null, mapping.dingTalkUnionId ?? null, 'manual', mapping.updatedAt
    )
  }
  return mapping
}

export function getUserMapping(paaUserId: string): UserMapping | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM user_mappings WHERE paa_user_id = ?`).get(paaUserId) as {
    paa_user_id: string; display_name: string; feishu_user_id: string | null; feishu_union_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  } | undefined
  if (!row) return null
  return {
    paaUserId: row.paa_user_id,
    displayName: row.display_name,
    feishuUserId: row.feishu_user_id ?? undefined,
    feishuUnionId: row.feishu_union_id ?? undefined,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    dingTalkUnionId: row.dingtalk_union_id ?? undefined,
    source: row.source as UserMapping['source'],
    updatedAt: row.updated_at,
  }
}

export function listUserMappings(): UserMapping[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM user_mappings ORDER BY updated_at DESC`).all() as Array<{
    paa_user_id: string; display_name: string; feishu_user_id: string | null; feishu_union_id: string | null;
    dingtalk_user_id: string | null; dingtalk_union_id: string | null; source: string; updated_at: number;
  }>
  return rows.map((row) => ({
    paaUserId: row.paa_user_id,
    displayName: row.display_name,
    feishuUserId: row.feishu_user_id ?? undefined,
    feishuUnionId: row.feishu_union_id ?? undefined,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    dingTalkUnionId: row.dingtalk_union_id ?? undefined,
    source: row.source as UserMapping['source'],
    updatedAt: row.updated_at,
  }))
}

export function deleteUserMapping(paaUserId: string): boolean {
  return getProjectDb().prepare(`DELETE FROM user_mappings WHERE paa_user_id = ?`).run(paaUserId).changes > 0
}

// ===== Members（成员档案） =====

function mapMemberRow(row: {
  member_id: string; kind: string; display_name: string; plain_name: string | null;
  feishu_user_id: string | null; feishu_union_id: string | null;
  dingtalk_user_id: string | null; dingtalk_union_id: string | null;
  department: string | null; source: string; active: number; last_synced_at: number | null; created_at: number;
}): Member {
  return {
    memberId: row.member_id,
    kind: row.kind as MemberKind,
    displayName: row.display_name,
    plainName: row.plain_name ?? undefined,
    feishuUserId: row.feishu_user_id ?? undefined,
    feishuUnionId: row.feishu_union_id ?? undefined,
    dingtalkUserId: row.dingtalk_user_id ?? undefined,
    dingtalkUnionId: row.dingtalk_union_id ?? undefined,
    department: row.department ?? undefined,
    source: row.source as MemberSource,
    active: row.active === 1,
    lastSyncedAt: row.last_synced_at ?? undefined,
    createdAt: row.created_at,
  }
}

/** 新建成员；memberId 省略自动生成，plain_name 自动小写。 */
export function createMember(input: CreateMemberInput): Member {
  const database = getProjectDb()
  const memberId = input.memberId ?? randomUUID()
  const nowTs = now()
  database.prepare(
    `INSERT INTO members
      (member_id, kind, display_name, plain_name, feishu_user_id, feishu_union_id, dingtalk_user_id, dingtalk_union_id, department, source, active, last_synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    memberId, input.kind ?? 'human', input.displayName,
    normalizePlainName(input.displayName),
    input.feishuUserId ?? null, input.feishuUnionId ?? null,
    input.dingtalkUserId ?? null, input.dingtalkUnionId ?? null,
    input.department ?? null, input.source ?? 'sync', nowTs, nowTs
  )
  return getMember(memberId)!
}

function normalizePlainName(name: string): string {
  return name.trim().toLowerCase()
}

/** 按主键读成员；不存在返回 null。 */
export function getMember(memberId: string): Member | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM members WHERE member_id = ?`).get(memberId)
  if (!row) return null
  return mapMemberRow(row as Parameters<typeof mapMemberRow>[0])
}

/** 按唯一平台字段查询（union_id 优先级最高）。 */
export function findMember(query: {
  feishuUnionId?: string
  dingtalkUnionId?: string
  feishuUserId?: string
  dingtalkUserId?: string
  displayName?: string
}): Member | null {
  const database = getProjectDb()
  if (query.feishuUnionId) {
    const r = database.prepare(`SELECT * FROM members WHERE feishu_union_id = ?`).get(query.feishuUnionId)
    if (r) return mapMemberRow(r as Parameters<typeof mapMemberRow>[0])
  }
  if (query.dingtalkUnionId) {
    const r = database.prepare(`SELECT * FROM members WHERE dingtalk_union_id = ?`).get(query.dingtalkUnionId)
    if (r) return mapMemberRow(r as Parameters<typeof mapMemberRow>[0])
  }
  if (query.feishuUserId) {
    const r = database.prepare(`SELECT * FROM members WHERE feishu_user_id = ?`).get(query.feishuUserId)
    if (r) return mapMemberRow(r as Parameters<typeof mapMemberRow>[0])
  }
  if (query.dingtalkUserId) {
    const r = database.prepare(`SELECT * FROM members WHERE dingtalk_user_id = ?`).get(query.dingtalkUserId)
    if (r) return mapMemberRow(r as Parameters<typeof mapMemberRow>[0])
  }
  if (query.displayName) {
    const r = database.prepare(`SELECT * FROM members WHERE plain_name = ? LIMIT 1`).get(normalizePlainName(query.displayName))
    if (r) return mapMemberRow(r as Parameters<typeof mapMemberRow>[0])
  }
  return null
}

/** 按显示名查所有同名成员（返回全部、按创建时间稳定排序，供成员同步消歧用）。 */
export function findMembersByName(displayName: string): Member[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM members WHERE plain_name = ? ORDER BY created_at ASC`).all(normalizePlainName(displayName)) as Array<Parameters<typeof mapMemberRow>[0]>
  return rows.map(mapMemberRow)
}

/** 更新成员（未提供的字段保留原值；如需清空请显式处理）。 */
export function updateMember(memberId: string, patch: UpdateMemberInput): Member | null {
  const database = getProjectDb()
  const existing = getMember(memberId)
  if (!existing) return null
  const next: Member = {
    ...existing,
    displayName: patch.displayName ?? existing.displayName,
    feishuUserId: patch.feishuUserId ?? existing.feishuUserId,
    feishuUnionId: patch.feishuUnionId ?? existing.feishuUnionId,
    dingtalkUserId: patch.dingtalkUserId ?? existing.dingtalkUserId,
    dingtalkUnionId: patch.dingtalkUnionId ?? existing.dingtalkUnionId,
    department: patch.department ?? existing.department,
    kind: patch.kind ?? existing.kind,
    source: patch.source ?? existing.source,
    active: patch.active ?? existing.active,
  }
  if (patch.displayName) next.plainName = normalizePlainName(patch.displayName)
  database.prepare(
    `UPDATE members SET
       kind = ?, display_name = ?, plain_name = ?,
       feishu_user_id = ?, feishu_union_id = ?, dingtalk_user_id = ?, dingtalk_union_id = ?,
       department = ?, source = ?, active = ?
     WHERE member_id = ?`
  ).run(
    next.kind, next.displayName, next.plainName ?? null,
    next.feishuUserId ?? null, next.feishuUnionId ?? null,
    next.dingtalkUserId ?? null, next.dingtalkUnionId ?? null,
    next.department ?? null, next.source, next.active ? 1 : 0, memberId
  )
  return getMember(memberId)
}

/** 更新同步时间戳（用于增量同步）。 */
export function touchMemberSync(memberId: string): void {
  getProjectDb().prepare(`UPDATE members SET last_synced_at = ? WHERE member_id = ?`).run(now(), memberId)
}

/** 列出成员（支持 kind / activeOnly / 关键字过滤）。 */
export function listMembers(filter: ListMembersFilter = {}): Member[] {
  const database = getProjectDb()
  const conds: string[] = []
  const params: Array<string | number | null> = []
  if (filter.kind) {
    conds.push(`kind = ?`)
    params.push(filter.kind)
  }
  if (filter.activeOnly) {
    conds.push(`active = 1`)
  }
  if (filter.q) {
    conds.push(`plain_name LIKE ?`)
    params.push(`%${normalizePlainName(filter.q)}%`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = database.prepare(`SELECT * FROM members ${where} ORDER BY display_name ASC`).all(...params) as Array<Parameters<typeof mapMemberRow>[0]>
  return rows.map(mapMemberRow)
}

/** 删除成员（物理删除）。 */
export function deleteMember(memberId: string): boolean {
  return getProjectDb().prepare(`DELETE FROM members WHERE member_id = ?`).run(memberId).changes > 0
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

// ===== AI 员工（Agent Employee） =====

type AgentEmployeeRow = {
  id: string; name: string; role: string; avatar: string | null; description: string;
  runtime: string; channel_id: string; model_id: string | null; workspace_id: string | null;
  workflow_id: string | null; system_prompt: string | null; skills: string | null; enabled: number; total_tasks: number;
  completed_tasks: number; avg_duration_ms: number | null; failure_count: number;
  created_at: number; updated_at: number;
}

type AgentExecutionRow = {
  id: string; project_id: string; entity_type: string; entity_id: string; agent_id: string;
  session_id: string; executor: string | null; status: string; prompt: string; result_summary: string | null;
  output_files: string | null; risk_level: string | null; error: string | null;
  requested_permissions: string | null; last_heartbeat_at: number | null;
  started_at: number; completed_at: number | null;
}

function rowToAgentEmployee(row: AgentEmployeeRow): AgentEmployee {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    avatar: row.avatar ?? undefined,
    description: row.description,
    runtime: row.runtime as AgentEmployee['runtime'],
    channelId: row.channel_id,
    modelId: row.model_id ?? undefined,
    workspaceId: row.workspace_id ?? undefined,
    workflowId: row.workflow_id ?? undefined,
    systemPrompt: row.system_prompt ?? undefined,
    skills: parseJsonArray(row.skills),
    enabled: row.enabled === 1,
    totalTasks: row.total_tasks,
    completedTasks: row.completed_tasks,
    avgDurationMs: row.avg_duration_ms ?? undefined,
    failureCount: row.failure_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToAgentExecution(row: AgentExecutionRow): AgentExecution {
  return {
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type as AgentExecution['entityType'],
    entityId: row.entity_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    executor: (row.executor as AgentExecution['executor']) ?? 'headless',
    status: row.status as AgentExecution['status'],
    prompt: row.prompt,
    resultSummary: row.result_summary ?? undefined,
    outputFiles: parseJsonArray(row.output_files),
    riskLevel: (row.risk_level as AgentExecution['riskLevel']) ?? undefined,
    error: row.error ?? undefined,
    requestedPermissions: parseJsonArray(row.requested_permissions),
    lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  }
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function listAgentEmployees(): AgentEmployee[] {
  const database = getProjectDb()
  const rows = database.prepare(`SELECT * FROM agent_employees ORDER BY created_at DESC`).all() as AgentEmployeeRow[]
  return rows.map(rowToAgentEmployee)
}

export function getAgentEmployee(id: string): AgentEmployee | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM agent_employees WHERE id = ?`).get(id) as AgentEmployeeRow | undefined
  return row ? rowToAgentEmployee(row) : null
}

export function createAgentEmployee(input: CreateAgentEmployeeInput): AgentEmployee {
  const database = getProjectDb()
  const id = randomUUID()
  const now = Date.now()
  database.prepare(
    `INSERT INTO agent_employees
     (id, name, role, avatar, description, runtime, channel_id, model_id, workspace_id, workflow_id, system_prompt, skills, enabled, total_tasks, completed_tasks, avg_duration_ms, failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, NULL, 0, ?, ?)`
  ).run(
    id,
    input.name,
    input.role ?? '通用',
    input.avatar ?? null,
    input.description ?? '',
    input.runtime ?? 'proma',
    input.channelId,
    input.modelId ?? null,
    input.workspaceId ?? null,
    input.workflowId ?? null,
    input.systemPrompt ?? null,
    JSON.stringify(input.skills ?? []),
    now,
    now,
  )
  return getAgentEmployee(id)!
}

export function updateAgentEmployee(id: string, patch: UpdateAgentEmployeeInput): AgentEmployee | null {
  const database = getProjectDb()
  const existing = getAgentEmployee(id)
  if (!existing) return null
  const merged: AgentEmployee = { ...existing, ...patch, id, createdAt: existing.createdAt, updatedAt: Date.now() }
  database.prepare(
    `UPDATE agent_employees SET
       name = ?, role = ?, avatar = ?, description = ?, runtime = ?, channel_id = ?, model_id = ?,
       workspace_id = ?, workflow_id = ?, system_prompt = ?, skills = ?, enabled = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    merged.name,
    merged.role,
    merged.avatar ?? null,
    merged.description,
    merged.runtime,
    merged.channelId,
    merged.modelId ?? null,
    merged.workspaceId ?? null,
    merged.workflowId ?? null,
    merged.systemPrompt ?? null,
    JSON.stringify(merged.skills ?? []),
    merged.enabled ? 1 : 0,
    merged.updatedAt,
    id,
  )
  return getAgentEmployee(id)
}

export function deleteAgentEmployee(id: string): boolean {
  return getProjectDb().prepare(`DELETE FROM agent_employees WHERE id = ?`).run(id).changes > 0
}

/** 执行完成后更新员工统计（不覆盖手动编辑字段）。 */
export function bumpAgentEmployeeStats(id: string, input: { completed?: boolean; failed?: boolean; durationMs?: number }): void {
  const existing = getAgentEmployee(id)
  if (!existing) return
  const completedTasks = existing.completedTasks + (input.completed ? 1 : 0)
  const failureCount = existing.failureCount + (input.failed ? 1 : 0)
  let avgDurationMs = existing.avgDurationMs
  if (input.durationMs !== undefined && input.durationMs > 0) {
    const base = existing.totalTasks
    avgDurationMs = base > 0
      ? Math.round(((existing.avgDurationMs ?? 0) * base + input.durationMs) / (base + 1))
      : input.durationMs
  }
  getProjectDb().prepare(
    `UPDATE agent_employees SET total_tasks = ?, completed_tasks = ?, avg_duration_ms = ?, failure_count = ?, updated_at = ? WHERE id = ?`
  ).run(existing.totalTasks + 1, completedTasks, avgDurationMs ?? null, failureCount, Date.now(), id)
}

// ===== AI 员工执行记录 =====

export function createAgentExecution(input: CreateAgentExecutionInput): AgentExecution {
  const database = getProjectDb()
  const now = input.startedAt ?? Date.now()
  database.prepare(
    `INSERT INTO agent_executions
     (id, project_id, entity_type, entity_id, agent_id, session_id, executor, status, prompt, result_summary, output_files, risk_level, error, requested_permissions, last_heartbeat_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, ?, NULL, ?, NULL)`
  ).run(
    input.id,
    input.projectId,
    input.entityType,
    input.entityId,
    input.agentId,
    input.sessionId,
    input.executor ?? 'headless',
    input.status ?? 'queued',
    input.prompt,
    JSON.stringify(input.requestedPermissions ?? []),
    now,
  )
  return getAgentExecution(input.id)!
}

export function getAgentExecution(id: string): AgentExecution | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM agent_executions WHERE id = ?`).get(id) as AgentExecutionRow | undefined
  return row ? rowToAgentExecution(row) : null
}

/** 按 sessionId 反查 AI 员工执行（workflow 执行 sessionId 形如 `workflow:<runId>`）。 */
export function getAgentExecutionBySessionId(sessionId: string): AgentExecution | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT * FROM agent_executions WHERE session_id = ? LIMIT 1`).get(sessionId) as AgentExecutionRow | undefined
  return row ? rowToAgentExecution(row) : null
}

export function updateAgentExecution(id: string, patch: Partial<Omit<AgentExecution, 'id' | 'projectId' | 'entityType' | 'entityId' | 'agentId' | 'startedAt'>>): AgentExecution | null {
  const database = getProjectDb()
  const existing = getAgentExecution(id)
  if (!existing) return null
  const merged: AgentExecution = { ...existing, ...patch, id: existing.id }
  database.prepare(
    `UPDATE agent_executions SET
       session_id = ?, status = ?, result_summary = ?, output_files = ?, risk_level = ?, error = ?,
       requested_permissions = ?, last_heartbeat_at = ?, completed_at = ?
     WHERE id = ?`
  ).run(
    merged.sessionId,
    merged.status,
    merged.resultSummary ?? null,
    JSON.stringify(merged.outputFiles ?? []),
    merged.riskLevel ?? null,
    merged.error ?? null,
    JSON.stringify(merged.requestedPermissions ?? []),
    merged.lastHeartbeatAt ?? null,
    merged.completedAt ?? null,
    id,
  )
  return getAgentExecution(id)
}

export function listAgentExecutionsByEntity(entityType: 'task' | 'subTask', entityId: string): AgentExecution[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM agent_executions WHERE entity_type = ? AND entity_id = ? ORDER BY started_at DESC`
  ).all(entityType, entityId) as AgentExecutionRow[]
  return rows.map(rowToAgentExecution)
}

export function listRunningAgentExecutions(): AgentExecution[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM agent_executions WHERE status IN ('queued', 'running') ORDER BY started_at ASC`
  ).all() as AgentExecutionRow[]
  return rows.map(rowToAgentExecution)
}

export function listAgentExecutionsByAgent(agentId: string, limit = 50): AgentExecution[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM agent_executions WHERE agent_id = ? ORDER BY started_at DESC LIMIT ?`
  ).all(agentId, limit) as AgentExecutionRow[]
  return rows.map(rowToAgentExecution)
}

export function listAgentExecutionsByProject(projectId: string): AgentExecution[] {
  const database = getProjectDb()
  const rows = database.prepare(
    `SELECT * FROM agent_executions WHERE project_id = ? ORDER BY started_at DESC`
  ).all(projectId) as AgentExecutionRow[]
  return rows.map(rowToAgentExecution)
}

// ===== sync_meta（跨平台同步元信息，持久化到 DB 防重启丢失） =====

/** 读取一条同步元信息（不存在返回 null）。 */
export function getSyncMeta(key: string): string | null {
  const database = getProjectDb()
  const row = database.prepare(`SELECT value FROM sync_meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

/** 写入一条同步元信息（存在则覆盖）。 */
export function setSyncMeta(key: string, value: string): void {
  const database = getProjectDb()
  database.prepare(
    `INSERT INTO sync_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now())
}
