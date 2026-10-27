/** 逐员工冻结配置；旧批次仍使用原单一模型，新批次不改员工档案或授权总额。 */
import type { OwnerEmployeeRuntime, OwnerExecutionRevalidationSource, OwnerExecutionRevalidationRecord } from '@gravitas/shared'
import { getAgentProviderProtocol, type AgentRuntime, type ProviderType } from '@gravitas/shared'
import { getChannelById } from './channel-manager'
import { getPilotReviewedPriceEvidence, getPilotReviewedPriceEvidenceForModel } from './project-pilot-request-evidence'
import { ownerExecutionHash } from './project-owner-execution-hash'
import type { AgentEmployee } from './project-types'
import * as store from './project-sqlite-store'

export function freezeOwnerEmployeeRuntime(employee: AgentEmployee): OwnerEmployeeRuntime {
  const channel = getChannelById(employee.channelId)
  if (!employee.enabled || (employee.runtime !== 'ai-sdk' && employee.runtime !== 'pi') || employee.workflowId || !employee.modelId || !channel?.enabled || !channel.models.some(item => item.enabled && item.id === employee.modelId)) throw new Error('Owner员工运行配置不兼容或模型未明确启用')
  const providerKind = ownerEmployeePriceProviderKind(employee.runtime, channel.provider, employee.modelId)
  const price = getPilotReviewedPriceEvidenceForModel(employee.modelId, providerKind)
  if (!price) throw new Error(`Owner员工模型 ${employee.modelId} 缺少已审核价格证据`)
  return { employeeId: employee.id, employeeName: employee.name, channelId: employee.channelId, modelId: employee.modelId, runtime: employee.runtime, channelHash: ownerExecutionHash(channel), priceEvidenceId: price.evidenceId, priceEvidenceHash: ownerExecutionHash(price) }
}
/** Owner仅为Pi放行已验证为OpenAI兼容、且有精确审价的智谱GLM-5.3-Flash。 */
export function ownerEmployeePriceProviderKind(runtime: AgentRuntime | string, provider: ProviderType, modelId: string): 'openai' {
  if (runtime === 'ai-sdk') {
    if (getAgentProviderProtocol(provider, 'ai-sdk') !== 'openai-chat') throw new Error('Owner AI SDK 员工Provider协议尚未验证')
    return 'openai'
  }
  if (runtime === 'pi' && provider === 'zhipu' && modelId === 'glm-5.3-flash') return 'openai'
  throw new Error('Owner Pi 员工仅支持已验证的智谱 GLM-5.3-Flash OpenAI兼容协议')
}
export function hasOwnerMixedRuntime(employee: AgentEmployee): boolean {
  try { freezeOwnerEmployeeRuntime(employee); return true } catch { return false }
}
export function assertOwnerEmployeePrice(runtime: OwnerEmployeeRuntime): void {
  const price = getPilotReviewedPriceEvidence(runtime.priceEvidenceId)
  if (!price || price.model !== runtime.modelId || price.providerKind !== 'openai' || ownerExecutionHash(price) !== runtime.priceEvidenceHash) throw new Error('Owner员工审核价格已变化或与冻结模型不匹配')
}
export interface OwnerCommandRuntime { channelId: string; modelId: string; runtime: string; channelHash?: string; priceEvidenceId?: string; priceEvidenceHash?: string }
export function ownerEmployeeRuntimeFromSource(source: Pick<OwnerExecutionRevalidationSource, 'employeeRuntimes' | 'channelId' | 'modelId' | 'runtime'>, employeeId: string): OwnerCommandRuntime {
  if (!source.employeeRuntimes) return { channelId: source.channelId, modelId: source.modelId, runtime: source.runtime }
  const matches = source.employeeRuntimes.filter(item => item.employeeId === employeeId)
  if (matches.length !== 1 || !['ai-sdk', 'pi'].includes(matches[0]!.runtime)) throw new Error('Owner员工运行配置缺少准确冻结记录')
  return matches[0]!
}
/** 费用及晚到回调读取准确历史来源，不能受后续改目标/配置影响，也不赋予发送许可。 */
export function readOwnerCommandFrozenSource(commandId: string): { source: OwnerExecutionRevalidationSource; employeeId: string } {
  const row = store.getProjectDb().prepare(`SELECT c.project_id,c.employee_id,c.role,c.source_task_id,g.task_id,g.revalidation_id,g.revalidation_revision,g.revalidation_integrity_hash,g.source_hash,g.channel_id,g.model_id,g.runtime,g.workspace_id
    FROM project_owner_execution_commands c JOIN project_owner_execution_grants g ON g.id=c.grant_id AND g.project_id=c.project_id WHERE c.id=?`).get(commandId) as { project_id: string; employee_id: string; role: string; source_task_id: string; task_id: string | null; revalidation_id: string; revalidation_revision: number; revalidation_integrity_hash: string; source_hash: string; channel_id: string; model_id: string; runtime: string; workspace_id: string } | undefined
  if (!row) throw new Error('Owner命令缺少运行授权来源')
  const sourceRow = store.getProjectDb().prepare('SELECT payload,integrity_hash FROM project_owner_execution_revalidations WHERE id=? AND project_id=?').get(row.revalidation_id, row.project_id) as { payload: string; integrity_hash: string } | undefined
  if (!sourceRow) throw new Error('Owner命令缺少准确历史来源')
  const record = JSON.parse(sourceRow.payload) as OwnerExecutionRevalidationRecord
  const { integrityHash, ...body } = record
  if (record.id !== row.revalidation_id || record.purpose !== 'owner_business_execution_revalidation' || record.stage !== 'paused_task_links' || record.schemaVersion !== 2 || record.source.projectId !== row.project_id || record.source.taskId !== (row.task_id ?? undefined) || record.projectId !== row.project_id || record.taskId !== (row.task_id ?? undefined) || integrityHash !== sourceRow.integrity_hash || integrityHash !== ownerExecutionHash(body)) throw new Error('Owner命令历史来源完整性无效')
  const task = record?.source.tasks.find(item => item.taskId === row.source_task_id)
  const employeeId = row.role === 'executor' ? task?.executor?.id ?? record?.source.executor.id : row.role === 'reviewer' ? record?.source.reviewer.id : undefined
  if (!record || !task || employeeId !== row.employee_id || record.revision !== row.revalidation_revision || record.integrityHash !== row.revalidation_integrity_hash || ownerExecutionHash(record.source) !== row.source_hash || record.source.channelId !== row.channel_id || record.source.modelId !== row.model_id || record.source.runtime !== row.runtime || record.source.workspaceId !== row.workspace_id) throw new Error('Owner命令运行配置与准确历史来源不一致')
  return { source: record.source, employeeId: row.employee_id }
}

export function readOwnerCommandRuntime(commandId: string): ReturnType<typeof ownerEmployeeRuntimeFromSource> {
  const { source, employeeId } = readOwnerCommandFrozenSource(commandId)
  return ownerEmployeeRuntimeFromSource(source, employeeId)
}

/** 新批次价格必须仍与冻结证据相同；旧批次沿用原逐请求价格准入。 */
export function assertOwnerCommandPrice(runtime: OwnerCommandRuntime): void {
  if (!runtime.priceEvidenceId && !runtime.priceEvidenceHash) return
  const price = runtime.priceEvidenceId ? getPilotReviewedPriceEvidence(runtime.priceEvidenceId) : undefined
  if (!price || price.model !== runtime.modelId || price.providerKind !== 'openai' || ownerExecutionHash(price) !== runtime.priceEvidenceHash) throw new Error('Owner员工审核价格已变化或与冻结模型不匹配')
}
