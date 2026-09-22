/**
 * Companion Server — 手机浏览器远程访问入口
 *
 * 内嵌 Electron 主进程的 node:http 服务（默认端口 8790，随设置开关启停）：
 * - GET  /companion   → 移动端单页（静态，无需认证，页面本身不含数据）
 * - GET  /api/events  → SSE 实时事件流（agentEventBus 同源，Last-Event-ID 补发）
 * - 其余路由          → companion-api（全部要求 Bearer token）
 *
 * 事件与灵动岛同源（agentEventBus），只透传 companion 需要的 payload；
 * sdk_message 体积大且手机端可按需拉取历史，不推送。
 *
 * 依赖注入：默认装配真实主进程服务（动态 import，避免模块加载期副作用）；
 * 测试可注入 fake deps 与 fake 事件总线，无需触碰 agent-service。
 *
 * 安全：配对码换 token，token 只存 hash；不建议直接暴露公网（建议 Tailscale）。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AgentStreamPayload, AgentStreamEnvelope } from '@gravitas/shared'
import { createAgentStreamEnvelope, serializeAgentStreamEnvelopeForSSE } from '@gravitas/shared'
import { createCompanionApi, type CompanionApiDeps, type CompanionApiBody } from './companion-api'
import { getCompanionPageHtml } from './companion-page'

/** SSE 环形缓冲上限（断线重连补发窗口） */
const SSE_BUFFER_LIMIT = 500
/** 请求体大小上限（字节） */
const BODY_LIMIT_BYTES = 1_000_000

/** agentEventBus 的最小结构（真实总线与测试 fake 共用） */
export interface CompanionEventSource {
  on(handler: (sessionId: string, payload: AgentStreamPayload) => void): () => void
}

export interface CompanionServerOptions {
  /** 注入自定义业务依赖（测试用）；缺省时动态加载真实主进程服务 */
  deps?: CompanionApiDeps
  /** 注入自定义事件总线（测试用）；缺省时使用真实 agentEventBus */
  eventSource?: CompanionEventSource
  /** 覆盖监听端口（测试用 port 0）；缺省读 settings.companionServer.port */
  port?: number
  /** 覆盖监听地址（测试用 127.0.0.1）；缺省读 settings.companionServer.bindAddress */
  bindAddress?: string
}

let server: Server | null = null
let currentPort = 0
let unsubscribeEventBus: (() => void) | null = null
const sseClients = new Set<ServerResponse>()
const sseBuffer: AgentStreamEnvelope[] = []
/** 自增事件序列号：用连续数字作为 envelope.id，使 Last-Event-ID 可比较 */
let sseSeq = 0

/** 只透传 companion 需要的 payload，过滤大体积 sdk_message */
function shouldForward(payload: AgentStreamPayload): boolean {
  if (payload.kind === 'agent_event' || payload.kind === 'queue_state') return true
  if (payload.kind === 'proma_event') {
    const type = (payload.event as { type?: string }).type ?? ''
    return type.startsWith('permission_') || type === 'ask_user_request' || type === 'goal_updated'
  }
  return false
}

/** agentEventBus 事件 → envelope 入缓冲并广播给所有 SSE 客户端 */
function broadcastEvent(sessionId: string, payload: AgentStreamPayload): void {
  if (!shouldForward(payload)) return
  sseSeq += 1
  const envelope = createAgentStreamEnvelope(sessionId, payload, { id: String(sseSeq) })
  sseBuffer.push(envelope)
  if (sseBuffer.length > SSE_BUFFER_LIMIT) sseBuffer.shift()
  const line = serializeAgentStreamEnvelopeForSSE(envelope)
  for (const client of sseClients) {
    try {
      client.write(line)
    } catch {
      sseClients.delete(client)
    }
  }
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice(7)
  // EventSource 无法自定义 header，SSE 允许 ?token= 传参（不得写入日志）
  return url.searchParams.get('token') ?? undefined
}

function readJsonBody(req: IncomingMessage): Promise<CompanionApiBody | undefined> {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return resolve(undefined)
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        req.destroy()
        return resolve(undefined)
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as CompanionApiBody) : undefined)
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

/** 装配真实主进程服务（动态 import，仅在未注入 deps 时调用） */
async function buildRealDeps(): Promise<CompanionApiDeps> {
  const [{ runAgentHeadless, stopAgent, isAgentSessionActive, agentEventBus }, { permissionService }, { askUserService }, { listAgentSessions, getAgentSessionSDKMessages }, { listAgentWorkspacesByUpdatedAt }, { verifyPairingCode, issueToken, verifyToken }, { appendCompanionAudit }, { extractCompanionHistory }] = await Promise.all([
    import('./agent-service'),
    import('./agent-permission-service'),
    import('./agent-ask-user-service'),
    import('./agent-session-manager'),
    import('./agent-workspace-manager'),
    import('./companion-auth'),
    import('./companion-audit-service'),
    import('./companion-history'),
  ])

  return {
    verifyPairingCode,
    issueToken,
    verifyToken,
    listSessions: () =>
      // 附带运行状态，供手机端会话列表显示“运行中”脉动指示
      listAgentSessions().map((s) => ({ ...s, running: isAgentSessionActive(s.id) })),
    listWorkspaces: () =>
      listAgentWorkspacesByUpdatedAt().map((w) => ({ id: w.id, name: w.name })),
    getMessages: (id) => {
      if (!listAgentSessions().some((s) => s.id === id)) return null
      // 与桌面端同源：历史渲染自 SDK 消息，手机端做轻量文本提取
      return extractCompanionHistory(getAgentSessionSDKMessages(id))
    },
    getPendingPermissions: () => permissionService.getPendingRequests(),
    getPendingAskUsers: () => askUserService.getPendingRequests(),
    respondPermission: (id, behavior, alwaysAllow) =>
      Promise.resolve(permissionService.respondToPermission(id, behavior, alwaysAllow ?? false)),
    respondAskUser: (id, answers) => Promise.resolve(askUserService.respondToAskUser(id, answers)),
    // 应答成功后广播「已解析」事件：bus 中间件会转发给桌面渲染进程（移除卡片），
    // companion SSE 客户端也会收到并移除手机端卡片 —— 与桌面端 PERMISSION_RESPOND IPC 行为对齐
    notifyPermissionResolved: (sessionId, requestId, behavior) => {
      agentEventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'permission_resolved', requestId, behavior } })
    },
    notifyAskUserResolved: (sessionId, requestId) => {
      agentEventBus.emit(sessionId, { kind: 'proma_event', event: { type: 'ask_user_resolved', requestId } })
    },
    isSessionActive: isAgentSessionActive,
    sendUserMessage: (sessionId, text) => {
      const meta = listAgentSessions().find((s) => s.id === sessionId)
      if (!meta) return Promise.reject(new Error('会话不存在'))
      if (!meta.channelId) return Promise.reject(new Error('会话缺少渠道配置，请在桌面端发送一次消息'))
      return runAgentHeadless(
        {
          sessionId,
          userMessage: text,
          channelId: meta.channelId,
          workspaceId: meta.workspaceId,
          modelId: meta.modelId,
        },
        {
          onError: () => undefined,
          onComplete: () => undefined,
          onTitleUpdated: () => undefined,
          source: 'companion',
        },
      )
    },
    stopSession: (sessionId) => {
      if (!isAgentSessionActive(sessionId)) return false
      return stopAgent(sessionId).requestAccepted
    },
    appendAudit: appendCompanionAudit,
  }
}

/** 启动 Companion Server（幂等：已启动返回当前端口） */
export async function startCompanionServer(options: CompanionServerOptions = {}): Promise<number> {
  if (server) return currentPort
  const { getSettings } = await import('./settings-service')
  const settings = getSettings().companionServer
  const port = options.port ?? settings?.port ?? 8790
  const bindAddress = options.bindAddress ?? settings?.bindAddress ?? '0.0.0.0'
  const deps = options.deps ?? (await buildRealDeps())
  const api = createCompanionApi(deps)
  const { verifyToken } = deps

  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

        // 移动端单页（静态，无数据，无需认证）
        if (req.method === 'GET' && url.pathname === '/companion') {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(getCompanionPageHtml())
          return
        }

        // SSE 实时事件流（认证 + Last-Event-ID 补发）
        if (req.method === 'GET' && url.pathname === '/api/events') {
          if (!verifyToken(extractToken(req, url))) {
            res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('未认证')
            return
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(': connected\n\n') // 立即冲刷响应头
          const lastId = Number(url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? 0)
          for (const envelope of sseBuffer) {
            if (Number(envelope.id) > lastId) res.write(serializeAgentStreamEnvelopeForSSE(envelope))
          }
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return
        }

        // 业务 API → companion-api
        const body = await readJsonBody(req)
        const response = await api(req.method ?? 'GET', url.pathname, body, url.searchParams, extractToken(req, url))
        if (response) {
          res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(await response.text())
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not Found')
      } catch (error) {
        console.error('[CompanionServer] 请求处理错误:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        }
        res.end('Internal Error')
      }
    })

    server.on('error', (error) => {
      server = null
      reject(error)
    })
    server.listen(port, bindAddress, () => {
      const address = server?.address()
      currentPort = typeof address === 'object' && address ? address.port : port
      const bus = options.eventSource ?? null
      if (bus) {
        unsubscribeEventBus = bus.on((sessionId, payload) => broadcastEvent(sessionId, payload))
      } else {
        // 真实总线延迟绑定（见 startCompanionServer 尾部 attachRealEventBus）
      }
      console.log(`[CompanionServer] 已启动: http://${bindAddress}:${currentPort}/companion`)
      resolve(currentPort)
    })

    // 真实总线需在 listen 成功后异步绑定（动态 import 在 promise 链中处理）
    if (!options.eventSource) {
      void import('./agent-service').then(({ agentEventBus }) => {
        if (server && !unsubscribeEventBus) {
          unsubscribeEventBus = agentEventBus.on((sessionId, payload) => broadcastEvent(sessionId, payload))
        }
      })
    }
  })
}

/** 停止 Companion Server（幂等） */
export async function stopCompanionServer(): Promise<void> {
  unsubscribeEventBus?.()
  unsubscribeEventBus = null
  for (const client of sseClients) {
    try {
      client.end()
    } catch {
      /* 忽略 */
    }
  }
  sseClients.clear()
  const s = server
  server = null
  if (!s) return
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

export function getCompanionStatus(): { running: boolean; port: number } {
  return { running: server !== null, port: currentPort }
}

/** 测试专用：读取 SSE 环形缓冲（断言过滤逻辑用） */
export function __getSseBufferForTest(): AgentStreamEnvelope[] {
  return sseBuffer
}
