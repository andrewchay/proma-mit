/**
 * 凭据统一治理服务 — Credential Registry Service（PH2-D）
 *
 * 把分散的凭据（渠道 key、飞书/钉钉 Bot secret、MCP client_secret、新媒体账号）
 * 收敛为一个可枚举、可体检的统一清单：一处看到「有哪些凭据、是否加密保存、是否缺失」。
 * 不迁移底层存储，仅做统一可见性与体检（避免凭据散落、双轨、明文风险）。
 *
 * 体检原则：
 * - 只读取元数据与本地解密能力，绝不输出或记录明文秘密。
 * - 每个来源独立 try/catch，读取失败必须进入 sourceErrors，不能伪装成「无风险」。
 * - 渠道从权威 channels.json 只读解析；不调用 listChannels()（其首次调用可能自动写入预设渠道，
 *   体检绝不能产生配置写入副作用）。
 */

import type { CredentialEntry, CredentialRegistry } from '@gravitas/shared'

export type { CredentialEntry, CredentialRegistry }

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

/**
 * 本地解密能力检查：能解密则丢弃明文，只返回是否可用。
 * 渠道密钥历史上出现过「无法解密」错误，体检必须能暴露它。
 */
function canDecryptSecret(encryptedKey: string): boolean {
  try {
    const { safeStorage } = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable: () => boolean
        decryptString: (buffer: Buffer) => string
      }
    }
    if (!safeStorage?.isEncryptionAvailable?.()) return false
    safeStorage.decryptString(Buffer.from(encryptedKey, 'base64'))
    return true
  } catch {
    return false
  }
}

/**
 * 无副作用地读取渠道元数据（不含密钥内容，仅判断是否已配置/可解密）。
 */
function readChannelMetadata(): Array<{ id: string; name?: string; provider?: string; apiKey?: string }> {
  // 直接读取权威 channels.json；不能使用 channel-manager.listChannels()：
  // 该函数在没有 DeepSeek 渠道时会自动创建预设渠道并写盘，体检不能产生写入副作用。
  const { getChannelsPath } = require('./config-paths') as { getChannelsPath: () => string }
  const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
  const path = getChannelsPath()
  if (!existsSync(path)) return []
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as { channels?: unknown }).channels)) {
    throw new Error('渠道配置文件格式无效')
  }
  return (parsed as { channels: Array<{ id: string; name?: string; provider?: string; apiKey?: string }> }).channels
}

/** 枚举所有已配置凭据（统一可见性）。数据源懒加载（部分依赖 electron）。 */
export async function listCredentials(): Promise<CredentialRegistry> {
  const entries: CredentialEntry[] = []
  const risks: string[] = []
  const sourceErrors: string[] = []
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
  } catch (error) {
    sourceErrors.push(`MCP secret：${error instanceof Error ? error.message : '读取失败'}`)
  }

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
  } catch (error) {
    sourceErrors.push(`飞书 Bot：${error instanceof Error ? error.message : '读取失败'}`)
  }

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
  } catch (error) {
    sourceErrors.push(`钉钉 Bot：${error instanceof Error ? error.message : '读取失败'}`)
  }

  // 4) 新媒体账号（只读取非敏感元数据，不读取授权材料）
  try {
    const { listNewMediaAccounts } = await import('./new-media/new-media-account-service')
    for (const account of await listNewMediaAccounts()) {
      entries.push({
        kind: 'new_media_account',
        id: account.id,
        label: `新媒体 · ${account.displayName}`,
        hasSecret: Boolean(account.credentialRef),
        encrypted: account.credentialProtection === 'encrypted',
        source: account.platform === 'xiaohongshu' ? '小红书' : '微信公众号',
      })
      if (account.credentialProtection === 'degraded') risks.push(`新媒体账号「${account.displayName}」的授权材料未获得系统级加密保护`)
    }
  } catch (error) {
    sourceErrors.push(`新媒体账号：${error instanceof Error ? error.message : '读取失败'}`)
  }

  // 5) 渠道（权威 channels.json，只读；含本地解密能力检查）
  try {
    const encryptionAvailable = safeStorageAvailable()
    for (const channel of readChannelMetadata()) {
      const label = channel.name ?? channel.id ?? '未命名'
      const hasSecret = Boolean(channel.apiKey)
      // 有密钥且 safeStorage 可用时做本地解密能力检查（丢弃明文）；
      // safeStorage 不可用时无法证明加密状态，如实标记并提示风险。
      const encrypted = hasSecret && encryptionAvailable && canDecryptSecret(channel.apiKey!)
      entries.push({
        kind: 'channel',
        id: channel.id ?? label,
        label: `渠道 · ${label}${channel.provider ? ` · ${channel.provider}` : ''}`,
        hasSecret,
        encrypted,
        source: '设置·渠道',
      })
      if (!hasSecret) risks.push(`渠道「${label}」未配置 API Key`)
      else if (!encryptionAvailable) risks.push(`渠道「${label}」的密钥可能未加密保存（safeStorage 不可用）`)
      else if (!encrypted) risks.push(`渠道「${label}」API Key 无法本地解密，请到设置中重新填写`)
    }
  } catch (error) {
    sourceErrors.push(`渠道：${error instanceof Error ? error.message : '读取失败'}`)
  }

  return {
    entries,
    count: entries.length,
    riskCount: risks.length,
    risks,
    sourceErrors,
    checkedAt: Date.now(),
  }
}

/** 凭据体检摘要（可读文本，给 Agent/设置页用）。兼容旧调用方未传 sourceErrors 的对象。 */
export function credentialRegistryToText(registry: CredentialRegistry): string {
  const sourceErrors = registry.sourceErrors ?? []
  const lines = [
    `凭据统一体检：共 ${registry.count} 项已登记`,
    `  渠道 ${registry.entries.filter((e) => e.kind === 'channel').length} · 飞书 Bot ${registry.entries.filter((e) => e.kind === 'feishu_bot').length} · 钉钉 Bot ${registry.entries.filter((e) => e.kind === 'dingtalk_bot').length} · MCP secret ${registry.entries.filter((e) => e.kind === 'mcp_client_secret').length} · 新媒体账号 ${registry.entries.filter((e) => e.kind === 'new_media_account').length}`,
  ]
  if (sourceErrors.length > 0) {
    lines.push(`⚠ 来源检查失败 ${sourceErrors.length} 项（结果不完整，不能视为已通过）:`)
    for (const message of sourceErrors) lines.push(` - ${message}`)
  }
  if (registry.riskCount > 0) {
    lines.push(`⚠ 风险 ${registry.riskCount} 项:`)
    for (const r of registry.risks) lines.push(` - ${r}`)
  } else if (sourceErrors.length === 0) {
    lines.push('✓ 无凭据风险（均已配置）')
  }
  return lines.join('\n')
}
