import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { WORKFLOW_FORMAT, type WorkflowDefinition } from '@proma/shared'
import {
  cancelWorkflowRun,
  completeWorkflowNode,
  createWorkflowRun,
  deleteWorkflowDefinition,
  failWorkflowNode,
  getWorkflowRun,
  listRecoverableWorkflowRuns,
  listWorkflowRunEvents,
  publishWorkflowDefinition,
  requestWorkflowApproval,
  resolveWorkflowApproval,
  retryWorkflowNode,
  saveWorkflowDefinition,
  exportWorkflowDefinition,
  importWorkflowDefinition,
  startWorkflowNode,
  acquireWorkflowSideEffectLease,
  requireWorkflowSideEffectIntervention,
  resolveWorkflowSideEffect,
} from './workflow-service'
import { createAgentWorkspace, saveWorkspaceMcpConfig } from './agent-workspace-manager'
import { getWorkspaceSkillsDir } from './config-paths'

const TEST_DIR = '/tmp/paa-workflow-service-test'

function createWorkflowDraft(workspaceId: string): WorkflowDefinition {
  const now = Date.now()
  return {
    format: WORKFLOW_FORMAT,
    formatVersion: '1.0',
    id: 'project-risk-review',
    workspaceId,
    name: '项目风险周报',
    status: 'draft',
    version: '0.1.0',
    trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      {
        id: 'collect',
        kind: 'agent',
        title: '收集风险',
        config: { prompt: '收集项目风险' },
        capabilityPolicy: { allowedTools: ['Read'], skills: [{ slug: 'project-review', version: '1.0.0' }] },
        retry: { maxAttempts: 2, backoff: 'fixed' },
      },
      { id: 'approval', kind: 'approval', title: '负责人确认', config: { assigneePolicy: 'workflow_owner', onTimeout: 'fail' } },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [
      { id: 'start-collect', from: 'start', to: 'collect' },
      { id: 'collect-approval', from: 'collect', to: 'approval' },
      { id: 'approval-end', from: 'approval', to: 'end' },
    ],
    layout: { nodes: { start: { x: 0, y: 0 }, collect: { x: 160, y: 0 }, approval: { x: 320, y: 0 }, end: { x: 480, y: 0 } } },
    createdAt: now,
    updatedAt: now,
  }
}

function saveAndPublishWorkflow(): WorkflowDefinition {
  const workspace = createAgentWorkspace('产品工作区')
  const skillsDir = join(getWorkspaceSkillsDir(workspace.slug), 'project-review')
  mkdirSync(skillsDir, { recursive: true })
  writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: 项目复盘\nversion: 1.0.0\n---\n', 'utf-8')
  saveWorkspaceMcpConfig(workspace.slug, {
    servers: { nocobase: { type: 'http', url: 'https://example.com/mcp', enabled: true } },
  })
  const draft = createWorkflowDraft(workspace.id)
  saveWorkflowDefinition(draft)
  return publishWorkflowDefinition(draft.id, { version: '1.0.0' })
}

describe('Workflow Run 服务', () => {
  beforeAll(() => {
    process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
    delete process.env.PROMA_TEST_CONFIG_DIR
  })

  test('用户可将流程导出后导入目标工作区，导入副本不会继承发布状态', () => {
    const source = saveAndPublishWorkflow()
    const target = createAgentWorkspace('目标工作区')
    const file = exportWorkflowDefinition(source.id)
    const imported = importWorkflowDefinition({ file, workspaceId: target.id, workflowId: 'imported-risk-review' })
    expect(imported.workspaceId).toBe(target.id)
    expect(imported.status).toBe('draft')
    expect(imported.publication).toBeUndefined()
    expect(() => importWorkflowDefinition({ file, workspaceId: target.id, workflowId: imported.id })).toThrow('Workflow 已存在')
  })

  test('Given Tool 节点执行中断 When 进入人工处置 Then 只能显式确认或批准重试，且幂等键保持稳定', () => {
    const source = saveAndPublishWorkflow()
    const toolDefinition: WorkflowDefinition = {
      ...source,
      nodes: source.nodes.map((node) => node.id === 'collect'
        ? { ...node, kind: 'tool', config: { toolName: 'Read' }, capabilityPolicy: { allowedTools: ['Read'] } }
        : node),
    }
    saveWorkflowDefinition(toolDefinition)
    const run = createWorkflowRun(toolDefinition.id, {})
    const leased = acquireWorkflowSideEffectLease(toolDefinition.id, run.id, 'collect')
    const key = leased.nodeRuns?.collect!.sideEffect!.idempotencyKey
    const blocked = requireWorkflowSideEffectIntervention(toolDefinition.id, run.id, 'collect', '进程中断')
    expect(blocked.status).toBe('blocked')
    const retried = resolveWorkflowSideEffect(toolDefinition.id, run.id, 'collect', 'retry')
    expect(retried.nodeRuns?.collect!.status).toBe('ready')
    expect(retried.nodeRuns?.collect!.sideEffect!.idempotencyKey).toBe(key)
  })

  test('Given 已发布 Definition When 创建 Run Then 冻结版本并让首个执行节点就绪', () => {
    saveAndPublishWorkflow()

    const run = createWorkflowRun('project-risk-review', { projectId: 'p-1' })

    expect(run.snapshot.definitionVersion).toBe('1.0.0')
    expect(run.nodeRuns?.start?.status).toBe('completed')
    expect(run.nodeRuns?.collect?.status).toBe('ready')
    expect(run.snapshot.capabilityPolicy.allowedTools).toEqual(['Read'])
    expect(run.snapshot.nodeCapabilityPolicies.collect?.skills).toEqual([{ slug: 'project-review', version: '1.0.0' }])
    expect(listWorkflowRunEvents('project-risk-review', run.id).map((event) => event.type)).toEqual(['run_created', 'node_ready'])
  })

  test('Given 就绪节点 When 执行、审批通过并完成结束节点 Then Run 完成且保留审批证据', () => {
    saveAndPublishWorkflow()
    const run = createWorkflowRun('project-risk-review', {})

    startWorkflowNode('project-risk-review', run.id, 'collect')
    const afterCollect = completeWorkflowNode('project-risk-review', run.id, 'collect', { riskCount: 2 })
    expect(afterCollect.nodeRuns?.approval?.status).toBe('ready')

    const waiting = requestWorkflowApproval('project-risk-review', run.id, 'approval')
    expect(waiting.status).toBe('waiting_approval')
    expect(waiting.approvals[0]?.assigneeIds).toEqual(['local-user'])
    expect(() => resolveWorkflowApproval('project-risk-review', run.id, waiting.approvals[0]!.id, { approved: true, resolvedBy: 'unassigned-user' })).toThrow('冻结审批人列表')
    const approved = resolveWorkflowApproval('project-risk-review', run.id, waiting.approvals[0]!.id, { approved: true, resolvedBy: 'local-user', comment: '确认' })
    expect(approved.nodeRuns?.end?.status).toBe('ready')

    startWorkflowNode('project-risk-review', run.id, 'end')
    const completed = completeWorkflowNode('project-risk-review', run.id, 'end')
    expect(completed.status).toBe('completed')
    expect(completed.approvals[0]?.status).toBe('approved')
  })

  test('Given 可重试 Agent 节点 When 发生可重试错误 Then 可创建下一次尝试', () => {
    saveAndPublishWorkflow()
    const run = createWorkflowRun('project-risk-review', {})

    startWorkflowNode('project-risk-review', run.id, 'collect')
    const failed = failWorkflowNode('project-risk-review', run.id, 'collect', { code: 'timeout', message: '超时', retryable: true })
    expect(failed.status).toBe('failed')

    const retried = retryWorkflowNode('project-risk-review', run.id, 'collect')
    expect(retried.status).toBe('running')
    expect(retried.nodeRuns?.collect?.status).toBe('ready')
    expect(retried.nodeRuns?.collect?.attempt).toBe(1)
  })

  test('Given onFailure=continue When 节点失败 Then 保留错误并推进正常后继节点', () => {
    const published = saveAndPublishWorkflow()
    saveWorkflowDefinition({
      ...published,
      nodes: published.nodes.map((node) => node.id === 'collect' ? { ...node, onFailure: 'continue' as const } : node),
    })
    const run = createWorkflowRun('project-risk-review', {})
    startWorkflowNode('project-risk-review', run.id, 'collect')
    const recovered = failWorkflowNode('project-risk-review', run.id, 'collect', { code: 'temporary', message: '暂时失败', retryable: true })
    expect(recovered.status).toBe('running')
    expect(recovered.nodeRuns?.collect?.status).toBe('completed')
    expect(recovered.nodeRuns?.collect?.error?.code).toBe('temporary')
    expect(recovered.nodeRuns?.approval?.status).toBe('ready')
  })

  test('Given onFailure=route_to_error When 节点失败 Then 仅推进 error 分支并跳过常规分支', () => {
    const published = saveAndPublishWorkflow()
    saveWorkflowDefinition({
      ...published,
      nodes: published.nodes.map((node) => node.id === 'collect' ? { ...node, onFailure: 'route_to_error' as const } : node),
      edges: [...published.edges, { id: 'collect-error-end', from: 'collect', to: 'end', label: 'error' }],
    })
    const run = createWorkflowRun('project-risk-review', {})
    startWorkflowNode('project-risk-review', run.id, 'collect')
    const recovered = failWorkflowNode('project-risk-review', run.id, 'collect', { code: 'temporary', message: '暂时失败', retryable: false })
    expect(recovered.nodeRuns?.approval?.status).toBe('skipped')
    expect(recovered.nodeRuns?.end?.status).toBe('ready')
  })

  test('Given 等待审批的 Run When 重启恢复查询或取消 Then 不会自动重放且可安全取消', () => {
    saveAndPublishWorkflow()
    const run = createWorkflowRun('project-risk-review', {})
    startWorkflowNode('project-risk-review', run.id, 'collect')
    completeWorkflowNode('project-risk-review', run.id, 'collect')
    requestWorkflowApproval('project-risk-review', run.id, 'approval')

    expect(listRecoverableWorkflowRuns().map((item) => item.id)).toContain(run.id)
    const cancelled = cancelWorkflowRun('project-risk-review', run.id)
    expect(cancelled.status).toBe('cancelled')
    expect(getWorkflowRun('project-risk-review', run.id)?.nodeRuns?.approval?.status).toBe('cancelled')
    expect(existsSync(`${TEST_DIR}/workflows/project-risk-review/runs/${run.id}.jsonl`)).toBe(true)
  })

  test('Given 非法工作流 ID When 读取 Run Then 拒绝路径穿越', () => {
    expect(() => getWorkflowRun('../outside', 'run-1')).toThrow('Workflow ID 非法')
  })

  test('删除 Workflow：取消进行中的 Run 后可以删除定义与 Run 文件', () => {
    saveAndPublishWorkflow()
    const run = createWorkflowRun('project-risk-review', {})
    startWorkflowNode('project-risk-review', run.id, 'collect')
    expect(existsSync(`${TEST_DIR}/workflows/project-risk-review`)).toBe(true)

    // 有进行中的 Run：删除被拦截
    const blocked = deleteWorkflowDefinition('project-risk-review')
    expect(blocked.deleted).toBe(false)
    expect(blocked.reason).toContain('进行中')

    // 取消 Run 后：可以删除
    cancelWorkflowRun('project-risk-review', run.id)
    const result = deleteWorkflowDefinition('project-risk-review')
    expect(result.deleted).toBe(true)
    expect(existsSync(`${TEST_DIR}/workflows/project-risk-review`)).toBe(false)
    expect(deleteWorkflowDefinition('project-risk-review').deleted).toBe(false)
  })

  test('删除 Workflow：存在进行中的 Run 时拒绝删除', () => {
    saveAndPublishWorkflow()
    const run = createWorkflowRun('project-risk-review', {})
    startWorkflowNode('project-risk-review', run.id, 'collect')
    completeWorkflowNode('project-risk-review', run.id, 'collect')
    // 使 Run 进入 waiting_approval（未完成）状态
    requestWorkflowApproval('project-risk-review', run.id, 'approval')

    const result = deleteWorkflowDefinition('project-risk-review')

    expect(result.deleted).toBe(false)
    expect(result.reason).toContain('进行中')
    expect(existsSync(`${TEST_DIR}/workflows/project-risk-review`)).toBe(true)
  })
})
