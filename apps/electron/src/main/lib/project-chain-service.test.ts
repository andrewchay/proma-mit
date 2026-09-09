import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectDb,
  createAgentExecution,
  createProject,
  createTask,
  createTaskDependency,
  initProjectDb,
  listTaskBlockers,
  updateAgentExecution,
  updateTask,
} from './project-sqlite-store'
import { getProjectChain, updateProjectChain } from './project-chain-service'
import { saveWorkflowIdentityDirectory } from './workflow-identity-service'
import type { ProjectChainCommand } from '@gravitas/shared'

const directory = mkdtempSync(join(tmpdir(), 'gravitas-chain-'))
const previousDirectory = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => {
  process.env.PROMA_TEST_CONFIG_DIR = directory
  await initProjectDb()
})
afterAll(() => {
  closeProjectDb()
  if (previousDirectory === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previousDirectory
  rmSync(directory, { recursive: true, force: true })
})

test('项目决策、协作、验收与交接在数据库重开后保留，并拒绝过期写入与跨项目引用', async () => {
  const project = createProject({ title: '发布项目', description: '' })
  const task = createTask(project.id, {
    title: '实现',
    description: '',
    assignee: { userId: 'local-user', displayName: '本地用户' },
  })
  let chain = updateProjectChain(project.id, 0, {
    kind: 'decision',
    changeReason: '范围调整',
    title: '发布方向',
    rationale: '采用 A',
    evidence: '会议第 2 段',
  })
  const decisionId = chain.decisions[0]!.id
  const other = createProject({ title: '另一项目', description: '' })
  const otherTask = createTask(other.id, { title: '另一任务', description: '' })
  const draftCommand = {
    kind: 'draft' as const,
    taskId: task.id,
    title: '发布稿',
    content: '交付说明 A',
    criteria: '符合决策',
    recipient: '编辑',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [decisionId],
  }
  expect(() => updateProjectChain(project.id, 0, draftCommand)).toThrow('刷新')
  expect(() =>
    updateProjectChain(project.id, chain.revision, { ...draftCommand, taskId: otherTask.id }),
  ).toThrow('当前项目')
  expect(getProjectChain(project.id)).toEqual(chain)
  chain = updateProjectChain(project.id, chain.revision, draftCommand)
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'accept',
    evidence: 'test-run:123',
    draftId,
    comment: '已检查验收标准',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'request_handoff',
    draftId,
    comment: '交接说明',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'handoff',
    draftId,
    comment: '编辑回执：已接收',
  })
  expect(chain.drafts[0]!.status).toBe('handed_off')
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'decision',
    changeReason: '范围调整',
    decisionId,
    title: '发布方向',
    rationale: '改用 B',
    evidence: '会议第 3 段',
  })
  expect(chain.drafts[0]!.status).toBe('needs_review')
  expect(() =>
    updateProjectChain(project.id, chain.revision, {
      kind: 'accept',
      evidence: 'test-run:123',
      draftId,
      comment: '再次验收',
    }),
  ).toThrow('决策已变更')
  chain = updateProjectChain(project.id, chain.revision, {
    ...draftCommand,
    draftId,
    changeReason: '复核变更',
    content: '交付说明 B',
  })
  expect(chain.drafts[0]!.version).toBe(2)
  expect(chain.drafts[0]!.status).toBe('draft')
  expect(chain.draftHistory[0]!.content).toBe('交付说明 A')
  closeProjectDb()
  await initProjectDb()
  expect(getProjectChain(project.id)).toEqual(chain)
  expect(getProjectChain(other.id).revision).toBe(0)
  updateTask(task.id, { assignee: { userId: 'other-user', displayName: '新负责人' } })
  expect(() => updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })).toThrow(
    '负责人已变更',
  )
  expect(() =>
    updateProjectChain(project.id, chain.revision, {
      ...draftCommand,
      draftId,
      changeReason: '伪造原负责人',
    }),
  ).toThrow('任务负责人')
  expect(getProjectChain(project.id)).toEqual(chain)
})

test('主进程不接受表单冒充其他验收人，停用身份与未知责任人均被拒绝', () => {
  saveWorkflowIdentityDirectory({
    users: [
      { id: 'local-user', displayName: '本地用户', enabled: true, roleIds: [] },
      { id: 'reviewer', displayName: '验收人', enabled: true, roleIds: [] },
    ],
    roles: [],
  })
  const project = createProject({ title: '身份校验', description: '' })
  const task = createTask(project.id, {
    title: '交付',
    description: '',
    assignee: { userId: 'local-user', displayName: '本地用户' },
  })
  let chain = updateProjectChain(project.id, 0, {
    kind: 'decision',
    title: '范围',
    rationale: 'A',
    evidence: '会议',
  })
  const command = {
    kind: 'draft' as const,
    title: '交付',
    taskId: task.id,
    content: '说明',
    criteria: '测试通过',
    recipient: '本地用户',
    responsibilities: { ownerId: 'local-user', reviewerId: 'reviewer', recipientId: 'local-user' },
    decisionIds: [chain.decisions[0]!.id],
  }
  expect(() =>
    updateProjectChain(project.id, chain.revision, {
      ...command,
      responsibilities: { ...command.responsibilities, reviewerId: 'unknown' },
    }),
  ).toThrow('已启用')
  chain = updateProjectChain(project.id, chain.revision, command)
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  const forged = {
    kind: 'accept' as const,
    draftId,
    comment: '通过',
    evidence: 'test:123',
    actor: 'reviewer',
  }
  expect(() => updateProjectChain(project.id, chain.revision, forged)).toThrow('权限')
  saveWorkflowIdentityDirectory({
    users: [{ id: 'local-user', displayName: '本地用户', enabled: true, roleIds: [] }],
    roles: [],
  })
  expect(() => updateProjectChain(project.id, chain.revision, forged)).toThrow('停用')
  expect(getProjectChain(project.id)).toEqual(chain)
})

test('关键决策、DoD、依赖交接和执行记录在权威项目数据上共同形成完成门禁', () => {
  saveWorkflowIdentityDirectory({
    users: [{ id: 'local-user', displayName: '本地用户', enabled: true, roleIds: [] }],
    roles: [],
  })
  const project = createProject({ title: '治理闭环', description: '' })
  const upstream = createTask(project.id, {
    title: '构建',
    description: '',
    assignee: { userId: 'local-user', displayName: '本地用户' },
  })
  const downstream = createTask(project.id, {
    title: '测试',
    description: '',
    assignee: { userId: 'local-user', displayName: '本地用户' },
  })
  const dependency = createTaskDependency(downstream.id, upstream.id)
  let chain = updateProjectChain(project.id, 0, {
    kind: 'decision',
    title: '发布选择',
    rationale: '需拍板',
    evidence: '纪要',
    daci: { driverId: 'local-user', approverId: 'local-user', contributorIds: [], informedIds: [] },
    deadlineAt: Date.now() + 60_000,
    impactTaskIds: [upstream.id],
    alternatives: [{ id: 'a', title: '方案 A', tradeoffs: '速度优先' }],
    sourceRefs: [
      { sourceType: 'meeting', sourceId: 'release-meeting', locator: 'paragraph:3' },
    ],
  })
  const decisionId = chain.decisions[0]!.id
  const draft = {
    kind: 'draft' as const,
    taskId: upstream.id,
    title: '构建包',
    content: '构建说明',
    criteria: 'DoD',
    recipient: '本地用户',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [decisionId],
  }
  expect(() => updateProjectChain(project.id, chain.revision, draft)).toThrow('拍板')
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'approve_decision',
    decisionId,
    comment: '采用 A',
    selectedAlternativeId: 'a',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'set_project_dod',
    criteria: ['来源可追溯'],
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'set_task_dod',
    taskId: upstream.id,
    criteria: ['构建包可下载'],
  })
  createAgentExecution({
    id: 'run-1',
    projectId: project.id,
    entityType: 'task',
    entityId: upstream.id,
    agentId: 'agent-a',
    sessionId: 'session-1',
    prompt: '构建',
  })
  updateAgentExecution('run-1', { status: 'completed', completedAt: Date.now(), resultSummary: '构建完成' })
  chain = updateProjectChain(project.id, chain.revision, { ...draft, executionId: 'run-1' })
  expect(chain.drafts[0]!.executionId).toBe('run-1')
  expect(chain.drafts[0]!.execution).toEqual({
    id: 'run-1',
    agentId: 'agent-a',
    sessionId: 'session-1',
    completedAt: expect.any(Number),
  })
  expect(() => updateTask(upstream.id, { status: 'completed' })).toThrow('DoD')
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'accept',
    draftId,
    comment: '通过',
    evidence: 'review:1',
    completedCriteria: ['来源可追溯', '构建包可下载'],
  })
  expect(updateTask(upstream.id, { status: 'completed' })?.status).toBe('completed')
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'define_dependency_handoff',
    dependencyId: dependency.id,
    upstreamTaskId: upstream.id,
    downstreamTaskId: downstream.id,
    need: '可测试构建包',
    providerId: 'local-user',
    consumerId: 'local-user',
    dueAt: Date.now() + 60_000,
    criteria: ['包含发布说明'],
  })
  expect(listTaskBlockers(project.id)[0]?.reason).toContain('尚未发起')
  expect(() => updateTask(downstream.id, { status: 'completed' })).toThrow('依赖交接')
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'offer_dependency_handoff',
    dependencyId: dependency.id,
    comment: 'build:42',
  })
  expect(listTaskBlockers(project.id)[0]?.reason).toContain('等待下游接收')
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'accept_dependency_handoff',
    dependencyId: dependency.id,
    comment: '已接收',
    completedCriteria: ['包含发布说明'],
  })
  expect(chain.dependencyHandoffs[0]!.status).toBe('accepted')
  expect(listTaskBlockers(project.id)).toEqual([])
})

test('低风险任务按预配置确定性验证器逐项自动验收并保留检查结果', () => {
  saveWorkflowIdentityDirectory({
    users: [{ id: 'local-user', displayName: '本地用户', enabled: true, roleIds: [] }],
    roles: [],
  })
  const project = createProject({ title: '自动验收', description: '' })
  const task = createTask(project.id, {
    title: '生成构建包',
    description: '',
    assignee: { userId: 'local-user', displayName: '本地用户' },
  })
  let chain = updateProjectChain(project.id, 0, {
    kind: 'decision',
    title: '构建范围',
    rationale: '固定输出',
    evidence: '需求单',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'set_project_dod',
    criteria: ['存在成果引用'],
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'set_task_dod',
    taskId: task.id,
    criteria: ['关联已完成执行'],
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'set_task_dod_auto_acceptance',
    taskId: task.id,
    enabled: true,
    riskLevel: 'low',
    rules: [
      { criterion: '存在成果引用', verifier: 'artifact_reference_present' },
      { criterion: '关联已完成执行', verifier: 'completed_execution' },
    ],
  } as ProjectChainCommand)
  createAgentExecution({
    id: 'run-auto',
    projectId: project.id,
    entityType: 'task',
    entityId: task.id,
    agentId: 'agent-a',
    sessionId: 'session-auto',
    prompt: '生成构建包',
  })
  updateAgentExecution('run-auto', {
    status: 'completed',
    completedAt: Date.now(),
    resultSummary: '完成',
  })
  chain = updateProjectChain(project.id, chain.revision, {
    kind: 'draft',
    taskId: task.id,
    title: '构建包',
    content: '构建说明',
    artifactRef: 'git:commit-42',
    executionId: 'run-auto',
    criteria: '按 DoD',
    recipient: '本地用户',
    responsibilities: { ownerId: 'local-user', reviewerId: 'local-user', recipientId: 'local-user' },
    decisionIds: [chain.decisions[0]!.id],
  })
  const draftId = chain.drafts[0]!.id
  chain = updateProjectChain(project.id, chain.revision, { kind: 'submit', draftId })
  expect(chain.drafts[0]!.status).toBe('accepted')
  expect(chain.drafts[0]!.acceptedCriteria).toEqual(['存在成果引用', '关联已完成执行'])
  expect(chain.drafts[0]!.dodCheckResults).toEqual([
    {
      criterion: '存在成果引用',
      status: 'passed',
      mode: 'automatic',
      verifier: 'artifact_reference_present',
      evidenceRef: 'git:commit-42',
      checkedBy: 'system:dod-verifier',
      checkedAt: expect.any(Number),
    },
    {
      criterion: '关联已完成执行',
      status: 'passed',
      mode: 'automatic',
      verifier: 'completed_execution',
      evidenceRef: 'run-auto',
      checkedBy: 'system:dod-verifier',
      checkedAt: expect.any(Number),
    },
  ])
  expect(chain.events.at(-1)?.action).toBe('auto_accept')
})
