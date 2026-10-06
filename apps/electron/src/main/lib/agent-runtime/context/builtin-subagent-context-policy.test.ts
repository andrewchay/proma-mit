import { describe, expect, test } from 'bun:test'
import { applyBuiltinSubAgentContextPolicy } from './builtin-subagent-context-policy'

describe('applyBuiltinSubAgentContextPolicy', () => {
  test('given an enabled explorer rollout when no context is supplied then it receives an explicit typed readonly projection policy', () => {
    const result = applyBuiltinSubAgentContextPolicy({
      enabled: true,
      subAgent: { agentName: 'explorer', task: '定位 Agent 入口' },
    })

    expect(result.context).toMatchObject({
      resultProtocol: 'typed-v1',
      readOnly: true,
      projection: {
        purpose: 'subagent_spawn',
        task: '定位 Agent 入口',
        requiredKinds: ['file_fact', 'tool_observation', 'constraint'],
        policy: { allowUnverified: false, includeFullContent: false },
      },
    })
  })

  test('given each rollout builtin when enabled then it receives an agent-specific projection policy', () => {
    for (const agentName of ['explorer', 'researcher', 'code-reviewer']) {
      const result = applyBuiltinSubAgentContextPolicy({ enabled: true, subAgent: { agentName, task: '任务' } })
      expect(result.context?.projection?.targetAgentId).toBe(agentName)
      expect(result.context?.resultProtocol).toBe('typed-v1')
    }
  })

  test('given a disabled rollout, a custom agent, or caller context when resolving then it preserves legacy or explicit input', () => {
    const legacy = { agentName: 'explorer', task: '任务' }
    expect(applyBuiltinSubAgentContextPolicy({ enabled: false, subAgent: legacy })).toBe(legacy)
    expect(applyBuiltinSubAgentContextPolicy({ enabled: true, subAgent: { agentName: 'custom', task: '任务' } })).toEqual({ agentName: 'custom', task: '任务' })

    const explicit = { agentName: 'explorer', task: '任务', context: { resultProtocol: 'plain-text' as const } }
    expect(applyBuiltinSubAgentContextPolicy({ enabled: true, subAgent: explicit })).toBe(explicit)
  })
})
