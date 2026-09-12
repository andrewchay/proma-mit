/** 出海 sourcing 领域包：把 Redvia 的买家发现、线索判断和外联准备能力接入 Agent。 */
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'

const TOOL_NAMES = ['sourcing_build_keyword_plan', 'sourcing_score_lead', 'sourcing_draft_outreach'] as const

function readEnabled(): string[] {
  try {
    const { getSettings } = require('../settings-service') as { getSettings: () => { domainCapabilities?: string[] } }
    const capabilities = getSettings().domainCapabilities
    return Array.isArray(capabilities) ? capabilities : []
  } catch {
    return []
  }
}

export function outboundSourcingPluginRuntime(): BuiltinPluginRuntime {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'com.gravitas.outbound-sourcing',
      version: '0.1.0',
      name: '出海 sourcing',
      description: '海外买家发现、线索核验、优先级判断与人工确认前的外联草稿',
      publisher: 'Proma',
      platforms: ['darwin', 'win32', 'linux'],
      activationEvents: ['onAppReady'],
      subscriptions: [],
      surfaces: ['agent-tools'],
      permissions: {},
      entrypoints: {},
    },
    isEnabled: () => readEnabled().includes('outbound-sourcing'),
    setEnabled: async () => true,
    isSupported: () => true,
    contributePrompts: () => [
      '出海 sourcing：当用户要找海外买家、生成国家/关键词计划、判断线索质量、准备首次外联或回复邮件时，优先使用 sourcing_* 工具。先核验公司、国家、网站和联系人，再给出结论；工具只生成计划、评分和草稿，不自动发送邮件。',
      '出海 sourcing 的市场化约束：不要把线索候选当成已验证事实；国家不一致、网站缺失、邮箱未经验证时要明确标记。涉及食品、保健品、化妆品或功效时，避免未经证实的医疗/功效承诺，并提醒目标市场合规复核。',
    ],
  }
}

export { TOOL_NAMES }
