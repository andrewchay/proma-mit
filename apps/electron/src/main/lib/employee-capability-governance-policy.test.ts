import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_GOVERNANCE_POLICY, getGovernancePolicy, listGovernanceAudits, resetGovernancePolicyForTests, updateGovernancePolicy } from './employee-capability-governance-policy'

let configDir = ''
beforeAll(() => {
  configDir = join(tmpdir(), `gravitas-governance-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
})
afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})
beforeEach(() => resetGovernancePolicyForTests())

test('治理配置默认不清理数据，且越界值被拒绝', () => {
  const policy = getGovernancePolicy()
  expect(policy.sampleRetentionDays).toBeNull()
  expect(policy.auditRetentionDays).toBeNull()
  expect(() => updateGovernancePolicy({ minSanitizedSamples: 0 })).toThrow('minSanitizedSamples')
  expect(() => updateGovernancePolicy({ maxCanaryPercent: 200 })).toThrow('maxCanaryPercent')
  expect(() => updateGovernancePolicy({ cooldownDays: 1.5 })).toThrow('cooldownDays')
})

test('每次实际变更写入审计，重复赋值不产生审计', () => {
  const first = updateGovernancePolicy({ cooldownDays: 14 })
  expect(first.audits).toHaveLength(1)
  expect(first.audits[0]).toEqual(expect.objectContaining({ field: 'cooldownDays', previousValue: DEFAULT_GOVERNANCE_POLICY.cooldownDays, nextValue: 14, actorId: 'local-user' }))
  const second = updateGovernancePolicy({ cooldownDays: 14 })
  expect(second.audits).toHaveLength(0)
  expect(listGovernanceAudits()).toHaveLength(1)
  expect(getGovernancePolicy().cooldownDays).toBe(14)
})

test('保留期可显式开启与关闭', () => {
  updateGovernancePolicy({ sampleRetentionDays: 180 })
  expect(getGovernancePolicy().sampleRetentionDays).toBe(180)
  updateGovernancePolicy({ sampleRetentionDays: null })
  expect(getGovernancePolicy().sampleRetentionDays).toBeNull()
  expect(() => updateGovernancePolicy({ minSanitizedSamples: null })).toThrow('不允许为空')
})
