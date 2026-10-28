import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectDb, createAgentEmployeeCapabilityVersion, createAgentEmployeeLearningSample, createAgentExecution, createProject,
  createTask, excludeAgentEmployeeLearningSample, getAgentEmployeeCapabilityHealth, initProjectDb, listAgentEmployeeLearningSamples, reviewAgentEmployeeLearningSample, updateAgentExecution,
} from './project-sqlite-store'
import { getProjectChain, updateProjectChain } from './project-chain-service'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-judgment-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = directory; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

test('Given 人工退回并重新验收 When 读取学习样本 Then 判断按交付版本关联且保留历史', () => {
  const version = createAgentEmployeeCapabilityVersion({ agentId: 'judgment-agent', versionNumber: 1, scope: 'role', content: '能力', contentHash: 'judgment', status: 'active', source: 'manual' })
  const project = createProject({ title: '人工判断', description: '' })
  const task = createTask(project.id, { title: '交付', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createAgentExecution({ id: 'judgment-run', projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'judgment-agent', sessionId: 'judgment-session', prompt: '交付' })
  updateAgentExecution('judgment-run', { status: 'completed', completedAt: Date.now() })
  const sample = createAgentEmployeeLearningSample({ agentId: 'judgment-agent', executionId: 'judgment-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [version.id], outcome: 'accepted', evidenceSummary: '执行完成', privacyStatus: 'pending' })
  const initial = updateProjectChain(project.id, 0, { kind: 'decision', title: '方向', rationale: '确定范围', evidence: '依据' })
  const draft = { kind: 'draft' as const, taskId: task.id, title: '报告', content: '初稿', criteria: '可阅读', recipient: '本地用户', responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' }, decisionIds: [initial.decisions[0]!.id], executionId: 'judgment-run' }
  let chain = updateProjectChain(project.id, initial.revision, draft)
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  expect(listAgentEmployeeLearningSamples('judgment-agent')[0]!.ownerJudgment).toBeUndefined()
  chain = updateProjectChain(project.id, chain.revision, { kind: 'reject', draftId, comment: '方向需要调整', reasonCode: 'wrong_direction' })
  const rejected = listAgentEmployeeLearningSamples('judgment-agent')[0]!
  expect(rejected.ownerJudgment).toMatchObject({ outcome: 'changes_requested', reasonCode: 'wrong_direction', deliveryId: draftId, deliveryVersion: 1, actor: 'local-user' })
  expect(rejected.outcome).toBe('accepted')
  expect(rejected.privacyStatus).toBe('pending')
  expect(getAgentEmployeeCapabilityHealth('judgment-agent')[0]).toMatchObject({ humanJudgmentEligibleCount: 0, humanAcceptedCount: 0, humanChangesRequestedCount: 0 })
  reviewAgentEmployeeLearningSample(sample.id, '已脱敏的执行摘要')
  expect(getAgentEmployeeCapabilityHealth('judgment-agent')[0]).toMatchObject({ humanJudgmentEligibleCount: 1, humanAcceptedCount: 0, humanChangesRequestedCount: 1 })
  chain = updateProjectChain(project.id, chain.revision, { ...draft, draftId, changeReason: '调整方向', content: '修订稿' })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'accept', draftId, comment: '已核对', evidence: '人工核对' })
  expect(listAgentEmployeeLearningSamples('judgment-agent')[0]!.ownerJudgment).toMatchObject({ outcome: 'business_accepted', deliveryVersion: 2, actor: 'local-user' })
  expect(getAgentEmployeeCapabilityHealth('judgment-agent')[0]).toMatchObject({ humanAcceptedCount: 1, humanChangesRequestedCount: 0 })
  expect(getProjectChain(project.id).events.filter(event => event.action === 'reject' || event.action === 'accept')).toHaveLength(2)
  expect(sample.id).toBe(listAgentEmployeeLearningSamples('judgment-agent')[0]!.id)
  expect(getAgentEmployeeCapabilityHealth('judgment-agent', 30, Date.now() + 31 * 86400000)[0]).toMatchObject({ humanAcceptedCount: 0, humanChangesRequestedCount: 0 })
  excludeAgentEmployeeLearningSample(sample.id)
  expect(getAgentEmployeeCapabilityHealth('judgment-agent')[0]).toMatchObject({ humanAcceptedCount: 0, humanChangesRequestedCount: 0 })
})

test('Given 不合法的原因标签 When 人工退回 Then 项目链不发生变更', () => {
  const project = createProject({ title: '标签校验', description: '' })
  const task = createTask(project.id, { title: '交付', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  const initial = updateProjectChain(project.id, 0, { kind: 'decision', title: '方向', rationale: '确定范围', evidence: '依据' })
  let chain = updateProjectChain(project.id, initial.revision, { kind: 'draft', taskId: task.id, title: '报告', content: '内容', criteria: '可阅读', recipient: '本地用户', responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' }, decisionIds: [initial.decisions[0]!.id] })
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  expect(() => updateProjectChain(project.id, chain.revision, { kind: 'reject', draftId, comment: '返工', reasonCode: 'invalid' as never })).toThrow('原因标签')
  expect(getProjectChain(project.id).revision).toBe(chain.revision)
})

test('Given 人工先验收而样本稍后创建 When 读取样本 Then 可从权威历史重新关联', () => {
  const project = createProject({ title: '迟到的学习样本', description: '' })
  const task = createTask(project.id, { title: '交付', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createAgentExecution({ id: 'late-run', projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'late-agent', sessionId: 'late-session', prompt: '交付' })
  updateAgentExecution('late-run', { status: 'completed', completedAt: Date.now() })
  let chain = updateProjectChain(project.id, 0, { kind: 'decision', title: '方向', rationale: '确定范围', evidence: '依据' })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'draft', taskId: task.id, title: '报告', content: '内容', criteria: '可阅读', recipient: '本地用户', responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' }, decisionIds: [chain.decisions[0]!.id], executionId: 'late-run' })
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  updateProjectChain(project.id, chain.revision, { kind: 'accept', draftId, comment: '通过', evidence: '人工核对' })
  createAgentEmployeeLearningSample({ agentId: 'late-agent', executionId: 'late-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [], outcome: 'accepted', evidenceSummary: '执行完成', privacyStatus: 'pending' })
  expect(listAgentEmployeeLearningSamples('late-agent')[0]!.ownerJudgment).toMatchObject({ outcome: 'business_accepted', deliveryId: draftId, deliveryVersion: 1 })
})

test('Given 自动验收通过 When 读取学习样本 Then 不生成未经人工确认的业务判断', () => {
  const version = createAgentEmployeeCapabilityVersion({ agentId: 'auto-agent', versionNumber: 1, scope: 'role', content: '能力', contentHash: 'auto', status: 'active', source: 'manual' })
  const project = createProject({ title: '自动验收', description: '' })
  const task = createTask(project.id, { title: '交付', description: '', assignee: { userId: 'local-user', displayName: '本地用户' } })
  createAgentExecution({ id: 'auto-run', projectId: project.id, entityType: 'task', entityId: task.id, agentId: 'auto-agent', sessionId: 'auto-session', prompt: '交付' })
  updateAgentExecution('auto-run', { status: 'completed', completedAt: Date.now() })
  createAgentEmployeeLearningSample({ agentId: 'auto-agent', executionId: 'auto-run', projectId: project.id, taskId: task.id, capabilityVersionIds: [version.id], outcome: 'accepted', evidenceSummary: '执行完成', privacyStatus: 'sanitized' })
  let chain = updateProjectChain(project.id, 0, { kind: 'decision', title: '方向', rationale: '确定范围', evidence: '依据' })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'set_project_dod', criteria: ['存在交付引用'] })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'set_task_dod_auto_acceptance', taskId: task.id, enabled: true, riskLevel: 'low', rules: [{ criterion: '存在交付引用', verifier: 'artifact_reference_present' }] })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'draft', taskId: task.id, title: '报告', content: '内容', artifactRef: 'artifact:report', criteria: '可阅读', recipient: '本地用户', responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' }, decisionIds: [chain.decisions[0]!.id], executionId: 'auto-run' })
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId: chain.drafts[0]!.id })
  expect(chain.drafts[0]!.status).toBe('accepted')
  expect(chain.events.some(event => event.action === 'auto_accept')).toBe(true)
  expect(listAgentEmployeeLearningSamples('auto-agent')[0]!.ownerJudgment).toBeUndefined()
  expect(getAgentEmployeeCapabilityHealth('auto-agent')[0]).toMatchObject({ humanJudgmentEligibleCount: 1, humanAcceptedCount: 0, humanChangesRequestedCount: 0 })
})
