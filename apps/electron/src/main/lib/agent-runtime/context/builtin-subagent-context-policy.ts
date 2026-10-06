import type { ContextProjectionRequest } from '@gravitas/shared'
import type { SubAgentInput } from '../types'

const TCC_BUILTIN_AGENT_POLICIES: Readonly<Record<string, Omit<ContextProjectionRequest, 'sessionId' | 'purpose' | 'task' | 'targetAgentId'>>> = {
  explorer: {
    maxInputTokens: 1200,
    requiredKinds: ['file_fact', 'tool_observation', 'constraint'],
    allowedVisibility: ['parent', 'child', 'model'],
    policy: {
      allowUnverified: false,
      includeRawEvidence: true,
      includeSummaries: true,
      includeFullContent: false,
    },
  },
  researcher: {
    maxInputTokens: 1600,
    requiredKinds: ['decision', 'artifact', 'constraint'],
    allowedVisibility: ['parent', 'child', 'model'],
    policy: {
      allowUnverified: false,
      includeRawEvidence: true,
      includeSummaries: true,
      includeFullContent: false,
    },
  },
  'code-reviewer': {
    maxInputTokens: 1400,
    requiredKinds: ['file_fact', 'tool_observation', 'constraint'],
    allowedVisibility: ['parent', 'child', 'model'],
    policy: {
      allowUnverified: false,
      includeRawEvidence: true,
      includeSummaries: true,
      includeFullContent: false,
    },
  },
}

/**
 * 首批内置 Agent 的显式 TCC 接入点。
 * 仅 feature flag 开启时为内置 Agent 增补 context；调用方已有 context 时永远优先，
 * 其余 Agent 与旧调用保持 plain-text 语义。
 */
export function applyBuiltinSubAgentContextPolicy(input: {
  subAgent: SubAgentInput
  enabled: boolean
}): SubAgentInput {
  if (!input.enabled || input.subAgent.context) return input.subAgent
  const policy = TCC_BUILTIN_AGENT_POLICIES[input.subAgent.agentName]
  if (!policy) return input.subAgent
  return {
    ...input.subAgent,
    context: {
      projection: {
        ...policy,
        sessionId: '',
        purpose: 'subagent_spawn',
        task: input.subAgent.task,
        targetAgentId: input.subAgent.agentName,
      },
      resultProtocol: 'typed-v1',
      readOnly: true,
    },
  }
}
