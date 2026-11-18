import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { NewMediaConnectedAccount, WechatDirectAccountProfile } from '@gravitas/shared'
import { getNewMediaCredentialProtection } from '../new-media-account-secret-store'
import { configureWechatDirectAccount, getNewMediaAccount } from '../new-media-account-service'
import { assertWechatDirectCredentialFormat } from './wechat-direct-credential'
import { getWechatAccountRevocationVersion } from '../wechat-account-lock'

interface WechatCredentialImportOptions {
  accountType: WechatDirectAccountProfile['accountType']
  verificationStatus: WechatDirectAccountProfile['verificationStatus']
  ipWhitelistConfigured: boolean
}

interface CredentialImportDependencies {
  isProtected?: () => boolean
  getAccount?: typeof getNewMediaAccount
  expectedRevocationVersion?: number
  configure?: typeof configureWechatDirectAccount
}

/** 文件只由主进程读取；路径和密钥都不返回给渲染进程。 */
export async function importWechatCredentialFile(accountId: string, path: string, options: WechatCredentialImportOptions, dependencies: CredentialImportDependencies = {}): Promise<NewMediaConnectedAccount> {
  if (!(dependencies.isProtected ?? (() => getNewMediaCredentialProtection() === 'encrypted'))()) throw new Error('系统安全存储不可用，无法导入公众号凭据')
  const revocationVersion = dependencies.expectedRevocationVersion ?? getWechatAccountRevocationVersion(accountId)
  const account = await (dependencies.getAccount ?? getNewMediaAccount)(accountId)
  if (!account || account.platform !== 'wechat-official-account') throw new Error('公众号账号不存在')
  if (account.credentialRef) throw new Error('该账号已有凭据，请先断开后重新导入')
  let text: string
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size <= 0 || info.size > 16_384) throw new Error('invalid')
      const bytes = Buffer.alloc(16_385)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 16_384) throw new Error('invalid')
      text = bytes.subarray(0, bytesRead).toString('utf8')
    } finally { await file.close() }
  } catch { throw new Error('无法读取凭据文件，请选择不超过 16 KB 的普通 JSON 文件') }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('凭据文件不是有效的 JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('凭据文件格式不正确')
  const record = value as Record<string, unknown>
  if (typeof record.appId !== 'string' || typeof record.appSecret !== 'string') throw new Error('凭据文件需包含 appId 和 appSecret')
  const credential = assertWechatDirectCredentialFormat({ appId: record.appId, appSecret: record.appSecret })
  return (dependencies.configure ?? configureWechatDirectAccount)(accountId, { ...credential, ...options }, { requireEncryption: true, expectedRevocationVersion: revocationVersion })
}
