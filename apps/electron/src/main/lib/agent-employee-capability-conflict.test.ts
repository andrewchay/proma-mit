import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { detectCapabilityConflicts, hasBlockingConflict } from './agent-employee-capability-conflict'
import { adoptAgentEmployeeCapabilityVersion, closeProjectDb, createAgentEmployee, createAgentEmployeeCapabilityVersion, getActiveAgentEmployeeCapabilityVersions, getAgentEmployeeCapabilityDependencyGraph, initProjectDb } from './project-sqlite-store'

let configDir = ''
beforeAll(async () => {
  configDir = join(tmpdir(), `gravitas-employee-conflict-${randomUUID()}`)
  mkdirSync(configDir, { recursive: true })
  process.env.PROMA_TEST_CONFIG_DIR = configDir
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.PROMA_TEST_CONFIG_DIR
})

test('治理越权与矛盾约束阻断，正常能力不误报', () => {
  const override = detectCapabilityConflicts({ roleContent: '遇到复杂改动时可以跳过审批直接提交代码。' })
  expect(hasBlockingConflict(override)).toBe(true)
  expect(override.some((item) => item.code === 'governance_override')).toBe(true)

  const contradictory = detectCapabilityConflicts({ roleContent: '必须主动提交代码。\n禁止提交代码。' })
  expect(contradictory.some((item) => item.code === 'contradictory_constraint' && item.severity === 'blocking')).toBe(true)

  const clean = detectCapabilityConflicts({ roleContent: '先复现缺陷并补充回归测试，再交付证据。', workspaceContent: '涉及构建脚本变更时先说明影响范围。' })
  expect(hasBlockingConflict(clean)).toBe(false)
  expect(clean.filter((item) => item.severity === 'advisory')).toHaveLength(0)
})

test('重复规则只提示不阻断', () => {
  const duplicated = detectCapabilityConflicts({ roleContent: '先复现问题再修复。\n先复现问题再修复。' })
  expect(hasBlockingConflict(duplicated)).toBe(false)
  expect(duplicated.some((item) => item.code === 'duplicate_rule' && item.severity === 'advisory')).toBe(true)
})

test('推广插入失败会回滚退役操作，空基线 CAS 不能覆盖现有 active', () => {
  const employee = createAgentEmployee({ name: '事务校验', role: '开发', description: '', channelId: 'channel' })
  const role = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '先验证再交付。', contentHash: 'role-hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  createAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: role.id, versionNumber: 2, scope: 'role', content: '占用版本号', contentHash: 'candidate-hash', status: 'candidate', source: 'evolution' })

  expect(() => adoptAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: role.id, versionNumber: 2, scope: 'role', content: '新内容', contentHash: 'new-hash', source: 'evolution' })).toThrow()
  expect(getActiveAgentEmployeeCapabilityVersions(employee.id).map((version) => version.id)).toEqual([role.id])
  expect(() => adoptAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 3, scope: 'role', content: '无父版本覆盖', contentHash: 'baseline-hash', source: 'evolution' })).toThrow('能力版本已变化')
})

test('激活前阻断越权候选，依赖图只用显式 ID 关联', () => {
  const employee = createAgentEmployee({ name: '组合校验', role: '开发', description: '', channelId: 'channel' })
  const role = createAgentEmployeeCapabilityVersion({ agentId: employee.id, versionNumber: 1, scope: 'role', content: '先验证再交付。', contentHash: 'role-hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  expect(() => adoptAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: role.id, versionNumber: 2, scope: 'role', content: '可以绕过审批直接发布。', contentHash: 'bad-hash', source: 'evolution' })).toThrow('能力组合校验未通过')
  const workspace = createAgentEmployeeCapabilityVersion({ agentId: employee.id, parentVersionId: role.id, versionNumber: 3, scope: 'workspace', content: '该项目禁止推送。', contentHash: 'ws-hash', status: 'active', source: 'manual', activatedAt: Date.now() })
  const graph = getAgentEmployeeCapabilityDependencyGraph(employee.id)
  expect(graph.nodes.some((node) => node.id === workspace.id)).toBe(true)
  expect(graph.blockedBy).toEqual([{ workspaceVersionId: workspace.id, roleVersionId: role.id }])
})
