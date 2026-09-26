import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeProjectDb, createProject, initProjectDb } from './project-sqlite-store'
import { assertPilotPolicyActive, getPilotPolicy, savePilotPolicyDraft, pausePilotPolicy } from './project-pilot-policy'

const dir = mkdtempSync(join(tmpdir(), 'pilot-policy-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})
const grant = () => ({ workspaceId: 'fixture-workspace', employeeIds: ['executor', 'reviewer'], modelId: 'fixture-model',
  channelId: 'fixture-channel', maxCostMicros: 1_000_000, maxRuns: 3, maxRework: 1, expiresAt: Date.now() + 100_000 })

test('未授权项目默认拒绝，单项目草案持久化但仍不可激活', () => {
  const first = createProject({ title: '首个项目', description: '' })
  const other = createProject({ title: '另一个项目', description: '' })
  expect(getPilotPolicy(first.id)).toBeNull()
  expect(() => assertPilotPolicyActive(first.id)).toThrow('未获有效托管授权')
  const policy = savePilotPolicyDraft(first.id, grant(), null)
  expect(policy.revision).toBe(1)
  expect(policy.state).toBe('paused')
  expect(getPilotPolicy(first.id)?.employeeIds).toEqual(['executor', 'reviewer'])
  expect(() => assertPilotPolicyActive(first.id)).toThrow('未获有效托管授权')
  expect(() => assertPilotPolicyActive(other.id)).toThrow('未获有效托管授权')
  expect(() => assertPilotPolicyActive(first.id, policy.expiresAt)).toThrow('未获有效托管授权')
  expect(() => savePilotPolicyDraft(first.id, grant(), null)).toThrow('版本已变化')
})

test('暂停保留版本，拒绝重复暂停与旧版本写入', () => {
  const project = createProject({ title: '暂停项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, grant(), null)
  const paused = pausePilotPolicy(project.id, policy.revision)
  expect(paused.state).toBe('paused')
  expect(() => assertPilotPolicyActive(project.id)).toThrow('未获有效托管授权')
  expect(() => pausePilotPolicy(project.id, policy.revision)).toThrow('版本已变化')
  expect(() => savePilotPolicyDraft(project.id, grant(), policy.revision)).toThrow('版本已变化')
})

test('拒绝虚构项目、缺预算、无效员工与重复员工', () => {
  const project = createProject({ title: '验证项目', description: '' })
  expect(() => savePilotPolicyDraft('missing', grant(), null)).toThrow('项目不存在')
  expect(() => savePilotPolicyDraft(project.id, { ...grant(), maxCostMicros: 0 }, null)).toThrow('必须限定')
  expect(() => savePilotPolicyDraft(project.id, { ...grant(), employeeIds: ['executor', 'executor'] }, null)).toThrow('必须限定')
  expect(() => savePilotPolicyDraft(project.id, { ...grant(), expiresAt: Date.now() - 1 }, null)).toThrow('必须限定')
})

test('即便磁盘伪造 active 也不得激活', () => {
  const project = createProject({ title: '假授权项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, grant(), null)
  const file = join(dir, 'project-pilot-policies.json')
  const original = readFileSync(file, 'utf8')
  try {
    writeFileSync(file, JSON.stringify({ version: 1, policies: [{ ...policy, state: 'active' }] }))
    expect(() => assertPilotPolicyActive(project.id)).toThrow('授权配置无效')
  } finally { writeFileSync(file, original) }
})

test('遗留锁阻止并发修改，恢复锁后仍遵守 revision', () => {
  const project = createProject({ title: '锁冲突项目', description: '' })
  const lock = join(dir, 'project-pilot-policies.json.lock')
  mkdirSync(lock)
  try { expect(() => savePilotPolicyDraft(project.id, grant(), null)).toThrow('遗留锁') }
  finally { rmdirSync(lock) }
  const policy = savePilotPolicyDraft(project.id, grant(), null)
  expect(() => savePilotPolicyDraft(project.id, grant(), null)).toThrow('版本已变化')
  expect(policy.state).toBe('paused')
})

test('符号链接配置拒绝读写，不追随链接目标', () => {
  const project = createProject({ title: '链接项目', description: '' })
  const file = join(dir, 'project-pilot-policies.json')
  const backup = readFileSync(file, 'utf8')
  const external = join(dir, 'outside.json')
  writeFileSync(external, 'sentinel')
  unlinkSync(file)
  symlinkSync(external, file)
  try {
    expect(() => getPilotPolicy(project.id)).toThrow('不是普通文件')
    expect(() => savePilotPolicyDraft(project.id, grant(), null)).toThrow('不是普通文件')
    expect(readFileSync(external, 'utf8')).toBe('sentinel')
  } finally { unlinkSync(file); writeFileSync(file, backup) }
})

test('配置损坏拒绝授权读写，不以空索引覆盖', () => {
  const project = createProject({ title: '损坏配置', description: '' })
  const file = join(dir, 'project-pilot-policies.json')
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, '{bad')
  try {
    expect(() => getPilotPolicy(project.id)).toThrow('无法读取')
    expect(() => savePilotPolicyDraft(project.id, grant(), null)).toThrow('无法读取')
    expect(readFileSync(file, 'utf8')).toBe('{bad')
  } finally { writeFileSync(file, original) }
})
