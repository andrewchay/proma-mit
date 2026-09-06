/** Workflow 纯内存模拟回放：绝不创建 Run、调用 Agent/Tool 或请求审批。 */

import type { WorkflowRun } from '@gravitas/shared'

export interface WorkflowSimulationResult {
  sourceRunId: string
  definitionVersion: string
  simulatedNodeIds: string[]
  requiresRealExecution: Array<{ nodeId: string; kind: string; reason: string }>
  status: 'simulated' | 'requires_real_execution'
}
const deterministicKinds = new Set(['start', 'end', 'transform', 'condition', 'foreach'])

/**
 * 回放只读取冻结快照与已记录节点状态，用于判断哪些路径可安全做确定性复盘。
 * 真实执行节点不会被重试或伪造输出，而是显式返回边界说明。
 */
export function simulateWorkflowRun(run: WorkflowRun): WorkflowSimulationResult {
  const simulatedNodeIds: string[] = []
  const requiresRealExecution: WorkflowSimulationResult['requiresRealExecution'] = []
  for (const node of run.snapshot.definition.nodes) {
    if (deterministicKinds.has(node.kind)) {
      simulatedNodeIds.push(node.id)
      continue
    }
    requiresRealExecution.push({
      nodeId: node.id,
      kind: node.kind,
      reason: node.kind === 'subworkflow' ? '子流程需要创建独立 Run，模拟模式不会创建' : '该节点可能依赖模型、人工决定或外部副作用',
    })
  }
  return {
    sourceRunId: run.id,
    definitionVersion: run.snapshot.definitionVersion,
    simulatedNodeIds,
    requiresRealExecution,
    status: requiresRealExecution.length === 0 ? 'simulated' : 'requires_real_execution',
  }
}
