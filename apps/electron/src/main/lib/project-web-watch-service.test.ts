import { describe, expect, test } from 'bun:test'
import { isProjectWebWatchDue } from './project-web-watch-policy'

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
