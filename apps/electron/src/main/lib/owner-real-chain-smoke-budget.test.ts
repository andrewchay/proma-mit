import { afterAll, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildElectronMock } from './testing/electron-mock'
import { assertOwnerSmokeRequestLimit, assertSmokeRequestAllowance, ensureSmokeBudget, remainingSmokeBudget } from './owner-real-chain-smoke-budget'

test('Given真实冒烟请求次数 When接近8次 Then允许第8次并拒绝第9次', () => {
  expect(() => assertSmokeRequestAllowance(7, 8)).not.toThrow()
  expect(() => assertSmokeRequestAllowance(8, 8)).toThrow('上限')
  expect(() => assertSmokeRequestAllowance(19, 20)).not.toThrow()
  expect(() => assertSmokeRequestAllowance(20, 20)).toThrow('上限')
  expect(() => assertSmokeRequestAllowance(59, 60)).not.toThrow()
  expect(() => assertSmokeRequestAllowance(60, 60)).toThrow('上限')
  for (const limit of [0, 61, 1.5, NaN]) expect(() => assertSmokeRequestAllowance(0, limit)).toThrow('边界无效')
  expect(() => assertSmokeRequestAllowance(-1, 8)).toThrow('边界无效')
  expect(() => ensureSmokeBudget(1_400_001)).toThrow('上限')
  expect(remainingSmokeBudget(5012)).toBe(1_394_988)
  expect(() => remainingSmokeBudget(1_400_000)).toThrow('上限')
})


const directory = mkdtempSync(join(tmpdir(), 'owner-smoke-limit-'))
const saved = { config: process.env.PROMA_TEST_CONFIG_DIR, smoke: process.env.GRAVITAS_PACKAGE_SMOKE, channel: process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID, limit: process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS }
process.env.PROMA_TEST_CONFIG_DIR = directory
mock.module('electron', () => buildElectronMock())
const store = await import('./project-sqlite-store')
beforeAll(async () => { await store.initProjectDb() })
afterAll(() => {
  store.closeProjectDb()
  for (const [key, value] of Object.entries({ PROMA_TEST_CONFIG_DIR: saved.config, GRAVITAS_PACKAGE_SMOKE: saved.smoke, GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID: saved.channel, GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS: saved.limit })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(directory, { recursive: true, force: true })
})

test('Given规划与员工共用8笔限制 When事务中申请第9笔 Then拒绝且保持原始计数', () => {
  process.env.GRAVITAS_PACKAGE_SMOKE = '1'
  process.env.GRAVITAS_OWNER_CHAIN_SMOKE_CHANNEL_ID = 'fake-smoke'
  process.env.GRAVITAS_OWNER_CHAIN_SMOKE_MAX_REQUESTS = '8'
  writeFileSync(join(directory, '.package-smoke-empty'), '')
  const db = store.getProjectDb()
  for (let i = 0; i < 4; i++) {
    db.prepare('INSERT INTO project_owner_planning_admissions(link_id,execution_id,session_id,request_hash,source_snapshot,admitted_at) VALUES(?,?,?,?,?,?)').run(`link-${i}`, `exec-${i}`, `session-${i}`, 'hash', '{}', Date.now())
    db.prepare("INSERT INTO project_owner_execution_request_reservations(request_id,command_id,execution_id,session_id,request_evidence_id,price_evidence_id,reserved_cost_micros,state,created_at) VALUES(?,?,?,?,?,?,1,'reserved',?)").run(`r-${i}`, `c-${i}`, `e-${i}`, `s-${i}`, `h-${i}`, 'price', Date.now())
  }
  expect(() => db.transaction(() => assertOwnerSmokeRequestLimit())()).toThrow('8 次请求上限')
  expect(() => assertOwnerSmokeRequestLimit()).toThrow('事务')
  db.prepare('DELETE FROM project_owner_execution_request_reservations WHERE request_id=?').run('r-3')
  expect(() => db.transaction(() => assertOwnerSmokeRequestLimit())()).not.toThrow()
  const prior = process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS
  try {
    process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS = '1'
    expect(() => db.transaction(() => assertOwnerSmokeRequestLimit())()).toThrow('8 次请求上限')
  } finally {
    if (prior === undefined) delete process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS
    else process.env.GRAVITAS_OWNER_CHAIN_SMOKE_PRIOR_REQUESTS = prior
  }
})
