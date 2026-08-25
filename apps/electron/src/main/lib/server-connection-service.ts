/**
 * Electron 服务端连接服务
 *
 * 管理开源版 Electron 与企业版服务端的连接。
 * 支持多种认证模式：none / local / oidc。
 */

import type { AgentRuntimeScope } from '@gravitas/shared'
import { getLocalTenantScope } from './local-tenant-scope'

export interface ServerConnectionConfig {
  serverUrl: string
  authMode: 'none' | 'local' | 'oidc'
  /** local 模式凭据 */
  username?: string
  password?: string
  /** oidc 模式凭据（由 OAuth 流程获取） */
  accessToken?: string
}

export interface ServerConnection {
  serverUrl: string
  authMode: 'none' | 'local' | 'oidc'
  scope: AgentRuntimeScope
  /** 用于 API 调用的认证头 */
  authHeaders: Record<string, string>
  /** 连接是否活跃 */
  isConnected: boolean
}

let _activeConnection: ServerConnection | undefined

/**
 * 连接到企业版服务端
 */
export async function connectToServer(config: ServerConnectionConfig): Promise<ServerConnection> {
  // 1. 获取服务端状态
  const statusRes = await fetch(`${config.serverUrl}/auth/status`)
  if (!statusRes.ok) {
    throw new Error(`无法连接服务端: ${statusRes.status}`)
  }
  const status = (await statusRes.json()) as { authMode: string; hasOidc: boolean }

  // 2. 验证认证模式匹配
  if (status.authMode !== config.authMode) {
    throw new Error(`服务端认证模式为 ${status.authMode}，与请求的 ${config.authMode} 不匹配`)
  }

  let scope: AgentRuntimeScope
  let authHeaders: Record<string, string> = {}

  switch (config.authMode) {
    case 'none': {
      // 无鉴权模式：直接使用本地租户 scope
      scope = getLocalTenantScope()
      break
    }
    case 'local': {
      if (!config.username || !config.password) {
        throw new Error('local 模式需要提供用户名和密码')
      }
      const loginRes = await fetch(`${config.serverUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: config.username, password: config.password }),
      })
      if (!loginRes.ok) {
        throw new Error(`登录失败: ${loginRes.status}`)
      }
      // local 模式使用 cookie 会话，后续请求自动携带
      const setCookie = loginRes.headers.get('set-cookie')
      if (setCookie) {
        const cookieValue = setCookie.split(';')[0]
        if (cookieValue) {
          authHeaders['cookie'] = cookieValue
        }
      }
      if (!config.username) {
        throw new Error('local 模式需要提供用户名')
      }
      const username = config.username
      scope = { tenantId: 'local', userId: username, roles: ['admin'] }
      break
    }
    case 'oidc': {
      if (!config.accessToken) {
        throw new Error('oidc 模式需要提供 accessToken')
      }
      authHeaders['authorization'] = `Bearer ${config.accessToken}`
      // TODO: 解析 JWT 获取 scope
      scope = { tenantId: 'local', userId: 'oidc-user', roles: ['admin'] }
      break
    }
  }

  const connection: ServerConnection = {
    serverUrl: config.serverUrl,
    authMode: config.authMode,
    scope,
    authHeaders,
    isConnected: true,
  }

  _activeConnection = connection
  return connection
}

/**
 * 断开服务端连接
 */
export function disconnectFromServer(): void {
  _activeConnection = undefined
}

/**
 * 获取当前活跃连接
 */
export function getActiveConnection(): ServerConnection | undefined {
  return _activeConnection
}

/**
 * 检查是否已连接到服务端
 */
export function isConnectedToServer(): boolean {
  return _activeConnection?.isConnected ?? false
}

/**
 * 使用当前连接发送 API 请求
 */
export async function serverApiRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const conn = getActiveConnection()
  if (!conn) {
    throw new Error('未连接到服务端')
  }

  const url = `${conn.serverUrl}${path}`
  const headers = {
    ...conn.authHeaders,
    ...(options.headers || {}),
  }

  return fetch(url, { ...options, headers })
}
