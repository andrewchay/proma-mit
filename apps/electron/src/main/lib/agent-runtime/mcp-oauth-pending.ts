/**
 * MCP OAuth 授权 pending 注册表
 *
 * 当 MCP 服务器触发 authorization_code 授权码流程时，transport.connect 会抛出
 * UnauthorizedError。此时将 transport.finishAuth 回调按 workspaceSlug:serverName
 * 注册到本表。用户在浏览器完成授权后，DeepLink 回到 proma://mcp-auth?code=...&...
 * 主进程根据 URL 中的 workspace/server 查找对应 finishAuth 并完成 token 交换。
 */

export interface PendingMcpOAuth {
  workspaceSlug: string
  serverName: string
  finishAuth: (authorizationCode: string) => Promise<void>
}

const pending = new Map<string, PendingMcpOAuth>()

function makeKey(workspaceSlug: string, serverName: string): string {
  return `${workspaceSlug}:${serverName}`
}

/** 注册一个等待授权的 MCP OAuth 会话 */
export function registerPendingMcpOAuth(workspaceSlug: string, serverName: string, finishAuth: (code: string) => Promise<void>): void {
  pending.set(makeKey(workspaceSlug, serverName), { workspaceSlug, serverName, finishAuth })
}

/** 获取并移除 pending 授权会话 */
export function takePendingMcpOAuth(workspaceSlug: string, serverName: string): PendingMcpOAuth | undefined {
  const key = makeKey(workspaceSlug, serverName)
  const entry = pending.get(key)
  if (entry) {
    pending.delete(key)
  }
  return entry
}

/** 查看是否存在 pending 授权会话 */
export function hasPendingMcpOAuth(workspaceSlug: string, serverName: string): boolean {
  return pending.has(makeKey(workspaceSlug, serverName))
}
