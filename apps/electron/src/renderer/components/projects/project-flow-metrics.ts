export interface FlowMetricTask {
  id: string
  status: string
  createdAt: number
  startDate?: number
  completedAt?: number
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

/** 基于项目权威任务时间戳计算，不从链路文案推断开始或完成时间。 */
export function calculateProjectFlowMetrics(
  tasks: FlowMetricTask[],
  blockedTaskIds: ReadonlySet<string>,
  serviceLevelDays: number,
  now = Date.now(),
): ProjectFlowMetrics {
  const active = tasks.filter((task) => task.status !== 'draft' && task.status !== 'completed')
  const completed = tasks.filter((task) => task.status === 'completed' && task.completedAt)
  const cycleTimes = completed.map((task) => task.completedAt! - (task.startDate ?? task.createdAt))
  const activeAges = active.map((task) => now - (task.startDate ?? task.createdAt))
  return {
    workInProgress: tasks.filter((task) => task.status === 'in_progress').length,
    waiting: active.filter((task) => task.status === 'pending' || blockedTaskIds.has(task.id)).length,
    throughput30Days: completed.filter((task) => task.completedAt! >= now - 30 * DAY).length,
    ...(cycleTimes.length
      ? { averageCycleTimeDays: days(cycleTimes.reduce((sum, value) => sum + value, 0) / cycleTimes.length) }
      : {}),
    ...(activeAges.length ? { oldestWorkItemAgeDays: days(Math.max(...activeAges)) } : {}),
    serviceLevelBreaches: activeAges.filter((age) => age > serviceLevelDays * DAY).length,
  }
}
