/**
 * 出海 Sourcing 邮箱账户配置服务 — Mailbox Config Service
 *
 * 职责：
 * - IMAP/SMTP 账户配置的持久化与读取（safeStorage 加密密码，对齐 channel-manager 模式）
 * - IMAP/SMTP 连接测试
 *
 * 存储位置：~/.gravitas/outbound-sourcing/mailbox.json
 * 安全边界：明文密码只在保存请求与连接测试的调用瞬间存在，不写盘、不进日志、不进审计。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type {
  OutboundMailboxConfig,
  OutboundMailboxConfigView,
  OutboundMailTestResult,
} from '@gravitas/shared'
import { getConfigDir } from '../config-paths'

const CONFIG_PATH = () => join(getConfigDir(), 'outbound-sourcing', 'mailbox.json')

/** 阿里企业邮默认主机（可在 UI 修改） */
export const ALIBABA_MAIL_PRESET = {
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

function encryptPassword(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法安全保存邮箱密码')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptPassword(encrypted: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('系统加密不可用，无法读取邮箱密码')
  }
  return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
}

/** 读取完整配置（含密文密码）；仅供主进程内部使用 */
export function loadMailboxConfig(): OutboundMailboxConfig | null {
  const path = CONFIG_PATH()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OutboundMailboxConfig
    if (!parsed.email || !parsed.passwordEncrypted) return null
    return parsed
  } catch (error) {
    console.warn('[出海邮件] 读取邮箱配置失败:', error)
    return null
  }
}

/** 读取渲染进程可见配置（不含密码） */
export function getMailboxConfigView(): OutboundMailboxConfigView | null {
  const config = loadMailboxConfig()
  if (!config) return null
  const { passwordEncrypted: _pw, ...rest } = config
  return { ...rest, passwordConfigured: Boolean(config.passwordEncrypted) }
}

/**
 * 保存邮箱配置。
 * password 为空字符串时保留原密码（仅改主机等设置）；否则加密覆盖。
 */
export function saveMailboxConfig(input: Omit<OutboundMailboxConfig, 'passwordEncrypted' | 'updatedAt'> & { password?: string }): OutboundMailboxConfigView {
  if (!input.email) throw new Error('邮箱地址不能为空')
  const existing = loadMailboxConfig()
  const password = input.password?.trim()
  if (!password && !existing) throw new Error('首次配置必须填写密码或授权码')

  const config: OutboundMailboxConfig = {
    label: input.label?.trim() || input.email,
    email: input.email.trim(),
    imapHost: input.imapHost?.trim() || ALIBABA_MAIL_PRESET.imapHost,
    imapPort: input.imapPort || ALIBABA_MAIL_PRESET.imapPort,
    imapTls: input.imapTls ?? true,
    smtpHost: input.smtpHost?.trim() || ALIBABA_MAIL_PRESET.smtpHost,
    smtpPort: input.smtpPort || ALIBABA_MAIL_PRESET.smtpPort,
    smtpTls: input.smtpTls ?? true,
    fromName: input.fromName?.trim() || 'Jack',
    passwordEncrypted: password ? encryptPassword(password) : existing!.passwordEncrypted,
    syncIntervalMinutes: Math.max(0, Math.floor(input.syncIntervalMinutes ?? 0)),
    updatedAt: Date.now(),
  }

  const path = CONFIG_PATH()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8')
  console.log(`[出海邮件] 已保存邮箱配置: ${config.email}`)
  return getMailboxConfigView()!
}

/** 用解密后的密码构建 IMAP/SMTP 连接参数；密码仅在返回值中短暂存在 */
function resolveCredentials(): { config: OutboundMailboxConfig; password: string } {
  const config = loadMailboxConfig()
  if (!config) throw new Error('尚未配置邮箱账户')
  return { config, password: decryptPassword(config.passwordEncrypted) }
}

/** 测试 IMAP/SMTP 连接（各登录验证一次） */
export async function testMailboxConnection(): Promise<OutboundMailTestResult> {
  let imapOk = false
  let smtpOk = false
  let error: string | null = null

  let config: OutboundMailboxConfig
  let password: string
  try {
    ;({ config, password } = resolveCredentials())
  } catch (err) {
    return { imapOk: false, smtpOk: false, error: err instanceof Error ? err.message : String(err) }
  }

  // IMAP 登录测试
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: config.imapTls,
    auth: { user: config.email, pass: password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  })
  try {
    await client.connect()
    imapOk = true
  } catch (err) {
    error = `IMAP 连接失败: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    try { client.close() } catch { /* 忽略关闭错误 */ }
  }

  // SMTP 登录测试（IMAP 失败也继续测 SMTP，便于定位问题）
  try {
    const transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpTls,
      auth: { user: config.email, pass: password },
      connectionTimeout: 15_000,
    })
    await transporter.verify()
    smtpOk = true
  } catch (err) {
    const msg = `SMTP 连接失败: ${err instanceof Error ? err.message : String(err)}`
    error = error ? `${error}；${msg}` : msg
  }

  return { imapOk, smtpOk, error }
}

/** 供内部服务获取解密后的连接参数（如 mail-sync / mail-send） */
export function resolveMailCredentials(): { config: OutboundMailboxConfig; password: string } {
  return resolveCredentials()
}
