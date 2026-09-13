/** 出海 sourcing 领域包：把 Redvia 的买家发现、线索判断和外联准备能力接入 Agent。 */
import type { RuntimeToolDefinition } from '../agent-runtime/types'
import type { BuiltinPluginRuntime } from '../plugin-manager'

const TOOL_NAMES = ['sourcing_build_keyword_plan', 'sourcing_score_lead', 'sourcing_draft_outreach', 'sourcing_draft_reply', 'sourcing_list_inbox', 'sourcing_queue_email', 'sourcing_get_mail_status', 'sourcing_search_buyers', 'sourcing_verify_company', 'sourcing_build_persona', 'sourcing_outreach_metrics'] as const

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
      version: '0.4.0',
      name: '出海 sourcing',
      description: '海外买家发现、线索核验、优先级判断、画像合成、外联草稿、邮件同步、审批制发送与漏斗指标',
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
      '出海 sourcing：当用户要找海外买家、生成国家/关键词计划、判断线索质量、准备首次外联或回复买家邮件时，优先使用 sourcing_* 工具。冷首触用 sourcing_draft_outreach（注入画像与知识库）；回复来信用 sourcing_draft_reply（线程头 + Calendly 意向判定，低意向来信不得附 Calendly）。邮件收发：用 sourcing_list_inbox 查看来信、sourcing_get_mail_status 查询往来状态，发送一律用 sourcing_queue_email 入队——邮件只会在用户于待发队列中逐封确认后才发出，你永远不能直接发送邮件。检索与核验：sourcing_search_buyers 收集候选公司与来源，sourcing_verify_company 抓官网返回证据（证据不等于结论），sourcing_build_persona 合成决策人画像假设；进度用 sourcing_outreach_metrics 查看漏斗。先核验公司、国家、网站和联系人，再给出结论；不要把候选公司当成已验证事实。',
      '出海 sourcing 的市场化约束：不要把线索候选当成已验证事实；国家不一致、网站缺失、邮箱未经验证时要明确标记。涉及食品、保健品、化妆品或功效时，避免未经证实的医疗/功效承诺，并提醒目标市场合规复核。',
    ],
  }
}

export { TOOL_NAMES }
