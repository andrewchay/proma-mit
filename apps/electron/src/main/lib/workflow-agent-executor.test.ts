import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKFLOW_FORMAT, type AgentSendInput, type WorkflowDefinition } from '@proma/shared'
import { createAgentWorkspace, saveWorkspaceMcpConfig } from './agent-workspace-manager'
import { getWorkspaceSkillsDir } from './config-paths'
import { executeWorkflowAgentNode, getActiveWorkflowAgentSession, type WorkflowAgentRunner } from './workflow-agent-executor'
import { createWorkflowRun, publishWorkflowDefinition, saveWorkflowDefinition } from './workflow-service'

const TEST_DIR = '/tmp/paa-workflow-agent-executor-test'

function setupWorkflow(): WorkflowDefinition {
  const workspace = createAgentWorkspace('执行器工作区')
  const skillDir = join(getWorkspaceSkillsDir(workspace.slug), 'project-review')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: 项目复盘\nversion: 1.0.0\n---\n', 'utf-8')
  saveWorkspaceMcpConfig(workspace.slug, { servers: { nocobase: { type: 'http', url: 'https://example.com/mcp', enabled: true } } })
  const now = Date.now()
  const definition: WorkflowDefinition = {
    format: WORKFLOW_FORMAT,
    formatVersion: '1.0',
    id: 'risk-agent',
    workspaceId: workspace.id,
    name: '风险收集',
    status: 'draft',
    version: '0.1.0',
    trigger: { kind: 'manual' },
    nodes: [
      { id: 'start', kind: 'start', title: '开始' },
      {
        id: 'collect', kind: 'agent', title: '收集风险', config: { prompt: '收集风险' },
        capabilityPolicy: { skills: [{ slug: 'project-review', version: '1.0.0' }], mcpServers: [{ name: 'nocobase' }], allowedTools: ['Read'] },
      },
      { id: 'end', kind: 'end', title: '结束' },
    ],
    edges: [{ id: 'a', from: 'start', to: 'collect' }, { id: 'b', from: 'collect', to: 'end' }],
    layout: { nodes: { start: { x: 0, y: 0 }, collect: { x: 100, y: 0 }, end: { x: 200, y: 0 } } },
    createdAt: now,
    updatedAt: now,
  }
  saveWorkflowDefinition(definition)
  return publishWorkflowDefinition(definition.id, { version: '1.0.0' })
}

describe('Workflow Agent 节点执行器', () => {
  beforeAll(() => { process.env.PROMA_TEST_CONFIG_DIR = TEST_DIR })
  beforeEach(() => { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }) })
  afterAll(() => { rmSync(TEST_DIR, { recursive: true, force: true }); delete process.env.PROMA_TEST_CONFIG_DIR })

  test('Given 就绪 Agent 节点 When 执行 Then 传递最小能力策略并推进后继节点', async () => {
    const definition = setupWorkflow()
    const run = createWorkflowRun(definition.id, { projectId: 'p-1' })
    let capturedInput: AgentSendInput | undefined
    const runner: WorkflowAgentRunner = {
      async run(input, callbacks) {
        capturedInput = input
        callbacks.onComplete()
      },
    }

    const result = await executeWorkflowAgentNode(definition.id, run.id, 'collect', 'channel-1', undefined, {
      runner,
      sessionFactory: { create: () => ({ id: 'agent-session-1' }) },
    })

    expect(capturedInput?.workflowCapabilityPolicy?.mcpServers).toEqual([{ name: 'nocobase' }])
    expect(capturedInput?.workflowCapabilityPolicy?.skills).toEqual([{ slug: 'project-review', version: '1.0.0' }])
    expect(capturedInput?.userMessage).toContain('"projectId":"p-1"')
    expect(result.nodeRuns?.collect?.status).toBe('completed')
    expect(result.nodeRuns?.end?.status).toBe('ready')
    expect(result.nodeRuns?.collect?.output).toEqual({ agentSessionId: 'agent-session-1' })
  })

  test('Given Agent 返回错误 When 执行 Then 记录可重试失败而非静默完成', async () => {
    const definition = setupWorkflow()
    const run = createWorkflowRun(definition.id, {})
    const runner: WorkflowAgentRunner = {
      async run(_input, callbacks) { callbacks.onError('模型不可用') },
    }

    const result = await executeWorkflowAgentNode(definition.id, run.id, 'collect', 'channel-1', undefined, {
      runner,
      sessionFactory: { create: () => ({ id: 'agent-session-2' }) },
    })

    expect(result.status).toBe('failed')
    expect(result.nodeRuns?.collect?.error).toEqual({ code: 'agent_execution_failed', message: '模型不可用', retryable: true })
  })

  test('Given 已授权 Tool 节点 When 受控 MCP 执行 Then 收到稳定幂等键且只获得声明工具', async () => {
    const published = setupWorkflow()
    saveWorkflowDefinition({
      ...published,
      nodes: published.nodes.map((node) => node.id === 'collect'
        ? { ...node, kind: 'tool', config: { toolName: 'mcp__nocobase__create_task' }, capabilityPolicy: { allowedTools: ['mcp__nocobase__create_task'], mcpServers: [{ name: 'nocobase' }] } }
        : node),
    })
    const run = createWorkflowRun(published.id, { title: '受控任务' })
    let idempotencyKey = ''
    let allowedTools: string[] | undefined
    const result = await executeWorkflowAgentNode(published.id, run.id, 'collect', 'channel-1', undefined, {
      runner: { async run(input, callbacks) {
        idempotencyKey = input.userMessage.match(/<workflow_idempotency_key>\n([^\n]+)/)?.[1] ?? ''
        allowedTools = input.workflowCapabilityPolicy?.allowedTools
        callbacks.onComplete([{ id: 'mcp-result', role: 'assistant', content: '{"created":true}', createdAt: 1 }])
      } },
      sessionFactory: { create: () => ({ id: 'mcp-session-1' }) },
    })
    expect(idempotencyKey).toBe(`${published.id}:${run.id}:collect`)
    expect(allowedTools).toEqual(['mcp__nocobase__create_task'])
    expect(result.nodeRuns?.collect?.sideEffect?.status).toBe('confirmed')
  })

  test('Given outputSchema When Agent returns matching JSON Then it persists structured result', async () => {
    const published = setupWorkflow()
    saveWorkflowDefinition({
      ...published,
      nodes: published.nodes.map((node) => node.id === 'collect'
        ? { ...node, config: { prompt: '收集风险', outputSchema: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } } } }
        : node),
    })
    const run = createWorkflowRun(published.id, {})
    const result = await executeWorkflowAgentNode(published.id, run.id, 'collect', 'channel-1', undefined, {
      runner: { async run(_input, callbacks) { callbacks.onComplete([{ id: 'message-1', role: 'assistant', content: '{"count":2}', createdAt: 1 }]) } },
      sessionFactory: { create: () => ({ id: 'agent-session-3' }) },
    })
    expect(result.nodeRuns?.collect?.output).toEqual({ agentSessionId: 'agent-session-3', result: { count: 2 } })
  })

  test('Given outputSchema When Agent returns incompatible text Then it records retryable contract failure', async () => {
    const published = setupWorkflow()
    saveWorkflowDefinition({
      ...published,
      nodes: published.nodes.map((node) => node.id === 'collect'
        ? { ...node, config: { prompt: '收集风险', outputSchema: { type: 'object', required: ['count'] } } }
        : node),
    })
    const run = createWorkflowRun(published.id, {})
    const result = await executeWorkflowAgentNode(published.id, run.id, 'collect', 'channel-1', undefined, {
      runner: { async run(_input, callbacks) { callbacks.onComplete([{ id: 'message-2', role: 'assistant', content: '不是 JSON', createdAt: 1 }]) } },
      sessionFactory: { create: () => ({ id: 'agent-session-4' }) },
    })
    expect(result.nodeRuns?.collect?.error?.code).toBe('output_schema_invalid')
    expect(result.nodeRuns?.collect?.error?.retryable).toBe(true)
  })

  test('getActiveWorkflowAgentSession 在执行 agent 节点期间可查询，结束后清理', async () => {
    const published = setupWorkflow()
    const run = createWorkflowRun(published.id, {})
    let releaseRun: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { releaseRun = resolve })
    let seenDuringRun: unknown = 'not-called'
    const execution = executeWorkflowAgentNode(published.id, run.id, 'collect', 'channel-1', undefined, {
      runner: {
        async run(_input, callbacks) {
          // 执行期间应注册活跃会话
          seenDuringRun = getActiveWorkflowAgentSession(run.id)
          await gate
          callbacks.onComplete([{ id: 'message-3', role: 'assistant', content: 'ok', createdAt: 1 }])
        },
      },
      sessionFactory: { create: () => ({ id: 'agent-session-stop-1' }) },
    })
    // 等待 runner 已进入执行（注册已生效）
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seenDuringRun).toEqual({ workflowId: published.id, sessionId: 'agent-session-stop-1' })
    expect(getActiveWorkflowAgentSession(run.id)).toEqual({ workflowId: published.id, sessionId: 'agent-session-stop-1' })
    releaseRun?.()
    await execution
    // 结束后清理
    expect(getActiveWorkflowAgentSession(run.id)).toBeUndefined()
  })
})
