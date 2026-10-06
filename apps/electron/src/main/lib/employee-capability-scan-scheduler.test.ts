import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getEmployeeCapabilityScanSchedule, isScanDue, runEmployeeCapabilityScanIfDue, updateEmployeeCapabilityScanSchedule } from './employee-capability-scan-scheduler'
import { closeProjectDb, initProjectDb } from './project-sqlite-store'
import { resetRecommendationServiceForTests } from './recommendation-service'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-scan-scheduler-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})
beforeEach(() => {
  resetRecommendationServiceForTests()
  updateEmployeeCapabilityScanSchedule({ enabled: false })
})

test('扫描调度默认关闭，关闭时不判定到点也不运行', () => {
  const schedule = getEmployeeCapabilityScanSchedule()
  expect(schedule.enabled).toBe(false)
  expect(isScanDue(schedule)).toBe(false)
  expect(runEmployeeCapabilityScanIfDue().ran).toBe(false)
})

test('间隔低于下限被拒绝，启用后按间隔判定到点', () => {
  expect(() => updateEmployeeCapabilityScanSchedule({ enabled: true, intervalHours: 1 })).toThrow('扫描间隔')
  const now = Date.now()
  const schedule = updateEmployeeCapabilityScanSchedule({ enabled: true, intervalHours: 12 }, now)
  expect(schedule.enabled).toBe(true)
  expect(isScanDue(schedule, now)).toBe(true)
  expect(isScanDue({ ...schedule, lastRunAt: now }, now + 60 * 60 * 1000)).toBe(false)
  expect(isScanDue({ ...schedule, lastRunAt: now }, now + 13 * 60 * 60 * 1000)).toBe(true)
})

test('到点扫描只运行本地只读扫描，并记录运行时间', () => {
  const now = Date.now()
  updateEmployeeCapabilityScanSchedule({ enabled: true, intervalHours: 6 }, now)
  const result = runEmployeeCapabilityScanIfDue(now)
  expect(result.ran).toBe(true)
  expect(result.created).toBe(0)
  expect(getEmployeeCapabilityScanSchedule().lastRunAt).toBe(now)
})
