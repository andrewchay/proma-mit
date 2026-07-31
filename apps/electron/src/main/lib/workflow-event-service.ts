/** 命名事件入口。供 Bridge/Webhook 接入复用，不让外部调用方直接构造 Run。 */

import type { WorkflowEventTriggerConfig, WorkflowRun } from '@proma/shared'
import { executeWorkflowRun } from './workflow-run-executor'
import { createWorkflowRun, listWorkflowDefinitions, listWorkflowRuns } from './workflow-service'

function hasActiveRun(workflowId: string): boolean {
  return listWorkflowRuns(workflowId).some((run) => run.status === 'queued' || run.status === 'running' || run.status === 'waiting_approval' || run.status === 'blocked')
}

/** 触发同名已发布 Workflow；每个匹配流程创建独立、可审计 Run。 */
export async function triggerWorkflowEvent(eventName: string, payload: Record<string, unknown>): Promise<WorkflowRun[]> {
  if (!eventName.trim()) throw new Error('Workflow 事件名不能为空')
  const runs: WorkflowRun[] = []
  for (const definition of listWorkflowDefinitions()) {
    if (definition.status !== 'published' || definition.trigger.kind !== 'event') continue
    const config = definition.trigger.config as unknown as WorkflowEventTriggerConfig
    if (config.eventName !== eventName) continue
    if (config.concurrencyPolicy !== 'allow' && hasActiveRun(definition.id)) {
      console.warn(`[Workflow Event] 跳过重叠 Run: ${definition.name}`)
      continue
    }
    const run = createWorkflowRun(definition.id, payload, 'event')
    runs.push(await executeWorkflowRun(definition.id, run.id, config.channelId, config.modelId))
  }
  return runs
}
