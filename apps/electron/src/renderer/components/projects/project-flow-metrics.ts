export interface FlowMetricTask {
  id: string
  status: string
  createdAt: number
  startDate?: number
  completedAt?: number
}

/** 状态语义组（与 task_statuses 定义对齐；缺省时按预置五态推断） */
export type FlowStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled' | 'triage'

export interface FlowStatusDef {
  id: string
  stateGroup: FlowStateGroup
}

export interface ProjectFlowMetrics {
  workInProgress: number
  waiting: number
  throughput30Days: number
  averageCycleTimeDays?: number
  oldestWorkItemAgeDays?: number
  serviceLevelBreaches: number
}

const DAY = 86_400_000
const days = (duration: number): number => Math.round((duration / DAY) * 10) / 10

/** 预置五态的组归属（未传状态定义时的兜底，与主进程 task-status-logic 一致；cancelled 为遗留字符串状态 id） */
const BUILTIN_GROUPS: Record<string, FlowStateGroup> = {
  draft: 'backlog',
  pending: 'unstarted',
  in_progress: 'started',
  paused: 'started',
  completed: 'completed',
  cancelled: 'cancelled',
}

function groupOf(status: string, statuses?: FlowStatusDef[]): FlowStateGroup {
  const hit = statuses?.find((item) => item.id === status)
  if (hit) return hit.stateGroup
  return BUILTIN_GROUPS[status] ?? 'unstarted'
}

/**
 * 基于项目权威任务时间戳计算，不从链路文案推断开始或完成时间。
 * 状态判断按语义组进行（WIP=started 组、完成=completed 组），
 * paused 计入 WIP（进行中被暂停仍是流动中的工作项）。
 */
export function calculateProjectFlowMetrics(
  tasks: FlowMetricTask[],
  blockedTaskIds: ReadonlySet<string>,
  serviceLevelDays: number,
  now = Date.now(),
  statuses?: FlowStatusDef[],
): ProjectFlowMetrics {
  const active = tasks.filter((task) => groupOf(task.status, statuses) !== 'completed' && groupOf(task.status, statuses) !== 'backlog')
  const completed = tasks.filter((task) => groupOf(task.status, statuses) === 'completed' && task.completedAt)
  const cycleTimes = completed.map((task) => task.completedAt! - (task.startDate ?? task.createdAt))
  const activeAges = active.map((task) => now - (task.startDate ?? task.createdAt))
  return {
    workInProgress: tasks.filter((task) => groupOf(task.status, statuses) === 'started').length,
    waiting: active.filter((task) => groupOf(task.status, statuses) === 'unstarted' || blockedTaskIds.has(task.id)).length,
    throughput30Days: completed.filter((task) => task.completedAt! >= now - 30 * DAY).length,
    ...(cycleTimes.length
      ? { averageCycleTimeDays: days(cycleTimes.reduce((sum, value) => sum + value, 0) / cycleTimes.length) }
      : {}),
    ...(activeAges.length ? { oldestWorkItemAgeDays: days(Math.max(...activeAges)) } : {}),
    serviceLevelBreaches: activeAges.filter((age) => age > serviceLevelDays * DAY).length,
  }
}

// ===== 甘特图语义组着色（GanttView 共用） =====

/** 语义组 → 时间条底色（与看板列色系同口径） */
export const GANTT_GROUP_BAR_COLORS: Record<FlowStateGroup, string> = {
  completed: 'bg-emerald-500',
  started: 'bg-blue-500',
  unstarted: 'bg-primary',
  backlog: 'bg-stone-400',
  cancelled: 'bg-zinc-400',
  triage: 'bg-amber-400',
}

/**
 * 甘特时间条颜色：语义组底色优先；
 * 异常覆盖（完成组不覆盖）：超期 → 红；阻塞 → 琥珀；高风险 → 橙；关键风险 → 红。
 */
export function ganttBarColor(
  task: { status: string; dueDate?: number; riskLevel?: 'low' | 'medium' | 'high' | 'critical' },
  options: { blocked: boolean; now: number; statuses?: FlowStatusDef[] },
): string {
  const group = groupOf(task.status, options.statuses)
  if (group !== 'completed') {
    if (task.dueDate !== undefined && task.dueDate < options.now) return 'bg-red-500'
    if (options.blocked) return 'bg-amber-500'
    if (task.riskLevel === 'critical') return 'bg-red-400'
    if (task.riskLevel === 'high') return 'bg-orange-400'
  }
  return GANTT_GROUP_BAR_COLORS[group]
}

// ===== 截止日期紧迫感（任务列表 / 看板卡片共用） =====

export interface DueDateUrgency {
  /** 展示文本，如「09-20 · 剩 5 天」 */
  text: string
  /** 逾期=red，今天或 3 天内=amber，其余=gray */
  tone: 'red' | 'amber' | 'gray'
}

/** 本地当日零点（天级比较基准，避免半夜边界抖动） */
function localMidnight(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * DDL 紧迫感：`isDone` 为 true 时返回 null（调用方按 completed/cancelled 语义组判定）；
 * 逾期 → red「逾期 N 天」，今天 → amber「今天截止」，3 天内 → amber「剩 N 天」，其余 → gray「剩 N 天」。
 */
export function dueDateUrgency(
  dueDate: number | undefined,
  isDone: boolean,
  now = Date.now(),
): DueDateUrgency | null {
  if (isDone || dueDate === undefined || !Number.isFinite(dueDate) || dueDate <= 0) return null
  const remainingDays = Math.round((localMidnight(dueDate) - localMidnight(now)) / DAY)
  const due = new Date(dueDate)
  const dateText = `${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
  if (remainingDays < 0) return { text: `${dateText} · 逾期 ${Math.abs(remainingDays)} 天`, tone: 'red' }
  if (remainingDays === 0) return { text: `${dateText} · 今天截止`, tone: 'amber' }
  return { text: `${dateText} · 剩 ${remainingDays} 天`, tone: remainingDays <= 3 ? 'amber' : 'gray' }
}

// ===== 任务列表紧迫度排序（展示层行为，不影响看板 sort_order 落库顺序） =====

/** 排序所需的任务最小字段集（Task / ProjectTaskAtom 均满足，见同目录两个类型的公共子集） */
export interface SortTask {
  id: string
  status: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  createdAt: number
  dueDate?: number
  completedAt?: number
}

/**
 * 任务列表紧迫度排序（纯展示，不落库）：
 * 1. 逾期未完成（DDL < 今天且非完成组）最前，逾期越久越靠前；
 * 2. 其余按优先级 critical → low；
 * 3. 同级按 dueDate 升序（无 DDL 兜底 MAX_SAFE_INTEGER），再按创建时间倒序；
 * 4. completed/cancelled 语义组沉底，按完成时间倒序。
 * 与甘特图排序（critical→优先级、DDL 升序、无 DDL 最后）同口径，逾期插队到最高档。
 */
export function sortTasksByUrgency<T extends SortTask>(
  tasks: T[],
  statuses: FlowStatusDef[],
  now = Date.now(),
): T[] {
  const groupOf = (statusId: string): FlowStateGroup =>
    statuses.find((s) => s.id === statusId)?.stateGroup ?? BUILTIN_GROUPS[statusId] ?? 'unstarted'
  const isDone = (task: T): boolean => {
    const group = groupOf(task.status)
    return group === 'completed' || group === 'cancelled'
  }
  // 紧迫分位：0=逾期未完成（数值=逾期天数，越小越急）… 完成组固定 3
  const urgencyBucket = (task: T): number => {
    const group = groupOf(task.status)
    if (group === 'completed' || group === 'cancelled') return 3
    if (task.dueDate !== undefined && Number.isFinite(task.dueDate) && task.dueDate > 0
      && localMidnight(task.dueDate) < localMidnight(now)) return 0
    return 1
  }
  const PRIORITY_WEIGHT: Record<SortTask['priority'], number> = { critical: 0, high: 1, medium: 2, low: 3 }
  return [...tasks].sort((a, b) => {
    const aDone = isDone(a)
    const bDone = isDone(b)
    if (aDone !== bDone) return aDone ? 1 : -1
    if (aDone && bDone) return (b.completedAt ?? 0) - (a.completedAt ?? 0)
    const bucketA = urgencyBucket(a)
    const bucketB = urgencyBucket(b)
    if (bucketA !== bucketB) return bucketA - bucketB
    // 逾期档内：逾期越久（dueDate 越早）越靠前；未逾期档内：dueDate 升序
    const dueA = a.dueDate ?? Number.MAX_SAFE_INTEGER
    const dueB = b.dueDate ?? Number.MAX_SAFE_INTEGER
    if (dueA !== dueB) return dueA - dueB
    const byPriority = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority]
    if (byPriority !== 0) return byPriority
    return b.createdAt - a.createdAt
  })
}
