/**
 * 凭据统一治理服务 — Credential Registry Service（PH2-D）
 *
 * 把分散的凭据（渠道 key、飞书/钉钉 Bot secret、MCP client_secret）收敛为
 * 一个可枚举、可体检的统一清单：一处看到「有哪些凭据、是否加密保存、是否缺失」。
 * 不迁移底层存储，仅做统一可见性与体检（避免凭据散落、双轨、明文风险）。
 */

export type CredentialKind = 'channel' | 'feishu_bot' | 'dingtalk_bot' | 'mcp_client_secret'

export interface CredentialEntry {
  kind: CredentialKind
  /** 唯一 ID（如 mcp 的 workspaceSlu/serverName；bot 的 botId） */
  id: string
  label: string
  /** 是否已配置密钥 */
  hasSecret: boolean
  /** 是否通过加密保存（safeStorage/codec） */
  encrypted: boolean
  /** 来源说明 */
  source: string
}

export interface CredentialRegistry {
  entries: CredentialEntry[]
  /** 已配置凭据数 */
  count: number
  /** 发现可能未加密/明文保存的风险项 */
  riskCount: number
  risks: string[]
}

/**
 * Bot 凭据（feishu/dingtalk）经 Electron safeStorage 加密保存；
 * 但 safeStorage 不可用（如部分 Linux/CI 环境）时按代码注释会以明文落盘。
 * 这里动态读取真实加密可用性，避免无条件标 encrypted:true 造成"假加密"安全感。
 */
function safeStorageAvailable(): boolean {
  try {
    const { safeStorage } = require('electron') as { safeStorage?: { isEncryptionAvailable: () => boolean } }
    return safeStorage?.isEncryptionAvailable?.() === true
  } catch {
    return false
  }
}

function botEncryptedFlag(): boolean {
  return safeStorageAvailable()
}

/** 枚举所有已配置凭据（统一可见性）。数据源懒加载（部分依赖 electron）。 */
export function listCredentials(): CredentialRegistry {
  const entries: CredentialEntry[] = []
  const risks: string[] = []
  const botEncrypted = botEncryptedFlag()

  // 1) MCP client_secret（runtime-secret-codec 加密）
  try {
    const { listMcpClientSecrets } = require('./agent-runtime/mcp-client-secret-store') as {
      listMcpClientSecrets?: () => Array<{ workspaceSlug: string; serverName: string; hasSecret: boolean }>
    }
    if (listMcpClientSecrets) {
      for (const c of listMcpClientSecrets()) {
        entries.push({
          kind: 'mcp_client_secret',
          id: `${c.workspaceSlug}/${c.serverName}`,
          label: `MCP ${c.serverName}`,
          hasSecret: c.hasSecret,
          encrypted: true,
          source: `工作区 ${c.workspaceSlug}`,
        })
      }
    }
  } catch { /* 忽略 */ }

  // 2) 飞书 Bot
  try {
    const { getFeishuMultiBotConfig } = require('./feishu-config') as {
      getFeishuMultiBotConfig: () => { bots: Array<{ id: string; name: string; appSecret?: string }> }
    }
    for (const bot of getFeishuMultiBotConfig().bots) {
      entries.push({
        kind: 'feishu_bot',
        id: bot.id,
        label: `飞书 Bot · ${bot.name}`,
        hasSecret: Boolean(bot.appSecret),
        encrypted: botEncrypted,
        source: '飞书 Todo',
      })
      if (!bot.appSecret) risks.push(`飞书 Bot「${bot.name}」未配置 appSecret`)
      else if (!botEncrypted) risks.push(`飞书 Bot「${bot.name}」secret 在 safeStorage 不可用环境下以明文保存`)
    }
  } catch { /* 忽略 */ }

  // 3) 钉钉 Bot
  try {
    const { getDingTalkMultiBotConfig } = require('./dingtalk-config') as {
      getDingTalkMultiBotConfig: () => { bots: Array<{ id: string; name: string; clientSecret?: string }> }
    }
    for (const bot of getDingTalkMultiBotConfig().bots) {
      entries.push({
        kind: 'dingtalk_bot',
        id: bot.id,
        label: `钉钉 Bot · ${bot.name}`,
        hasSecret: Boolean(bot.clientSecret),
        encrypted: botEncrypted,
        source: '钉钉 Todo',
      })
      if (!bot.clientSecret) risks.push(`钉钉 Bot「${bot.name}」未配置 clientSecret`)
      else if (!botEncrypted) risks.push(`钉钉 Bot「${bot.name}」secret 在 safeStorage 不可用环境下以明文保存`)
    }
  } catch { /* 忽略 */ }

  // 4) 渠道
  try {
    const { getSettings } = require('./settings-service') as { getSettings: () => Record<string, unknown> }
    const settings = getSettings() as { channels?: Array<{ id?: string; name?: string; apiKey?: string }> }
    for (const ch of settings.channels ?? []) {
      entries.push({
        kind: 'channel',
        id: ch.id ?? ch.name ?? '',
        label: `渠道 · ${ch.name ?? ch.id ?? '未命名'}`,
        hasSecret: Boolean(ch.apiKey),
        encrypted: false,
        source: '设置·渠道',
      })
      if (!ch.apiKey) risks.push(`渠道「${ch.name ?? ch.id}」未配置 API Key`)
    }
  } catch { /* 忽略 */ }

  return {
    entries,
    count: entries.length,
    riskCount: risks.length,
    risks,
  }
}

/** 凭据体检摘要（可读文本，给 Agent/设置页用）。 */
export function credentialRegistryToText(registry: CredentialRegistry): string {
  const lines = [
    `凭据统一体检：共 ${registry.count} 项已登记`,
    `  渠道 ${registry.entries.filter((e) => e.kind === 'channel').length} · 飞书 Bot ${registry.entries.filter((e) => e.kind === 'feishu_bot').length} · 钉钉 Bot ${registry.entries.filter((e) => e.kind === 'dingtalk_bot').length} · MCP secret ${registry.entries.filter((e) => e.kind === 'mcp_client_secret').length}`,
  ]
  if (registry.riskCount > 0) {
    lines.push(`⚠ 风险 ${registry.riskCount} 项:`)
    for (const r of registry.risks) lines.push(` - ${r}`)
  } else {
    lines.push('✓ 无凭据风险（均已配置）')
  }
  return lines.join('\n')
}
