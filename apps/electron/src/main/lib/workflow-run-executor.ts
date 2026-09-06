/** Workflow Run 的串行调度器：只自动执行已就绪、可恢复且没有并发歧义的节点。 */

import type { WorkflowRun } from '@gravitas/shared'
import { resolveWorkflowNodeInput } from '@gravitas/shared/workflow'
import { executeWorkflowAgentNode } from './workflow-agent-executor'
import { executeWorkflowDeterministicNode } from './workflow-deterministic-executor'
import { completeWorkflowNode, createWorkflowRun, failWorkflowNode, getWorkflowDefinition, getWorkflowRun, revalidateWorkflowRunForResume, requestWorkflowApproval, startWorkflowNode } from './workflow-service'

function executeSubworkflowNode(parent: WorkflowRun, workflowId: string, runId: string, nodeId: string, channelId: string, modelId?: string): Promise<WorkflowRun> {
  const node = parent.snapshot.definition.nodes.find((item) => item.id === nodeId)
  const config = node?.config as { workflowId?: unknown; version?: unknown; inputMapping?: unknown } | undefined
  const childId = typeof config?.workflowId === 'string' ? config.workflowId : ''
  const child = childId ? getWorkflowDefinition(childId) : null
  const invalid = !child
    || child.workspaceId !== parent.workspaceId
    || child.status !== 'published'
    || child.publication?.version !== config?.version
    || child.nodes.some((item) => !['start', 'end', 'transform', 'condition', 'foreach'].includes(item.kind))
  if (invalid) {
    startWorkflowNode(workflowId, runId, nodeId)
    return Promise.resolve(failWorkflowNode(workflowId, runId, nodeId, { code: 'subworkflow_not_permitted', message: '子流程必须是同工作区、精确发布版本且仅含确定性节点', category: 'policy_denied', retryable: false }))
  }
  const mapping = config?.inputMapping
  const input = resolveWorkflowNodeInput(mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? mapping as Record<string, unknown> : undefined, {
    input: parent.input,
    nodes: Object.fromEntries(Object.entries(parent.nodeRuns).map(([id, item]) => [id, { output: item.output, status: item.status }])),
  })
  startWorkflowNode(workflowId, runId, nodeId)
  const childRun = createWorkflowRun(child.id, input)
  return executeWorkflowRun(child.id, childRun.id, channelId, modelId).then((finished) => {
    if (finished.status !== 'completed') return failWorkflowNode(workflowId, runId, nodeId, { code: 'subworkflow_incomplete', message: `子流程未完成：${finished.status}`, category: 'permanent', retryable: false })
    const endNode = finished.snapshot.definition.nodes.find((item) => item.kind === 'end')
    return completeWorkflowNode(workflowId, runId, nodeId, { childRunId: childRun.id, ...(endNode ? { childOutput: finished.nodeRuns[endNode.id]?.output ?? {} } : {}) })
  })
}

/**
 * 推进一次 Run，直至没有 ready 节点或遇到审批。并发分支按 Definition 节点顺序串行，
 * 使本地审计顺序可复现；后续企业调度器可在保持节点状态机不变的前提下并行化。
 */
export async function executeWorkflowRun(workflowId: string, runId: string, channelId: string, modelId?: string): Promise<WorkflowRun> {
  let run = revalidateWorkflowRunForResume(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  if (run.status !== 'running') return run

  while (run.status === 'running') {
    const nextNode = run.snapshot.definition.nodes.find((node) => run!.nodeRuns[node.id]?.status === 'ready')
    if (!nextNode) return run
    switch (nextNode.kind) {
      case 'transform':
      case 'condition':
      case 'foreach':
        run = executeWorkflowDeterministicNode(workflowId, runId, nextNode.id)
        break
      case 'approval':
        return requestWorkflowApproval(workflowId, runId, nextNode.id)
      case 'agent':
      case 'skill':
      case 'tool':
        run = await executeWorkflowAgentNode(workflowId, runId, nextNode.id, channelId, modelId)
        break
      case 'subworkflow':
        run = await executeSubworkflowNode(run, workflowId, runId, nextNode.id, channelId, modelId)
        break
      case 'end':
        startWorkflowNode(workflowId, runId, nextNode.id)
        run = completeWorkflowNode(workflowId, runId, nextNode.id)
        break
      case 'start':
        throw new Error('start 节点不能再次执行')
    }
    if (run.status !== 'running') return run
  }
  return run
}
