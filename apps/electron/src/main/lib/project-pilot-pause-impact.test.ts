import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentExecution, createProject, closeProjectDb, getAgentExecution, initProjectDb, updateAgentExecution } from './project-sqlite-store'
import { getPilotPolicy, pausePilotPolicy, savePilotPolicyDraft } from './project-pilot-policy'
import { confirmPilotPauseImpact, previewPilotPauseImpact, validatePilotPauseChoices } from './project-pilot-pause-impact'
import { registerPilotCommandLink } from './project-pilot-command-links'
import { getPilotPauseDecision, recordPilotPauseDecision, recoverAllPilotPauseQueues, recoverPilotPauseQueue } from './project-pilot-pause-decision'
import { tryStartExecution } from './agent-employee-service'

const dir = mkdtempSync(join(tmpdir(), 'pilot-pause-impact-'))
const previous = process.env.PROMA_TEST_CONFIG_DIR
beforeAll(async () => { process.env.PROMA_TEST_CONFIG_DIR = dir; await initProjectDb() })
afterAll(() => {
  closeProjectDb()
  if (previous === undefined) delete process.env.PROMA_TEST_CONFIG_DIR
  else process.env.PROMA_TEST_CONFIG_DIR = previous
  rmSync(dir, { recursive: true, force: true })
})

function fixture(): { projectId: string; otherProjectId: string; policyRevision: number } {
  const project = createProject({ title: '暂停项目', description: '' })
  const other = createProject({ title: '其他项目', description: '' })
  const policy = savePilotPolicyDraft(project.id, {
    workspaceId: 'fixture-workspace', employeeIds: ['executor', 'reviewer'],
    executorEmployeeId: 'executor', reviewerEmployeeId: 'reviewer', channelId: 'fixture-channel',
    modelId: 'fixture-model', maxCostMicros: 1_000_000, maxRuns: 4, maxRework: 1,
    expiresAt: Date.now() + 100_000,
  }, null)
  const base = { projectId: project.id, entityType: 'task' as const, entityId: 'task-a', agentId: 'executor', sessionId: '', prompt: 'fixture' }
  createAgentExecution({ ...base, id: `queued-${project.id}`, pilotCommandId: `command-q-${project.id}` })
  createAgentExecution({ ...base, id: `running-a-${project.id}`, status: 'running', sessionId: 'session-a', pilotCommandId: `command-a-${project.id}` })
  createAgentExecution({ ...base, id: `running-b-${project.id}`, status: 'running', sessionId: 'session-b', pilotCommandId: `command-b-${project.id}` })
  for (const [commandId, executionId] of [
    [`command-q-${project.id}`, `queued-${project.id}`], [`command-a-${project.id}`, `running-a-${project.id}`],
    [`command-b-${project.id}`, `running-b-${project.id}`],
  ] as const) registerPilotCommandLink({ commandId, projectId: project.id, policyRevision: policy.revision, executionId })
  createAgentExecution({ ...base, id: `unlinked-${project.id}`, pilotCommandId: 'unlinked-command' })
  createAgentExecution({ ...base, id: `manual-${project.id}` })
  createAgentExecution({ ...base, id: `other-${other.id}`, projectId: other.id, pilotCommandId: 'other-command' })
  return { projectId: project.id, otherProjectId: other.id, policyRevision: policy.revision }
}

test('给定 Pilot 与普通执行混在同项目，预览只列有明确命令标记的排队和运行中项', () => {
  const { projectId, otherProjectId } = fixture()
  const impact = previewPilotPauseImpact(projectId)
  expect(impact.queued.map((item) => item.executionId)).toEqual([`queued-${projectId}`])
  expect(impact.running.map((item) => item.executionId)).toEqual([`running-a-${projectId}`, `running-b-${projectId}`])
  expect(impact.queued.some((item) => item.executionId === `manual-${projectId}`)).toBe(false)
  expect(impact.queued.some((item) => item.executionId === `unlinked-${projectId}`)).toBe(false)
  expect(impact.queued.some((item) => item.executionId === `other-${otherProjectId}`)).toBe(false)
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('queued')
})

test('给定两条运行中执行，确认必须逐项且只能选择有效处理方式', () => {
  const { projectId } = fixture()
  const impact = previewPilotPauseImpact(projectId)
  const [first, second] = impact.running
  expect(() => validatePilotPauseChoices(impact, impact, [
    { executionId: first!.executionId, disposition: 'finish_current' },
    { executionId: second!.executionId, disposition: 'request_stop' },
  ])).not.toThrow()
  expect(() => validatePilotPauseChoices(impact, impact, [{ executionId: first!.executionId, disposition: 'finish_current' }]))
    .toThrow('逐项选择')
  expect(() => validatePilotPauseChoices(impact, impact, [
    { executionId: first!.executionId, disposition: 'finish_current' },
    { executionId: first!.executionId, disposition: 'request_stop' },
  ])).toThrow('重复或无效')
  expect(getAgentExecution(first!.executionId)?.status).toBe('running')
})

test('确认前排队任务开始运行，旧预览失效且新运行项需要单独选择', () => {
  const { projectId } = fixture()
  const before = previewPilotPauseImpact(projectId)
  updateAgentExecution(`queued-${projectId}`, { status: 'running', sessionId: 'new-session' })
  const after = previewPilotPauseImpact(projectId)
  expect(after.running).toHaveLength(3)
  expect(() => validatePilotPauseChoices(before, after, [])).toThrow('影响面已变化')
})

test('策略版本变化后，旧影响面不能用于确认', () => {
  const { projectId, policyRevision } = fixture()
  const before = previewPilotPauseImpact(projectId)
  pausePilotPolicy(projectId, policyRevision)
  const after = previewPilotPauseImpact(projectId)
  expect(after.policyRevision).toBe(policyRevision + 1)
  expect(() => validatePilotPauseChoices(before, after, [])).toThrow('影响面已变化')
})


test('确认暂停后取消关联的排队 Pilot，普通排队执行和选择完成当前工作的运行项保持原状', () => {
  const { projectId, policyRevision } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  const result = confirmPilotPauseImpact(preview, preview.running.map((item) => ({
    executionId: item.executionId, disposition: 'finish_current',
  })))
  expect(result.state).toBe('paused')
  expect(result.policyRevision).toBe(policyRevision + 1)
  expect(result.cancelledExecutionIds).toEqual([`queued-${projectId}`])
  expect(result.stopRequestedExecutionIds).toEqual([])
  expect(result.latestImpact.queued).toEqual([])
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('cancelled')
  expect(getAgentExecution(`manual-${projectId}`)?.status).toBe('queued')
  expect(getAgentExecution(`unlinked-${projectId}`)?.status).toBe('queued')
  expect(getAgentExecution(`running-a-${projectId}`)?.status).toBe('running')
  expect(getPilotPolicy(projectId)?.state).toBe('paused')
})

test('确认前影响面变化时拒绝旧预览，不改变策略或排队执行', () => {
  const { projectId, policyRevision } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  updateAgentExecution(`queued-${projectId}`, { status: 'running', sessionId: 'started-later' })
  expect(() => confirmPilotPauseImpact(preview, preview.running.map((item) => ({
    executionId: item.executionId, disposition: 'finish_current',
  })))).toThrow('影响面已变化')
  expect(getPilotPolicy(projectId)?.revision).toBe(policyRevision)
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('running')
})

test('运行中逐项选择请求停止时，不能验证的停止结果会明确返回', () => {
  const { projectId } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  const [first, second] = preview.running
  const result = confirmPilotPauseImpact(preview, [
    { executionId: first!.executionId, disposition: 'request_stop' },
    { executionId: second!.executionId, disposition: 'finish_current' },
  ])
  expect(result.state).toBe('paused')
  expect(result.stoppedExecutionIds).toEqual([])
  expect(result.stopUnverifiedExecutionIds).toEqual([first!.executionId])
  expect(getAgentExecution(second!.executionId)?.status).toBe('running')
})


test('暂停草案下的 Pilot 队列不能从普通员工心跳启动，记录留待确认或恢复对账', async () => {
  const { projectId } = fixture()
  expect(await tryStartExecution(`queued-${projectId}`)).toBe(false)
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('queued')
  expect(getAgentExecution(`queued-${projectId}`)?.sessionId).toBe('')
})


test('确认记录先落盘；崩溃后仅在策略已暂停时恢复取消原排队项', async () => {
  const { projectId, policyRevision } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  const choices = preview.running.map((item) => ({ executionId: item.executionId, disposition: 'finish_current' as const }))
  recordPilotPauseDecision(preview, choices)
  expect(getPilotPauseDecision(projectId, policyRevision)?.fingerprint).toBe(preview.fingerprint)
  expect(recoverPilotPauseQueue(projectId, policyRevision).state).toBe('not_paused')
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('queued')
  pausePilotPolicy(projectId, policyRevision, preview.fingerprint)
  closeProjectDb()
  await initProjectDb()
  const recovered = recoverAllPilotPauseQueues().find((item) => item.projectId === projectId)?.result
  expect(recovered).toEqual({ state: 'queue_reconciled', cancelledExecutionIds: [`queued-${projectId}`] })
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('cancelled')
  expect(recoverPilotPauseQueue(projectId, policyRevision).cancelledExecutionIds).toEqual([])
})

test('暂停后原排队项已经启动时，恢复只报告需人工处理，不伪造取消', () => {
  const { projectId, policyRevision } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  recordPilotPauseDecision(preview, preview.running.map((item) => ({
    executionId: item.executionId, disposition: 'finish_current',
  })))
  pausePilotPolicy(projectId, policyRevision, preview.fingerprint)
  updateAgentExecution(`queued-${projectId}`, { status: 'running', sessionId: 'started-after-preview' })
  const recovered = recoverPilotPauseQueue(projectId, policyRevision)
  expect(recovered.state).toBe('needs_attention')
  expect(recovered.cancelledExecutionIds).toEqual([])
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('running')
})


test('相同版本的其他策略修改不能冒充本次确认暂停并触发恢复取消', () => {
  const { projectId, policyRevision } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  recordPilotPauseDecision(preview, preview.running.map((item) => ({
    executionId: item.executionId, disposition: 'finish_current',
  })))
  pausePilotPolicy(projectId, policyRevision)
  const recovered = recoverPilotPauseQueue(projectId, policyRevision)
  expect(recovered.state).toBe('needs_attention')
  expect(getAgentExecution(`queued-${projectId}`)?.status).toBe('queued')
})


test('同一策略版本的确认记录幂等，不能换掉已持久化的运行中选择', () => {
  const { projectId } = fixture()
  const preview = previewPilotPauseImpact(projectId)
  const choices = preview.running.map((item) => ({ executionId: item.executionId, disposition: 'finish_current' as const }))
  const first = recordPilotPauseDecision(preview, choices)
  expect(recordPilotPauseDecision(preview, choices)).toEqual(first)
  expect(() => recordPilotPauseDecision(preview, [
    { executionId: choices[0]!.executionId, disposition: 'request_stop' }, choices[1]!,
  ])).toThrow('不同的暂停确认')
  expect(getPilotPauseDecision(projectId, preview.policyRevision)?.runningChoices).toEqual(choices)
})
