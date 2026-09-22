import { join } from 'node:path'
import type { ContextItem, ContextProjection, ContextProjectionRequest } from '@gravitas/shared'
import type { SubAgentInput } from '../types'
import { ContextLedgerStore } from './context-ledger'
import { compileContextProjection } from './context-projector'
import { resolveSubAgentContextOptions } from './subagent-context-options'

export interface SubAgentProjectionPreparation {
  projection?: ContextProjection
  promptSuffix: string
  fallbackReason?: string
}

export interface PrepareSubAgentProjectionInput {
  parentSessionId: string
  workspaceDirectory?: string
  enabled: boolean
  subAgent: SubAgentInput
}

export interface PrepareSubAgentProjectionFromItemsInput {
  parentSessionId: string
  enabled: boolean
  subAgent: SubAgentInput
  items: ContextItem[]
  sourceRevision: string
}

/**
 * Spawn 边界的 TCC adapter。仅显式 context.projection 才读取 ledger；旧调用完全不触发 I/O。
 * 任意 ledger/compile 异常降级为空 prompt suffix，由原有子任务 prompt 继续执行。
 */
export function prepareSubAgentProjection(
  input: PrepareSubAgentProjectionInput,
): SubAgentProjectionPreparation {
  const options = resolveSubAgentContextOptions(input.subAgent.context)
  if (!options.projection || !input.enabled) return { promptSuffix: '' }
  if (!input.workspaceDirectory) {
    return { promptSuffix: '', fallbackReason: 'workspace ledger unavailable' }
  }

  try {
    const ledger = new ContextLedgerStore(join(input.workspaceDirectory, 'context'))
    return prepareSubAgentProjectionFromItems({
      parentSessionId: input.parentSessionId, enabled: input.enabled, subAgent: input.subAgent,
      items: ledger.list({ sessionId: input.parentSessionId }), sourceRevision: ledger.sourceRevision(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { promptSuffix: '', fallbackReason: `projection failed: ${message}` }
  }
}

/** 纯 spawn 边界：供生产 ledger adapter 和隔离评测共用，避免评测绕过投影路径。 */
export function prepareSubAgentProjectionFromItems(input: PrepareSubAgentProjectionFromItemsInput): SubAgentProjectionPreparation {
  const options = resolveSubAgentContextOptions(input.subAgent.context)
  if (!options.projection || !input.enabled) return { promptSuffix: '' }
  try {
    const request: ContextProjectionRequest = { ...options.projection, sessionId: input.parentSessionId, purpose: 'subagent_spawn', task: input.subAgent.task, targetAgentId: input.subAgent.agentName }
    const projection = compileContextProjection({ request, items: input.items, sourceRevision: input.sourceRevision })
    const header = `## Typed Context Projection\nsourceRevision: ${projection.sourceRevision}\nprojectionId: ${projection.id}`
    const blocks = projection.renderedPromptBlocks.length > 0 ? `\n\n${projection.renderedPromptBlocks.join('\n\n')}` : '\n\n（没有符合当前 policy 与预算的上下文条目。）'
    return { projection, promptSuffix: `${header}${blocks}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { promptSuffix: '', fallbackReason: `projection failed: ${message}` }
  }
}
