/** Workflow Run 的串行调度器：只自动执行已就绪、可恢复且没有并发歧义的节点。 */

import type { WorkflowRun } from '@gravitas/shared'
import { executeWorkflowAgentNode } from './workflow-agent-executor'
import { executeWorkflowDeterministicNode } from './workflow-deterministic-executor'
import { completeWorkflowNode, getWorkflowRun, requestWorkflowApproval, startWorkflowNode } from './workflow-service'

/**
 * 推进一次 Run，直至没有 ready 节点或遇到审批。并发分支按 Definition 节点顺序串行，
 * 使本地审计顺序可复现；后续企业调度器可在保持节点状态机不变的前提下并行化。
 */
export async function executeWorkflowRun(workflowId: string, runId: string, channelId: string, modelId?: string): Promise<WorkflowRun> {
  let run = getWorkflowRun(workflowId, runId)
  if (!run) throw new Error(`Workflow Run 不存在: ${runId}`)
  if (run.status !== 'running') return run

  while (run.status === 'running') {
    const nextNode = run.snapshot.definition.nodes.find((node) => run!.nodeRuns[node.id]?.status === 'ready')
    if (!nextNode) return run
    switch (nextNode.kind) {
      case 'transform':
      case 'condition':
        run = executeWorkflowDeterministicNode(workflowId, runId, nextNode.id)
        break
      case 'approval':
        return requestWorkflowApproval(workflowId, runId, nextNode.id)
      case 'agent':
      case 'skill':
      case 'tool':
        run = await executeWorkflowAgentNode(workflowId, runId, nextNode.id, channelId, modelId)
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
