import { describe, expect, test } from 'bun:test'
import { isProjectWebWatchDue, shouldNotifyFailure, shouldNotifySuccess } from './project-web-watch-policy'

describe('项目每日外网扫描调度（BDD）', () => {
  const config = { projectId: 'project-1', enabled: true, topics: ['供应链风险'], localTime: '09:00', updatedAt: 0 }

  test('Given 今天计划时间未到 When 检查调度 Then 不启动扫描', () => {
    expect(isProjectWebWatchDue(config, new Date(2026, 9, 28, 8, 59))).toBe(false)
  })

  test('Given 今天计划时间已到且当天未尝试 When 启动调度 Then 补跑一次', () => {
    expect(isProjectWebWatchDue(config, new Date(2026, 9, 28, 9, 0))).toBe(true)
  })

  test('Given 当天已有一次尝试 When 轮询再次检查 Then 不重复扫描', () => {
    expect(isProjectWebWatchDue({ ...config, lastAttemptAt: new Date(2026, 9, 28, 9, 0).getTime() }, new Date(2026, 9, 28, 10, 0))).toBe(false)
  })

  test('Given 扫描已错过一天且前次尝试在前一天 When 应用重启检查 Then 只判定一次到期', () => {
    expect(isProjectWebWatchDue({ ...config, lastAttemptAt: new Date(2026, 9, 26, 9, 0).getTime() }, new Date(2026, 9, 28, 10, 0))).toBe(true)
  })

  test('Given 扫描已停用 When 时间到达 Then 不执行', () => {
    expect(isProjectWebWatchDue({ ...config, enabled: false }, new Date(2026, 9, 28, 10, 0))).toBe(false)
  })
})

describe('项目外网扫描通知收敛（BDD）', () => {
  const morning = new Date(2026, 10, 1, 9, 0).getTime()
  const evening = new Date(2026, 10, 1, 20, 0).getTime()
  const nextDay = new Date(2026, 10, 2, 9, 0).getTime()

  test('Given 今天还没有提醒 When 判定成功提醒 Then 允许一次', () => {
    expect(shouldNotifySuccess({}, morning)).toBe(true)
  })

  test('Given 今天已经提醒过 When 同一天再提醒 Then 合并为不提醒', () => {
    expect(shouldNotifySuccess({ lastNotifiedAt: morning }, evening)).toBe(false)
  })

  test('Given 昨天提醒过 When 新的一天再提醒 Then 允许', () => {
    expect(shouldNotifySuccess({ lastNotifiedAt: morning }, nextDay)).toBe(true)
  })

  test('Given 24 小时内已提醒失败 When 再次失败 Then 不重复提醒', () => {
    expect(shouldNotifyFailure({ lastFailureNotifiedAt: morning }, 2, morning + 60_000)).toBe(false)
  })

  test('Given 超过 24 小时前提醒过失败 When 再次失败 Then 允许提醒一次', () => {
    expect(shouldNotifyFailure({ lastFailureNotifiedAt: morning }, 2, nextDay)).toBe(true)
  })

  test('Given 连续失败达到 3 次 When 再次失败 Then 不再弹系统通知', () => {
    expect(shouldNotifyFailure({ lastFailureNotifiedAt: morning }, 3, nextDay)).toBe(false)
  })

  test('Given 失败次数无效 When 判定 Then 一律不提醒', () => {
    expect(shouldNotifyFailure({}, 0, morning)).toBe(false)
  })
})
