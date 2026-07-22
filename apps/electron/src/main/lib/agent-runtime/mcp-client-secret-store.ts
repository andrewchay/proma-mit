/**
 * MCP 服务器 client_secret 安全存储
 *
 * OAuth client_secret 属于长期凭证，不能明文保存在工作区 mcp.json 中。
 * 这里使用 runtime secret codec 进行加密后，集中存放到
 * ~/.proma/mcp-client-secrets.json，按 workspaceSlug → serverName 索引。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getMcpClientSecretsPath } from '../config-paths'
import { safeParseJSON } from '../safe-json'
import { getRuntimeSecretCodec } from './runtime-secret-codec'

/** 加密存储结构：workspaceSlug → serverName → encryptedSecret */
type ClientSecretsStore = Record<string, Record<string, string>>

function encrypt(plain: string): string {
  return getRuntimeSecretCodec().encode(plain, 'MCP client_secret')
}

function decrypt(encoded: string): string {
  return getRuntimeSecretCodec().decode(encoded, 'MCP client_secret')
}

function loadStore(): ClientSecretsStore {
  const path = getMcpClientSecretsPath()
  if (!existsSync(path)) return {}
  try {
    const encrypted = readFileSync(path, 'utf-8')
    const plain = decrypt(encrypted)
    return safeParseJSON<ClientSecretsStore>(plain, {})
  } catch (error) {
    console.error('[MCP client_secret] 读取加密存储失败:', error)
    return {}
  }
}

function saveStore(store: ClientSecretsStore): void {
  const path = getMcpClientSecretsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const encrypted = encrypt(JSON.stringify(store, null, 2))
    writeFileSync(path, encrypted, 'utf-8')
  } catch (error) {
    console.error('[MCP client_secret] 写入加密存储失败:', error)
    throw new Error('MCP client_secret 保存失败')
  }
}

/** 读取指定工作区/服务器的 client_secret（解密后） */
export function getMcpClientSecret(workspaceSlug: string, serverName: string): string | undefined {
  const store = loadStore()
  const encrypted = store[workspaceSlug]?.[serverName]
  if (!encrypted) return undefined
  try {
    return decrypt(encrypted)
  } catch (error) {
    console.error(`[MCP client_secret] 解密失败: ${workspaceSlug}/${serverName}`, error)
    return undefined
  }
}

/** 保存指定工作区/服务器的 client_secret（加密后） */
export function setMcpClientSecret(workspaceSlug: string, serverName: string, secret: string): void {
  const store = loadStore()
  if (!store[workspaceSlug]) {
    store[workspaceSlug] = {}
  }
  store[workspaceSlug][serverName] = encrypt(secret)
  saveStore(store)
}

/** 删除指定工作区/服务器的 client_secret */
export function removeMcpClientSecret(workspaceSlug: string, serverName: string): void {
  const store = loadStore()
  if (store[workspaceSlug]?.[serverName]) {
    delete store[workspaceSlug][serverName]
    if (Object.keys(store[workspaceSlug]).length === 0) {
      delete store[workspaceSlug]
    }
    saveStore(store)
  }
}
