/** Workflow Agent/Skill 节点执行适配器。 */

import type { AgentExternalRunSource, AgentMessage, AgentSendInput, WorkflowCapabilityPolicy, WorkflowRun } from '@proma/shared'
import { validateWorkflowOutput } from '@proma/shared/workflow'
import {
  completeWorkflowNode,
  acquireWorkflowSideEffectLease,
  failWorkflowNode,
  getWorkflowRun,
  startWorkflowNode,
  requireWorkflowSideEffectIntervention,
  cancelWorkflowRun,
} from './workflow-service'

/**
 * 活跃 Workflow Agent 会话注册表：runId → agent sessionId。
 * 在 agent 节点执行期间注册，执行结束（成功/失败/异常）后清理。
 * 用于「停止运行中的 Workflow」——主进程可以据此中止正在执行的 agent 会话。
 */
const activeAgentSessions = new Map<string, { workflowId: string; sessionId: string }>()

/** 查询某个 Run 当前是否正在执行 agent 节点；是则返回其 agent sessionId。 */
export function getActiveWorkflowAgentSession(runId: string): { workflowId: string; sessionId: string } | undefined {
  return activeAgentSessions.get(runId)
}

/**
 * 停止正在运行的 Workflow Run：中止当前 agent 会话并把 Run 状态置为 cancelled。
 * 返回是否成功；Run 不在运行/没有活跃 agent 时返回 false。
 */
export async function stopActiveWorkflowRun(workflowId: string, runId: string): Promise<{ stopped: boolean; message?: string }> {
  const active = activeAgentSessions.get(runId)
  if (active) {
    try {
      // 中止底层 agent 执行（与手动停止 Agent 同一路径）
      const { stopAgent } = await import('./agent-service')
      stopAgent(active.sessionId)
    } catch (error) {
      console.error('[Workflow] 停止 agent 会话失败:', error)
    }
  }

  // 更新 Run 状态为 cancelled（幂等：已完成/已取消的 Run 会抛错，这里吞掉）
  try {
    const cancelled = cancelWorkflowRun(workflowId, runId)
    return { stopped: true, message: `Run 已停止（${cancelled.status}）` }
  } catch (error) {
    const message = error instanceof Error ? error.message : '停止失败'
    // Run 可能已完成或已取消——如果还有活跃 agent，说明状态文件与执行不一致，
    // 此时 agent 已被 stopAgent 中止，视为已停止。
    if (active) return { stopped: true, message: `agent 已中止（${message}）` }
    return { stopped: false, message }
  }
}

interface WorkflowAgentCallbacks {
  onError: (error: string) => void
  onComplete: (messages?: AgentMessage[]) => void
  onTitleUpdated: (title: string) => void
  source?: AgentExternalRunSource
}

export interface WorkflowAgentRunner {
  run(input: AgentSendInput, callbacks: WorkflowAgentCallbacks): Promise<void>
}

export interface WorkflowAgentSessionFactory {
  create(title: string, channelId: string, workspaceId: string): { id: string } | Promise<{ id: string }>
}

/** Electron 运行时依赖延迟加载，使状态机测试无需加载 Electron 原生模块。 */
const defaultRunner: WorkflowAgentRunner = {
  async run(input, callbacks) {
    const { runAgentHeadless } = await import('./agent-service')
    return runAgentHeadless(input, callbacks)
  },
}

const defaultSessionFactory: WorkflowAgentSessionFactory = {
  async create(title, channelId, workspaceId) {
    const { createAgentSession } = await import('./agent-session-manager')
    return createAgentSession(title, channelId, workspaceId)
  },
}

function getNodePrompt(run: WorkflowRun, nodeId: string, idempotencyKey?: string): string {
  const node = run.snapshot.definition.nodes.find((item) => item.id === nodeId)
  if (!node || (node.kind !== 'agent' && node.kind !== 'skill' && node.kind !== 'tool')) {
    throw new Error('当前节点不是可执行的 Agent/Skill/Tool 节点')
  }
  const config = node.config as { prompt?: unknown; toolName?: unknown; inputMapping?: unknown; outputSchema?: unknown }
  const outputInstruction = config.outputSchema && typeof config.outputSchema === 'object' && !Array.isArray(config.outputSchema)
    ? `\n\n<workflow_output_contract>\n完成后只返回符合以下 JSON Schema 的 JSON，不要使用 Markdown 代码块：${JSON.stringify(config.outputSchema)}\n</workflow_output_contract>`
    : ''
  if (node.kind === 'tool') {
    if (typeof config?.toolName !== 'string' || !config.toolName.trim()) throw new Error('Workflow tool 节点缺少 toolName')
    return `执行当前 Workflow 工具节点。只允许调用工具 ${config.toolName}，使用 workflow_input 与 inputMapping 构造参数；完成后简要说明结果。若工具支持幂等键，必须传入 workflow_idempotency_key，禁止自行生成新键。\n\n<workflow_idempotency_key>\n${idempotencyKey ?? ''}\n</workflow_idempotency_key>\n<workflow_input>\n${JSON.stringify(run.input)}\n</workflow_input>\n<workflow_input_mapping>\n${JSON.stringify(config.inputMapping ?? {})}\n</workflow_input_mapping>${outputInstruction}`
  }
  if (typeof config?.prompt !== 'string' || !config.prompt.trim()) {
    throw new Error('Workflow 节点缺少 prompt')
  }
  return `${config.prompt}\n\n<workflow_input>\n${JSON.stringify(run.input)}\n</workflow_input>${outputInstruction}`
}

function getNodeCapabilityPolicy(run: WorkflowRun, nodeId: string): WorkflowCapabilityPolicy {
  return run.snapshot.nodeCapabilityPolicies[nodeId] ?? {}
}

function extractResult(messages: AgentMessage[]): unknown {
  const text = [...messages].reverse().find((message) => message.role === 'assistant')?.content?.trim()
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return text }
}

function getOutputSchema(run: WorkflowRun, nodeId: string): Record<string, unknown> | undefined {
  const node = run.snapshot.definition.nodes.find((item) => item.id === nodeId)
  const schema = (node?.config as { outputSchema?: unknown } | undefined)?.outputSchema
  return schema && typeof schema === 'object' && !Array.isArray(schema) ? schema as Record<string, unknown> : undefined
}

/**
 * 执行一个已就绪的 Agent/Skill/Tool 节点。
 *
 * 运行完成只保存 Agent session 引用；结构化产物会在下一阶段通过 outputSchema 校验后写入。
 */
export async function executeWorkflowAgentNode(
  workflowId: string,
  runId: string,
  nodeId: string,
  channelId: string,
  modelId?: string,
  dependencies: {
    runner?: WorkflowAgentRunner
    sessionFactory?: WorkflowAgentSessionFactory
  } = {},
): Promise<WorkflowRun> {
  const initial = getWorkflowRun(workflowId, runId)
  if (!initial) throw new Error(`Workflow Run 不存在: ${runId}`)
  const node = initial.snapshot.definition.nodes.find((item) => item.id === nodeId)
  const leased = node?.kind === 'tool' ? acquireWorkflowSideEffectLease(workflowId, runId, nodeId) : undefined
  const prompt = getNodePrompt(initial, nodeId, leased?.nodeRuns[nodeId]?.sideEffect?.idempotencyKey)
  const policy = getNodeCapabilityPolicy(initial, nodeId)
  const runner = dependencies.runner ?? defaultRunner
  const sessionFactory = dependencies.sessionFactory ?? defaultSessionFactory
  const session = await sessionFactory.create(`Workflow: ${initial.snapshot.definition.name}`, channelId, initial.workspaceId)

  if (!leased) startWorkflowNode(workflowId, runId, nodeId)
  let error: string | undefined
  let messages: AgentMessage[] = []
  // 注册当前 agent 会话，供「停止运行中的 Workflow」中止执行
  activeAgentSessions.set(runId, { workflowId, sessionId: session.id })
  try {
    await runner.run({
      sessionId: session.id,
      userMessage: prompt,
      channelId,
      ...(modelId && { modelId }),
      workspaceId: initial.workspaceId,
      permissionModeOverride: 'auto',
      workflowCapabilityPolicy: policy,
    }, {
      onError: (message) => { error = message },
      onComplete: (completedMessages) => { messages = completedMessages ?? [] },
      onTitleUpdated: () => {},
      source: 'workflow',
    })
  } finally {
    activeAgentSessions.delete(runId)
  }

  if (error) {
    if (node?.kind === 'tool') return requireWorkflowSideEffectIntervention(workflowId, runId, nodeId, `工具执行返回错误，无法确认远端是否已生效：${error}`)
    return failWorkflowNode(workflowId, runId, nodeId, { code: 'agent_execution_failed', message: error, retryable: true })
  }
  const result = extractResult(messages)
  const outputSchema = getOutputSchema(initial, nodeId)
  if (outputSchema) {
    const validation = validateWorkflowOutput(result, outputSchema)
    if (!validation.valid) {
      if (node?.kind === 'tool') return requireWorkflowSideEffectIntervention(workflowId, runId, nodeId, `工具已返回但输出校验失败，远端结果需要人工确认：${validation.errors.join('; ')}`)
      return failWorkflowNode(workflowId, runId, nodeId, { code: 'output_schema_invalid', message: validation.errors.join('; '), retryable: true })
    }
  }
  return completeWorkflowNode(workflowId, runId, nodeId, {
    agentSessionId: session.id,
    ...(result !== undefined ? { result } : {}),
  })
}
