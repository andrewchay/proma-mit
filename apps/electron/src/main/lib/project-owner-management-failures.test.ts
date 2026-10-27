import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'owner-failures-')), previous = process.env.PROMA_TEST_CONFIG_DIR
process.env.PROMA_TEST_CONFIG_DIR = directory
const store = await import('./project-sqlite-store')
const failures = await import('./project-owner-management-failures')
async function ready() { await store.initProjectDb() }
beforeAll(async () => { await ready() })
afterAll(() => { store.closeProjectDb(); if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR; else process.env.PROMA_TEST_CONFIG_DIR = previous; rmSync(directory, { recursive: true, force: true }) })
function project() { return store.createProject({ title: '退避项目', description: '' }) }

test('Given同一失败连续出现 When记录 Then指数退避且在重启后仍生效', async () => {
  await ready()
  const p = project(), now = 1_000
  expect(failures.recordOwnerManagementFailure(p.id, '来源不一致', now)).toMatchObject({ attemptCount: 1, retryUntil: now + 2_000, notified: false })
  expect(failures.recordOwnerManagementFailure(p.id, '来源不一致', now + 5_000)).toMatchObject({ attemptCount: 2, retryUntil: now + 5_000 + 8_000, notified: false })
  expect(failures.recordOwnerManagementFailure(p.id, '来源不一致', now + 20_000)).toMatchObject({ attemptCount: 3, notified: false })
  expect(failures.markOwnerManagementFailureNotified(p.id, '来源不一致', now + 20_001)).toBe(true)
  // 重新读取模拟重启：退避状态来自SQLite而不是进程内存。
  store.closeProjectDb()
  await ready()
  const reopened = failures.readOwnerManagementFailure(p.id)
  expect(reopened).toMatchObject({ failureKey: '来源不一致', attemptCount: 3, notified: true })
  expect(reopened!.retryUntil).toBeGreaterThan(20_000)
})

test('Given不同失败键 When记录 Then视为新的连续故障并从第一次开始', async () => {
  await ready()
  const p = project(), now = 5_000
  failures.recordOwnerManagementFailure(p.id, '第一条', now)
  expect(failures.recordOwnerManagementFailure(p.id, '第二条', now + 100)).toMatchObject({ failureKey: '第二条', attemptCount: 1, notified: false })
})

test('Given退避已提示 When重复对账 Then只标记一次且清除后可重新累计', async () => {
  await ready()
  const p = project(), now = 9_000
  failures.recordOwnerManagementFailure(p.id, '重复', now)
  failures.recordOwnerManagementFailure(p.id, '重复', now + 1)
  failures.recordOwnerManagementFailure(p.id, '重复', now + 2)
  expect(failures.markOwnerManagementFailureNotified(p.id, '重复', now + 3)).toBe(true)
  expect(failures.markOwnerManagementFailureNotified(p.id, '重复', now + 4)).toBe(false)
  failures.clearOwnerManagementFailure(p.id)
  expect(failures.readOwnerManagementFailure(p.id)).toBeNull()
  expect(failures.recordOwnerManagementFailure(p.id, '重复', now + 5)).toMatchObject({ attemptCount: 1, notified: false })
})

test('Given空项目或失败键 When记录 Then拒绝写入无效退避', async () => {
  await ready()
  const p = project()
  expect(() => failures.recordOwnerManagementFailure('', 'x')).toThrow('身份无效')
  expect(() => failures.recordOwnerManagementFailure(p.id, '  ')).toThrow('身份无效')
})
