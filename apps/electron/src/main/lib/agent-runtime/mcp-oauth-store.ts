/**
 * MCP OAuth Token 安全存储
 *
 * 使用 Electron safeStorage 对 token 进行 OS 级加密后持久化到工作区目录。
 * 每个工作区一个加密文件，按服务器名索引。
 *
 * 通过动态导入 electron，避免在测试环境静态引入 electron 导致模块解析失败。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAgentWorkspacePath } from '../config-paths'
import { safeParseJSON } from '../safe-json'

/** 持久化的 OAuth Token 结构 */
export interface McpOAuthTokens {
  accessToken: string
  refreshToken?: string
  /** 过期时间（秒级 Unix 时间戳） */
  expiresAt?: number
  scope?: string
}

let safeStorageCache: typeof import('electron').safeStorage | null | undefined

async function getSafeStorage(): Promise<typeof import('electron').safeStorage | null> {
  if (safeStorageCache !== undefined) return safeStorageCache
  try {
    const { safeStorage } = await import('electron')
    safeStorageCache = safeStorage ?? null
  } catch {
    safeStorageCache = null
  }
  return safeStorageCache
}

function getStorePath(workspaceSlug: string): string {
  return `${getAgentWorkspacePath(workspaceSlug)}/mcp-oauth-tokens.enc`
}

async function encrypt(plain: string): Promise<string> {
  const safeStorage = await getSafeStorage()
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    console.warn('[MCP OAuth] safeStorage 不可用，token 将以 base64 明文存储')
    return Buffer.from(plain).toString('base64')
  }
  return safeStorage.encryptString(plain).toString('base64')
}

async function decrypt(encoded: string): Promise<string> {
  const safeStorage = await getSafeStorage()
  const buffer = Buffer.from(encoded, 'base64')
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    return buffer.toString('utf-8')
  }
  return safeStorage.decryptString(buffer)
}

/** 读取指定工作区的所有 MCP OAuth token */
export async function loadMcpOAuthTokens(workspaceSlug: string): Promise<Record<string, McpOAuthTokens>> {
  const path = getStorePath(workspaceSlug)
  if (!existsSync(path)) return {}
  try {
    const encoded = readFileSync(path, 'utf-8')
    const plain = await decrypt(encoded)
    return safeParseJSON<Record<string, McpOAuthTokens>>(plain, {})
  } catch (error) {
    console.error(`[MCP OAuth] 读取 token 失败: ${workspaceSlug}`, error)
    return {}
  }
}

/** 保存指定工作区的所有 MCP OAuth token */
export async function saveMcpOAuthTokens(workspaceSlug: string, tokens: Record<string, McpOAuthTokens>): Promise<void> {
  const path = getStorePath(workspaceSlug)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const encoded = await encrypt(JSON.stringify(tokens, null, 2))
    writeFileSync(path, encoded, 'utf-8')
  } catch (error) {
    console.error(`[MCP OAuth] 保存 token 失败: ${workspaceSlug}`, error)
    throw new Error('MCP OAuth token 保存失败')
  }
}

/** 删除指定服务器的 token */
export async function removeMcpOAuthTokens(workspaceSlug: string, serverName: string): Promise<void> {
  const tokens = await loadMcpOAuthTokens(workspaceSlug)
  if (serverName in tokens) {
    delete tokens[serverName]
    await saveMcpOAuthTokens(workspaceSlug, tokens)
  }
}
