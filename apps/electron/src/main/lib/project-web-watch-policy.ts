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

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_CONSECUTIVE_FAILURE_NOTICES = 3

/** 一天最多一条成功提醒：同一天已提醒过就不再打扰。 */
export function shouldNotifySuccess(config: Pick<ProjectWebWatchConfig, 'lastNotifiedAt'>, now: number): boolean {
  if (!config.lastNotifiedAt) return true
  return new Date(config.lastNotifiedAt).toDateString() !== new Date(now).toDateString()
}

/** 失败 24 小时最多一条；连续失败达到 3 次后只在项目页显示，不再弹系统通知。 */
export function shouldNotifyFailure(config: Pick<ProjectWebWatchConfig, 'lastFailureNotifiedAt'>, failures: number, now: number): boolean {
  if (!Number.isSafeInteger(failures) || failures < 1) return false
  if (failures >= MAX_CONSECUTIVE_FAILURE_NOTICES) return false
  if (!config.lastFailureNotifiedAt) return true
  return now - config.lastFailureNotifiedAt >= DAY_MS
}
