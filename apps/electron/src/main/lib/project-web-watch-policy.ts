import type { ProjectWebWatchConfig } from './project-web-watch-service'

/** 逾期计划在启动后最多触发一次；后续覆盖区间从上次成功时间开始计算。 */
export function isProjectWebWatchDue(config: Pick<ProjectWebWatchConfig, 'enabled' | 'localTime' | 'lastAttemptAt'>, now: Date): boolean {
  if (!config.enabled) return false
  const parts = config.localTime.split(':').map((part) => Number(part ?? ''))
  const hour = parts[0] ?? Number.NaN
  const minute = parts[1] ?? Number.NaN
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return false
  if (now.getHours() < hour || (now.getHours() === hour && now.getMinutes() < minute)) return false
  const lastAttempt = config.lastAttemptAt ? new Date(config.lastAttemptAt) : undefined
  return !lastAttempt || lastAttempt.toDateString() !== now.toDateString()
}
