import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
const directory = mkdtempSync(join(tmpdir(), 'owner-loop-failure-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
let recoveryCalls = 0
let recoveryError = false
let recoveryTarget = ''
let notifyRecoveryStarted = () => {}
let releaseRecovery = () => {}
let recoveryStarted = Promise.resolve()
let recoveryReleased = Promise.resolve()
const executionStartIntents = await import('./project-owner-execution-start-intent')
mock.module('./project-owner-execution-start-intent', () => ({
  ...executionStartIntents,
  recoverPendingOwnerExecutionStartIntents: async (projectId: string) => {
    if (recoveryTarget && projectId !== recoveryTarget) return
    recoveryCalls++
    if (recoveryError) throw new Error('模拟异步恢复失败')
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

test('Given异步恢复持续失败 When重复唤醒 Then持久退避阻止忙循环并在恢复后清除', async () => {
  const project = store.createProject({ title: '异步恢复退避', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  recoveryTarget = project.id
  recoveryError = true
  const stop = loop.startOwnerManagementLoop()
  try {
    await Bun.sleep(50)
    expect(failures.readOwnerManagementFailure(project.id)).toMatchObject({ failureKey: '模拟异步恢复失败', attemptCount: 1 })
    events.requestOwnerManagementWake(project.id)
    await Bun.sleep(30)
    expect(failures.readOwnerManagementFailure(project.id)?.attemptCount).toBe(1)
    recoveryError = false
    store.getProjectDb().prepare('UPDATE project_owner_management_failures SET retry_until = 0 WHERE project_id = ?').run(project.id)
    events.requestOwnerManagementWake(project.id)
    await Bun.sleep(50)
    expect(failures.readOwnerManagementFailure(project.id)).toBeNull()
  } finally { recoveryError = false; recoveryTarget = ''; await stop() }
})

test('Given管理轮次等待恢复对账 When停止并收到唤醒 Then禁止新动作且等待在途轮次静默', async () => {
  recoveryCalls = 0
  recoveryStarted = new Promise<void>(resolve => { notifyRecoveryStarted = resolve })
  recoveryReleased = new Promise<void>(resolve => { releaseRecovery = resolve })
  const project = store.createProject({ title: '停止等待', description: '' })
  recoveryTarget = project.id
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
  recoveryTarget = ''
  expect(stopped).toBe(true)
  expect(recoveryCalls).toBe(1)
})

test('Given项目对账仍在运行 When新目标事件到达 Then当前轮结束后重新对账且不丢事件', async () => {
  recoveryStarted = new Promise<void>(resolve => { notifyRecoveryStarted = resolve })
  recoveryReleased = new Promise<void>(resolve => { releaseRecovery = resolve })
  const project = store.createProject({ title: '在途唤醒', description: '' })
  recoveryTarget = project.id
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '原目标', constraints: [], acceptanceCriteria: [] }))
  const stop = loop.startOwnerManagementLoop()
  try {
    await recoveryStarted
    goals.saveProjectOwnerGoalDraft(project.id, 1, { objective: '更新目标', constraints: [], acceptanceCriteria: [] })
    await Bun.sleep(30)
    expect(management.listPendingOwnerManagementEvents(project.id).some(event => event.sourceRevision === 2)).toBe(true)
    releaseRecovery()
    for (let i = 0; i < 50 && management.listPendingOwnerManagementEvents(project.id).some(event => event.sourceRevision === 2); i++) await Bun.sleep(20)
    expect(management.listPendingOwnerManagementEvents(project.id).some(event => event.sourceRevision === 2)).toBe(false)
  } finally { releaseRecovery(); await stop(); recoveryTarget = '' }
})

test('Given事件处理事务失败 When故障解除后重新对账 Then保留事件并只处理一次', () => {
  const project = store.createProject({ title: '事件恢复', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  const db = store.getProjectDb()
  const event = management.listPendingOwnerManagementEvents(project.id)[0]!
  db.exec("CREATE TRIGGER owner_test_fail_consume BEFORE UPDATE OF consumed_at ON project_owner_management_events WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, '模拟事务失败'); END")
  try {
    expect(() => loop.reconcileOwnerManagement(project.id)).toThrow('模拟事务失败')
    expect(management.listPendingOwnerManagementEvents(project.id).map(item => item.id)).toContain(event.id)
    expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id = ? AND event_id = ? AND json_extract(payload, \"$.role\") = ?').get(project.id, event.id, 'assistant')).toEqual({ count: 0 })
  } finally {
    db.exec('DROP TRIGGER owner_test_fail_consume')
  }
  loop.reconcileOwnerManagement(project.id)
  loop.reconcileOwnerManagement(project.id)
  expect(management.listPendingOwnerManagementEvents(project.id).map(item => item.id)).not.toContain(event.id)
  expect(db.prepare('SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id = ? AND event_id = ? AND json_extract(payload, \"$.role\") = ?').get(project.id, event.id, 'assistant')).toEqual({ count: 1 })
})

test('Given后台事件处理失败 When退避到期且故障解除 Then自动续接并清除失败状态', async () => {
  const project = store.createProject({ title: '后台事件恢复', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  const db = store.getProjectDb()
  const event = management.listPendingOwnerManagementEvents(project.id)[0]!
  db.exec("CREATE TRIGGER owner_test_background_failure BEFORE UPDATE OF consumed_at ON project_owner_management_events WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, '模拟后台故障'); END")
  const stop = loop.startOwnerManagementLoop()
  try {
    expect(failures.readOwnerManagementFailure(project.id)?.attemptCount).toBe(1)
    expect(management.listPendingOwnerManagementEvents(project.id).map(item => item.id)).toContain(event.id)
    db.exec('DROP TRIGGER owner_test_background_failure')
    // 无需新事件或等待 30 秒巡检，持久退避到期后自动唤醒。
    for (let i = 0; i < 60 && management.listPendingOwnerManagementEvents(project.id).some(item => item.id === event.id); i++) await Bun.sleep(50)
    expect(management.listPendingOwnerManagementEvents(project.id).map(item => item.id)).not.toContain(event.id)
    expect(failures.readOwnerManagementFailure(project.id)).toBeNull()
  } finally {
    db.exec('DROP TRIGGER IF EXISTS owner_test_background_failure')
    await stop()
  }
})

test('Given连续故障的提示写入失败 When下一轮重试 Then提示标记不丢失且只保存一次', async () => {
  const project = store.createProject({ title: '故障提示恢复', description: '' })
  management.recordOwnerManagementGoal(goals.saveProjectOwnerGoalDraft(project.id, 0, { objective: '形成方案', constraints: [], acceptanceCriteria: [] }))
  const db = store.getProjectDb()
  db.exec("CREATE TRIGGER owner_test_repeated_failure BEFORE UPDATE OF consumed_at ON project_owner_management_events WHEN NEW.consumed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, '持续故障'); END")
  db.exec("CREATE TRIGGER owner_test_notice_failure BEFORE INSERT ON project_owner_management_messages WHEN json_extract(NEW.payload, '$.kind') = 'attention' BEGIN SELECT RAISE(ABORT, '提示写入失败'); END")
  const stop = loop.startOwnerManagementLoop()
  const retry = async () => {
    db.prepare('UPDATE project_owner_management_failures SET retry_until = 0 WHERE project_id = ?').run(project.id)
    events.requestOwnerManagementWake(project.id)
    await Bun.sleep(30)
  }
  try {
    await retry(); await retry()
    expect(failures.readOwnerManagementFailure(project.id)).toMatchObject({ attemptCount: 3, notified: false })
    db.exec('DROP TRIGGER owner_test_notice_failure')
    await retry(); await retry()
    expect(failures.readOwnerManagementFailure(project.id)).toMatchObject({ attemptCount: 5, notified: true })
    expect(db.prepare("SELECT COUNT(*) AS count FROM project_owner_management_messages WHERE project_id = ? AND json_extract(payload, '$.kind') = 'attention'").get(project.id)).toEqual({ count: 1 })
  } finally {
    db.exec('DROP TRIGGER IF EXISTS owner_test_notice_failure')
    db.exec('DROP TRIGGER owner_test_repeated_failure')
    await stop()
  }
})
