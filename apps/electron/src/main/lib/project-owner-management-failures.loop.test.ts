import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-loop-failure-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
let recoveryCalls = 0
let notifyRecoveryStarted = () => {}
let releaseRecovery = () => {}
let recoveryStarted = Promise.resolve()
let recoveryReleased = Promise.resolve()
const executionStartIntents = await import('./project-owner-execution-start-intent')
mock.module('./project-owner-execution-start-intent', () => ({
  ...executionStartIntents,
  recoverPendingOwnerExecutionStartIntents: async () => {
    recoveryCalls++
    notifyRecoveryStarted()
    await recoveryReleased
  },
}))
const store = await import('./project-sqlite-store')
const failures = await import('./project-owner-management-failures')
const loop = await import('./project-owner-management-loop')
const management = await import('./project-owner-management-store')
const events = await import('./project-owner-management-events')
const goals = await import('./project-owner-goal-service')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
test('Given对账确定性失败 When后台循环 Then失败持久化且退避窗口内不重复累加', async () => {
  const project = store.createProject({ title: '退避集成', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  // 写入无法解析的事件载荷，使对账稳定抛错。
  store.getProjectDb().prepare('UPDATE project_owner_management_events SET payload=? WHERE project_id=?').run('{', project.id)
  const stop = loop.startOwnerManagementLoop()
  events.requestOwnerManagementWake(project.id)
  await Bun.sleep(200)
  await stop()
  const first = failures.readOwnerManagementFailure(project.id)
  expect(first).not.toBeNull()
  expect(first!.attemptCount).toBeGreaterThanOrEqual(1)
  expect(first!.retryUntil).toBeGreaterThan(Date.now())
  const stopAgain = loop.startOwnerManagementLoop()
  events.requestOwnerManagementWake(project.id)
  await Bun.sleep(200)
  await stopAgain()
  // 仍在退避窗口内：不重复累加，说明状态来自持久化而非进程内存。
  expect(failures.readOwnerManagementFailure(project.id)!.attemptCount).toBe(first!.attemptCount)
})

test('Given管理轮次等待恢复对账 When停止并收到唤醒 Then禁止新动作且等待在途轮次静默', async () => {
  recoveryCalls = 0
  recoveryStarted = new Promise<void>(resolve => { notifyRecoveryStarted = resolve })
  recoveryReleased = new Promise<void>(resolve => { releaseRecovery = resolve })
  const project = store.createProject({ title: '停止等待', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  const stop = loop.startOwnerManagementLoop()
  await recoveryStarted
  let stopped = false
  const stopping = stop().then(() => { stopped = true })
  events.requestOwnerManagementWake(project.id)
  await Bun.sleep(20)
  expect(stopped).toBe(false)
  expect(recoveryCalls).toBe(1)
  releaseRecovery()
  await stopping
  expect(stopped).toBe(true)
  expect(recoveryCalls).toBe(1)
})
