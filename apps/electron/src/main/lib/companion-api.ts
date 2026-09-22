/**
 * Companion API — 纯路由表
 *
 * 与传输层（node:http）解耦：输入 method/path/body/query/token，输出 Response。
 * 依赖通过 CompanionApiDeps 注入，主进程装配真实服务，单测注入 fake。
 *
 * 安全边界（硬约束）：
 * - 除配对接口外，所有接口一律要求 Bearer token；
 * - 远程权限确认强制 alwaysAllow=false，绝不落盘会话白名单；
 * - 运行中会话不允许直接发消息（复用主进程并发守卫语义，返回 409）。
 */

import type { AgentSessionMeta, AskUserRequest, PermissionRequest } from '@gravitas/shared'
import type { CompanionHistoryEntry } from './companion-history'

export interface CompanionApiDeps {
  verifyPairingCode(code: string): boolean
  issueToken(): Promise<{ token: string }>
  verifyToken(token: string | undefined | null): boolean
  listSessions(): AgentSessionMeta[]
  /** 工作区列表（含 updatedAt，供复刻桌面侧栏排序） */
  listWorkspaces(): { id: string; name: string; updatedAt: number }[]
  /** 手机端可读的会话历史（从 SDK 消息提取）；会话不存在返回 null */
  getMessages(sessionId: string): CompanionHistoryEntry[] | null
  getPendingPermissions(): PermissionRequest[]
  getPendingAskUsers(): AskUserRequest[]
  respondPermission(requestId: string, behavior: 'allow' | 'deny', alwaysAllow?: boolean): Promise<string | null>
  respondAskUser(requestId: string, answers: Record<string, string>): Promise<string | null>
  /** 应答成功后广播「已解析」事件（桌面渲染进程与手机端都依赖它移除卡片） */
  notifyPermissionResolved(sessionId: string, requestId: string, behavior: 'allow' | 'deny'): void
  notifyAskUserResolved(sessionId: string, requestId: string): void
  isSessionActive(sessionId: string): boolean
  sendUserMessage(sessionId: string, text: string): Promise<void>
  stopSession(sessionId: string): boolean
  appendAudit(input: { action: string; sessionId?: string; detail?: string }): Promise<void>
  /** Web Push：VAPID 公钥（首次调用自动生成并持久化） */
  getVapidPublicKey(): string
  /** 登记手机端推送订阅 */
  subscribePush(subscription: unknown): boolean
  /** 按 endpoint 移除推送订阅 */
  unsubscribePush(endpoint: string): boolean
}

/** 请求体（配对码 / 消息文本 / 权限行为 / AskUser 答案 / 推送订阅）；alwaysAllow 会被强制覆盖为 false，仅用于验证覆盖行为 */
export interface CompanionApiBody {
  code?: string
  text?: string
  behavior?: 'allow' | 'deny'
  alwaysAllow?: boolean
  answers?: Record<string, string>
  subscription?: unknown
  endpoint?: string
}

/** 未知路由返回 null，由传输层决定 404 */
export type CompanionApiHandler = (
  method: string,
  pathname: string,
  body: CompanionApiBody | undefined,
  query: URLSearchParams,
  token?: string,
) => Promise<Response | null>

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

/** 从 /api/<resource>/<id>[/action] 形式的路径中取出 <id>（含 URL 解码） */
function pathId(pathname: string): string {
  return decodeURIComponent(pathname.split('/')[3] ?? '')
}

export function createCompanionApi(deps: CompanionApiDeps): CompanionApiHandler {
  return async (method, pathname, body, _query, token) => {
    // ---- 配对接口不需要 token ----
    if (method === 'POST' && pathname === '/api/pair') {
      const code = typeof body?.code === 'string' ? body.code : ''
      if (!deps.verifyPairingCode(code)) {
        await deps.appendAudit({ action: 'pair_failed' })
        return json({ error: '配对码无效或已过期' }, 403)
      }
      const { token: newToken } = await deps.issueToken()
      await deps.appendAudit({ action: 'pair' })
      return json({ token: newToken })
    }

    // ---- 其余接口一律要求 Bearer token ----
    if (!deps.verifyToken(token)) return json({ error: '未认证' }, 401)

    // ---- 只读接口 ----
    if (method === 'GET' && pathname === '/api/sessions') {
      return json({ sessions: deps.listSessions() })
    }
    if (method === 'GET' && pathname === '/api/workspaces') {
      return json({ workspaces: deps.listWorkspaces() })
    }
    if (method === 'GET' && pathname === '/api/pending') {
      return json({ permissions: deps.getPendingPermissions(), askUsers: deps.getPendingAskUsers() })
    }
    if (pathname.startsWith('/api/sessions/') && pathname.endsWith('/messages') && method === 'GET') {
      const messages = deps.getMessages(pathId(pathname))
      return messages === null ? json({ error: '会话不存在' }, 404) : json({ messages })
    }

    // ---- 操作接口 ----
    if (pathname.startsWith('/api/sessions/') && method === 'POST') {
      const sessionId = pathId(pathname)
      if (pathname.endsWith('/messages')) {
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        if (!text) return json({ error: '消息不能为空' }, 400)
        if (deps.isSessionActive(sessionId)) return json({ error: '会话正在运行中，请稍后再试' }, 409)
        await deps.sendUserMessage(sessionId, text)
        await deps.appendAudit({ action: 'send_message', sessionId })
        return json({ ok: true }, 202)
      }
      if (pathname.endsWith('/stop')) {
        const ok = deps.stopSession(sessionId)
        if (!ok) return json({ error: '会话未在运行' }, 409)
        await deps.appendAudit({ action: 'stop', sessionId })
        return json({ ok: true })
      }
      return null
    }
    if (pathname.startsWith('/api/permission/') && method === 'POST') {
      const requestId = pathId(pathname)
      const behavior = body?.behavior
      if (behavior !== 'allow' && behavior !== 'deny') {
        return json({ error: 'behavior 必须是 allow 或 deny' }, 400)
      }
      // 安全边界：远程确认不落盘白名单，alwaysAllow 强制 false
      const sessionId = await deps.respondPermission(requestId, behavior, false)
      if (!sessionId) return json({ error: '请求不存在或已处理' }, 404)
      deps.notifyPermissionResolved(sessionId, requestId, behavior)
      await deps.appendAudit({ action: `permission_${behavior}`, sessionId, detail: requestId })
      return json({ ok: true })
    }
    if (pathname.startsWith('/api/ask-user/') && method === 'POST') {
      const requestId = pathId(pathname)
      const answers = body?.answers ?? {}
      const sessionId = await deps.respondAskUser(requestId, answers)
      if (!sessionId) return json({ error: '请求不存在或已处理' }, 404)
      deps.notifyAskUserResolved(sessionId, requestId)
      await deps.appendAudit({ action: 'ask_user_respond', sessionId, detail: requestId })
      return json({ ok: true })
    }

    if (method === 'GET' && pathname === '/api/push/vapid') {
      return json({ publicKey: deps.getVapidPublicKey() })
    }
    if (method === 'POST' && pathname === '/api/push/subscribe') {
      const ok = deps.subscribePush(body?.subscription)
      return ok ? json({ ok: true }) : json({ error: '订阅结构无效' }, 400)
    }
    if (method === 'POST' && pathname === '/api/push/unsubscribe') {
      const endpoint = typeof (body as { endpoint?: string } | undefined)?.endpoint === 'string' ? (body as { endpoint: string }).endpoint : ''
      deps.unsubscribePush(endpoint)
      return json({ ok: true })
    }
    return null
  }
}
