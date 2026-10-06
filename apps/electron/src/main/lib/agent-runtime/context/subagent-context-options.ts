import type { SubAgentContextOptions } from '../types'

export interface ResolvedSubAgentContextOptions {
  projection?: NonNullable<SubAgentContextOptions['projection']>
  resultProtocol: 'typed-v1' | 'plain-text'
  readOnly: boolean
}

/**
 * 旧 Agent 工具调用不传 context 时保持原行为。
 * 一旦显式请求 TCC projection，默认收紧为 typed-v1 与只读；调用方可显式选择 plain-text，
 * 但不能在此阶段静默打开 projection。
 */
export function resolveSubAgentContextOptions(
  options?: SubAgentContextOptions,
): ResolvedSubAgentContextOptions {
  const projectionEnabled = options?.projection !== undefined
  return {
    ...(options?.projection ? { projection: options.projection } : {}),
    resultProtocol: options?.resultProtocol ?? (projectionEnabled ? 'typed-v1' : 'plain-text'),
    readOnly: options?.readOnly ?? projectionEnabled,
  }
}
