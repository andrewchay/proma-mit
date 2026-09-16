import { randomUUID } from 'node:crypto'
import type {
  NewMediaAccountAuditEntry,
  NewMediaAuthorizationStart,
  NewMediaConnectedAccount,
  NewMediaPlatform,
} from '@gravitas/shared'
import type { AuthorizationMaterial } from './platform-adapter'
import { PlatformAdapterError } from './platform-adapter'
import { getPlatformAdapterRegistry } from './platform-adapter-registry'
import {
  getNewMediaCredentialProtection,
  loadNewMediaAccountSecret,
  removeNewMediaAccountSecret,
  saveNewMediaAccountSecret,
} from './new-media-account-secret-store'
import {
  deleteNewMediaRecord,
  getNewMediaRecord,
  listNewMediaRecords,
  putNewMediaRecords,
} from './new-media-sqlite-store'

const ACCOUNT_KIND = 'connected-account'
const AUDIT_KIND = 'account-audit'

function audit(accountId: string, event: NewMediaAccountAuditEntry['event'], actor: string, detail: string): NewMediaAccountAuditEntry {
  return { id: randomUUID(), accountId, event, actor, detail, createdAt: Date.now() }
}

function errorCode(error: unknown): string {
  return error instanceof PlatformAdapterError ? error.code : 'temporarily_unavailable'
}

async function requireAccount(accountId: string): Promise<NewMediaConnectedAccount> {
  const account = await getNewMediaRecord<NewMediaConnectedAccount>(ACCOUNT_KIND, accountId)
  if (!account) throw new Error('新媒体账号不存在')
  return account
}

export async function createNewMediaAccount(input: { platform: NewMediaPlatform; displayName: string }): Promise<NewMediaConnectedAccount> {
  const displayName = input.displayName.trim()
  if (!displayName) throw new Error('账号名称不能为空')
  const adapter = getPlatformAdapterRegistry().get(input.platform)
  const now = Date.now()
  const account: NewMediaConnectedAccount = {
    id: randomUUID(),
    platform: input.platform,
    displayName,
    status: 'disconnected',
    authorizationMethod: adapter.authorization.method,
    grantedScopes: [],
    capabilities: adapter.getCapabilities(),
    credentialProtection: 'none',
    createdAt: now,
    updatedAt: now,
  }
  await putNewMediaRecords([
    { kind: ACCOUNT_KIND, value: account },
    { kind: AUDIT_KIND, value: audit(account.id, 'account_created', 'local-user', `已创建${adapter.displayName}账号占位；尚未授权。`) },
  ])
  return account
}

export async function listNewMediaAccounts(): Promise<NewMediaConnectedAccount[]> {
  return listNewMediaRecords(ACCOUNT_KIND)
}

export async function getNewMediaAccount(accountId: string): Promise<NewMediaConnectedAccount | undefined> {
  return getNewMediaRecord(ACCOUNT_KIND, accountId)
}

export async function beginNewMediaAccountAuthorization(accountId: string): Promise<NewMediaAuthorizationStart> {
  const account = await requireAccount(accountId)
  const adapter = getPlatformAdapterRegistry().get(account.platform)
  if (!adapter.authorization.available) {
    await putNewMediaRecords([{
      kind: AUDIT_KIND,
      value: audit(account.id, 'validation_failed', 'local-user', adapter.authorization.description),
    }])
    return {
      accountId,
      status: account.status,
      method: adapter.authorization.method,
      available: false,
      description: adapter.authorization.description,
    }
  }

  await adapter.beginAuthorization(account)
  const pending: NewMediaConnectedAccount = {
    ...account,
    status: 'authorization_pending',
    authorizationMethod: adapter.authorization.method,
    errorCode: undefined,
    updatedAt: Date.now(),
  }
  await putNewMediaRecords([
    { kind: ACCOUNT_KIND, value: pending },
    { kind: AUDIT_KIND, value: audit(account.id, 'authorization_started', 'local-user', `已启动${adapter.displayName}授权。`) },
  ])
  return {
    accountId,
    status: pending.status,
    method: adapter.authorization.method,
    available: true,
    description: adapter.authorization.description,
  }
}

/** 仅供受信任的主进程 Adapter 回调调用；禁止通过 IPC 暴露。 */
export async function completeNewMediaAccountAuthorization(
  accountId: string,
  material: AuthorizationMaterial,
  actor = 'system:adapter',
): Promise<NewMediaConnectedAccount> {
  const account = await requireAccount(accountId)
  const adapter = getPlatformAdapterRegistry().get(account.platform)
  let validation
  try {
    validation = await adapter.validateAuthorization(material, account)
  } catch (error) {
    const failed: NewMediaConnectedAccount = { ...account, status: 'error', errorCode: errorCode(error), updatedAt: Date.now() }
    await putNewMediaRecords([
      { kind: ACCOUNT_KIND, value: failed },
      { kind: AUDIT_KIND, value: audit(account.id, 'validation_failed', actor, `授权校验失败：${failed.errorCode}`) },
    ])
    throw error
  }

  const credentialRef = account.credentialRef ?? randomUUID()
  saveNewMediaAccountSecret(credentialRef, material)
  const connected: NewMediaConnectedAccount = {
    ...account,
    externalAccountId: validation.externalAccountId,
    displayName: validation.displayName?.trim() || account.displayName,
    status: 'connected',
    authorizationMethod: adapter.authorization.method,
    grantedScopes: [...validation.grantedScopes],
    capabilities: adapter.getCapabilities(account),
    credentialRef,
    credentialProtection: getNewMediaCredentialProtection(),
    authorizedAt: Date.now(),
    expiresAt: validation.expiresAt,
    lastValidatedAt: Date.now(),
    errorCode: undefined,
    updatedAt: Date.now(),
  }
  try {
    await putNewMediaRecords([
      { kind: ACCOUNT_KIND, value: connected },
      { kind: AUDIT_KIND, value: audit(account.id, 'connected', actor, `已连接${adapter.displayName}账号；授权材料未写入业务数据库。`) },
    ])
  } catch (error) {
    removeNewMediaAccountSecret(credentialRef)
    throw error
  }
  return connected
}

export async function validateNewMediaAccount(accountId: string): Promise<NewMediaConnectedAccount> {
  const account = await requireAccount(accountId)
  if (!account.credentialRef) throw new Error('账号尚未授权')
  const material = loadNewMediaAccountSecret(account.credentialRef)
  if (!material) throw new Error('账号授权材料缺失')
  const adapter = getPlatformAdapterRegistry().get(account.platform)
  try {
    const result = await adapter.validateAuthorization(material, account)
    const validated: NewMediaConnectedAccount = {
      ...account,
      externalAccountId: result.externalAccountId,
      grantedScopes: [...result.grantedScopes],
      expiresAt: result.expiresAt,
      lastValidatedAt: Date.now(),
      status: result.expiresAt && result.expiresAt <= Date.now() ? 'expired' : 'connected',
      errorCode: undefined,
      updatedAt: Date.now(),
    }
    await putNewMediaRecords([{ kind: ACCOUNT_KIND, value: validated }])
    return validated
  } catch (error) {
    const failed: NewMediaConnectedAccount = { ...account, status: 'error', errorCode: errorCode(error), lastValidatedAt: Date.now(), updatedAt: Date.now() }
    await putNewMediaRecords([
      { kind: ACCOUNT_KIND, value: failed },
      { kind: AUDIT_KIND, value: audit(account.id, 'validation_failed', 'local-user', `账号校验失败：${failed.errorCode}`) },
    ])
    throw error
  }
}

export async function disconnectNewMediaAccount(accountId: string): Promise<NewMediaConnectedAccount> {
  const account = await requireAccount(accountId)
  if (account.status === 'disconnected' && !account.credentialRef) return account
  const adapter = getPlatformAdapterRegistry().get(account.platform)
  const material = account.credentialRef ? loadNewMediaAccountSecret(account.credentialRef) : undefined
  if (material && adapter.revokeAuthorization) await adapter.revokeAuthorization(material, account)
  if (account.credentialRef) removeNewMediaAccountSecret(account.credentialRef)
  const disconnected: NewMediaConnectedAccount = {
    ...account,
    status: 'disconnected',
    externalAccountId: undefined,
    grantedScopes: [],
    credentialRef: undefined,
    credentialProtection: 'none',
    authorizedAt: undefined,
    expiresAt: undefined,
    lastValidatedAt: undefined,
    errorCode: undefined,
    capabilities: adapter.getCapabilities(),
    updatedAt: Date.now(),
  }
  await putNewMediaRecords([
    { kind: ACCOUNT_KIND, value: disconnected },
    { kind: AUDIT_KIND, value: audit(account.id, 'disconnected', 'local-user', '已断开账号并删除本地授权材料。') },
  ])
  return disconnected
}

export async function removeNewMediaAccount(accountId: string): Promise<boolean> {
  const account = await requireAccount(accountId)
  if (account.credentialRef) removeNewMediaAccountSecret(account.credentialRef)
  await putNewMediaRecords([{ kind: AUDIT_KIND, value: audit(account.id, 'removed', 'local-user', '已删除账号元数据。') }])
  return deleteNewMediaRecord(ACCOUNT_KIND, accountId)
}

export async function getNewMediaAccountAudit(accountId: string): Promise<NewMediaAccountAuditEntry[]> {
  return (await listNewMediaRecords<NewMediaAccountAuditEntry>(AUDIT_KIND)).filter((entry) => entry.accountId === accountId)
}
