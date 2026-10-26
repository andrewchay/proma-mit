/**
 * 项目记忆归属与范围过滤（纯函数层）
 *
 * 目标架构：Project 是业务实体，AgentWorkspace 是执行环境；正式绑定（Project ↔ Workspace）
 * 只是授权，不自动共享资料。记忆条目的 scope 决定它属于个人 / 某个工作空间 / 某些项目；
 * 检索必须先按 session 的 workspaceId / projectId + 当前绑定过滤，再匹配内容。
 *
 * 可见性规则（searchScopedMemoryItems / getScopedMemoryItem 共用）：
 * - personal（含旧版无 scope 条目，原样兼容）：在普通工作空间/个人检索中可见；
 *   在"已绑定项目的会话"中默认不可见（旧无 scope 记忆不进入项目检索）。
 * - workspace：仅当条目 workspaceId 等于会话 workspaceId 时可见。
 * - project：仅当会话有 projectId、条目 projectIds 包含该 projectId、
 *   且会话 workspaceId 与 projectId 存在正式绑定时可见。
 *
 * 本模块只做纯计算与绑定解析器注册，不触碰文件系统；
 * 条目读写仍由 memory-plugin-service 的 items.json 权威存储完成。
 */

// ===== 类型定义 =====

/** 记忆归属范围类别 */
export type MemoryScopeKind = 'personal' | 'workspace' | 'project'

/** 记忆条目的归属范围（MemoryItem.scope，可选字段） */
export interface MemoryScope {
  kind: MemoryScopeKind
  /** kind = 'workspace' 时必填：所属工作空间 id */
  workspaceId?: string
  /** kind = 'project' 时必填：所属项目 id 列表（一条记忆可服务多个项目） */
  projectIds?: string[]
}

/**
 * 记忆来源元数据（MemoryItem.source，可选字段）。
 * 与既有 sourceRunId / sourceSessionId 并存，提供结构化的出处追溯。
 */
export interface MemorySource {
  /** 观察/写入时所在工作空间 id */
  workspaceId?: string
  /** 观察/写入时会话 id */
  sessionId?: string
  /** 观察/写入时 Agent run id */
  runId?: string
  /** 出处定位（如文件路径、URL、消息定位符） */
  locator?: string
  /** 观察时间戳（毫秒） */
  observedAt?: number
}

/** 会话解析后的范围上下文（由调用方从 AgentSessionMeta + 绑定解析得到） */
export interface MemoryScopeContext {
  /** 会话所属工作空间 id（无则视为个人检索上下文） */
  workspaceId?: string
  /** 会话所属项目 id（无则非项目检索） */
  projectId?: string
  /** 会话 workspaceId 与 projectId 当前是否存在正式绑定（由绑定解析器给出） */
  workspaceProjectBound: boolean
}

/**
 * Project ↔ Workspace 正式绑定解析器接口。
 * 绑定服务由并行任务提供；此处只依赖接口，运行时经动态 require 优雅获取，
 * 测试可注入桩实现。
 */
export interface ProjectWorkspaceBindingResolver {
  hasBinding(projectId: string, workspaceId: string): boolean
}

// ===== 绑定解析器注册与优雅缺失 =====

let bindingResolver: ProjectWorkspaceBindingResolver | null = null

/** 注入绑定解析器（生产装配或测试桩使用） */
export function setProjectWorkspaceBindingResolver(resolver: ProjectWorkspaceBindingResolver | null): void {
  bindingResolver = resolver
}

/** 重置为默认动态解析（隔离测试用） */
export function resetProjectWorkspaceBindingResolver(): void {
  bindingResolver = null
}

/** 通过可被打包器静态识别的延迟加载读取正式绑定；缺少权威服务时失败关闭。 */
export function resolveWorkspaceProjectBinding(projectId: string, workspaceId: string): boolean {
  if (!projectId || !workspaceId) return false
  if (bindingResolver) return bindingResolver.hasBinding(projectId, workspaceId)
  try {
    // 必须保留字面量require：createRequire加变量相对路径不会被esbuild收入单文件应用。
    const service = require('./project-workspace-bindings') as typeof import('./project-workspace-bindings')
    return service.hasProjectWorkspaceBinding(projectId, workspaceId)
  } catch {
    return false
  }
}

// ===== 范围分类与可见性（纯函数） =====

/** 条目归属类别；旧版无 scope 字段的条目归为 personal（原样兼容） */
export function classifyItemScope(item: { scope?: MemoryScope }): MemoryScopeKind {
  return item.scope?.kind ?? 'personal'
}

/**
 * 条目在给定会话上下文中是否可见（先范围过滤，再交给调用方做内容匹配）。
 *
 * 关键语义：
 * - 已绑定项目的会话 = 项目检索上下文：只出 project 条目，personal / workspace 条目
 *   （含旧无 scope 记忆）默认不可见，避免个人资料串入项目检索。
 * - 未绑定/无项目的会话 = 工作空间或个人检索上下文：personal 条目全局可见，
 *   workspace 条目仅同工作空间可见。
 */
export function isItemVisibleInScope(item: { scope?: MemoryScope }, ctx: MemoryScopeContext): boolean {
  const kind = classifyItemScope(item)
  const inProjectContext = Boolean(ctx.projectId && ctx.workspaceProjectBound && ctx.workspaceId)

  if (kind === 'project') {
    if (!inProjectContext) return false
    const projectIds = item.scope?.projectIds
    return Array.isArray(projectIds) && projectIds.includes(ctx.projectId!)
  }

  if (inProjectContext) return false

  if (kind === 'workspace') {
    return Boolean(ctx.workspaceId) && item.scope?.workspaceId === ctx.workspaceId
  }

  // personal（含旧无 scope 条目）：工作空间/个人上下文中全局可见
  return true
}

/** 按会话上下文过滤条目（纯函数，保持传入顺序） */
export function filterItemsForScope<T extends { scope?: MemoryScope }>(items: T[], ctx: MemoryScopeContext): T[] {
  return items.filter((item) => isItemVisibleInScope(item, ctx))
}
