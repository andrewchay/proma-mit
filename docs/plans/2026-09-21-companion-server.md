# Companion Server（手机浏览器远程操作本机 Gravitas）Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Electron 主进程内嵌一个带配对认证的 HTTP+SSE 服务（Companion Server），手机浏览器可查看本机 Agent 会话流、远程确认权限/AskUser 请求、发送消息与停止任务。

**Architecture:** 新增 `main/lib/companion-*` 模块族：`companion-api.ts`（纯路由表，依赖注入，可单测）+ `companion-server.ts`（node:http 装配真实服务）+ `companion-auth.ts`（配对码/token）+ `companion-page.ts`（内联移动单页）。事件复用 `agentEventBus`（灵动岛同源），操作复用 `permissionService` / `askUserService` / `runAgentHeadless` / `stopAgent`。设计依据见会话工作台 `companion-ui-design.md`。

**Tech Stack:** node:http（无新依赖）、SSE（`AgentStreamEnvelope`，已有）、bun:test、原生 JS 单页（无框架）。

**范围：** 设计文档 M1（只读+认证）+ M2（可操作）。M3（Web Push/PWA/附件预览）不在本计划内。

**硬约束（来自 AGENTS.md）：**
- 测试必须 `process.env.PROMA_TEST_CONFIG_DIR` 隔离，监听一律 `127.0.0.1` + `port 0`，测试后 `rmSync` 并删除环境变量。
- 注释和日志用中文。
- 版本递增：本计划影响 `@gravitas/shared`（0.1.76 → 0.1.77）与 `@gravitas/electron`（0.11.69 → 0.11.70）。

---

### Task 1: shared 类型与常量扩展

**Files:**
- Modify: `packages/shared/src/types/agent.ts`
- Modify: `packages/shared/package.json`（version patch +1）

**Step 1: 扩展 `AgentExternalRunSource`**

在 `AgentExternalRunSource` 定义处（约 line 607）追加 `'companion'`：

```ts
export type AgentExternalRunSource = 'feishu' | 'dingtalk' | 'wechat' | 'bridge' | 'workflow' | 'delegation' | 'companion'
```

**Step 2: 新增 IPC 通道常量**

在 `AGENT_IPC_CHANNELS` 常量对象之后新增（同文件）：

```ts
/**
 * Companion（手机浏览器远程访问）IPC 通道
 */
export const COMPANION_IPC_CHANNELS = {
  /** 生成一次性配对码（设置页触发） */
  GENERATE_PAIRING_CODE: 'companion:generate-pairing-code',
  /** 查询 companion 服务状态（是否运行、端口） */
  GET_STATUS: 'companion:get-status',
} as const
```

**Step 3: 类型检查**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误。

**Step 4: Commit**

```bash
git add packages/shared/src/types/agent.ts packages/shared/package.json
git commit -m "feat(shared): 新增 companion 外部运行来源与 IPC 通道常量"
```

---

### Task 2: Settings 扩展 `companionServer` 配置

**Files:**
- Modify: `apps/electron/src/types/settings.ts:195`（`AppSettings` 接口，`briefCallback` 字段附近）
- Modify: `apps/electron/src/main/lib/settings-service.ts:96`（`NESTED_MERGE_FIELDS`）
- Test: `apps/electron/src/main/lib/settings-merge.test.ts`（如已有对应测试文件则在其中追加；先用 `grep -rn "mergeNestedSettings" apps/electron/src/main --include="*.test.ts"` 确认）

**Step 1: 写失败测试（深合并行为）**

```ts
import { describe, expect, test } from 'bun:test'
import { mergeNestedSettings } from './settings-service'

describe('companionServer 配置深合并', () => {
  test('嵌套字段部分更新不丢失已有键', () => {
    const current = { companionServer: { enabled: true, port: 8790, tokenHash: 'abc' } } as never
    const merged = mergeNestedSettings(current, { companionServer: { enabled: false } } as never)
    expect((merged as { companionServer: Record<string, unknown> }).companionServer).toEqual({
      enabled: false,
      port: 8790,
      tokenHash: 'abc',
    })
  })
})
```

**Step 2: 运行确认失败**

Run: `cd apps/electron && bun test src/main/lib/settings-merge.test.ts`
Expected: FAIL（`companionServer` 不在 `NESTED_MERGE_FIELDS`，走浅合并丢失 port/tokenHash）。

**Step 3: 实现**

`settings.ts` 中 `AppSettings` 增加（放在 `briefCallback` 字段旁）：

```ts
  /** Companion 远程访问（手机浏览器）配置 */
  companionServer?: {
    /** 是否启用（启用后主进程自动启动监听） */
    enabled?: boolean
    /** 监听端口，默认 8790 */
    port?: number
    /** 监听地址，默认 0.0.0.0（局域网）；建议填 Tailscale IP 以缩小暴露面 */
    bindAddress?: string
    /** 长期访问 token 的 SHA-256 hash（绝不存明文） */
    tokenHash?: string
  }
```

`settings-service.ts` 的 `NESTED_MERGE_FIELDS` 集合加入 `'companionServer'`。

**Step 4: 运行测试通过**

Run: `cd apps/electron && bun test src/main/lib/settings-merge.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/types/settings.ts apps/electron/src/main/lib/settings-service.ts apps/electron/src/main/lib/settings-merge.test.ts
git commit -m "feat(electron): settings 新增 companionServer 嵌套配置"
```

---

### Task 3: companion-auth 模块（配对码 + token）

**Files:**
- Create: `apps/electron/src/main/lib/companion-auth.ts`
- Test: `apps/electron/src/main/lib/companion-auth.test.ts`

**设计要点：**
- 配对码：6 位数字，内存保存（不落盘），120 秒有效，单次使用。
- token：32 字节随机 hex；只把 SHA-256 hash 写入 settings（`companionServer.tokenHash`）。
- 校验用 `crypto.timingSafeEqual` 比较 hash，防时序侧信道。

**Step 1: 写失败测试**

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generatePairingCode,
  verifyPairingCode,
  issueToken,
  verifyToken,
  _resetForTest,
} from './companion-auth'

const testDir = join(tmpdir(), `gravitas-companion-auth-test-${Date.now()}`)

afterEach(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

describe('companion-auth', () => {
  test('配对码：生成可验证、单次有效', () => {
    _resetForTest()
    const code = generatePairingCode()
    expect(code).toMatch(/^\d{6}$/)
    expect(verifyPairingCode(code)).toBe(true)
    // 第二次验证同一码应失败（单次使用）
    expect(verifyPairingCode(code)).toBe(false)
    expect(verifyPairingCode('000000')).toBe(false)
  })

  test('token：签发后可通过 hash 校验，明文不落盘', async () => {
    _resetForTest()
    process.env.PROMA_TEST_CONFIG_DIR = testDir
    const { token } = await issueToken()
    expect(token.length).toBe(64)
    expect(verifyToken(token)).toBe(true)
    expect(verifyToken('a'.repeat(64))).toBe(false)
    // settings 里只允许出现 hash，不允许出现明文 token
    const { getSettings } = await import('./settings-service')
    const raw = JSON.stringify(getSettings())
    expect(raw.includes(token)).toBe(false)
  })
})
```

注意：`issueToken` 需要能写 settings（复用 `settings-service` 的 `updateSettings`），所以测试前要设 `PROMA_TEST_CONFIG_DIR`。`generatePairingCode` 纯内存，不需要。

**Step 2: 运行确认失败**

Run: `cd apps/electron && bun test src/main/lib/companion-auth.test.ts`
Expected: FAIL，模块不存在。

**Step 3: 实现 `companion-auth.ts`**

```ts
/**
 * Companion 认证模块
 *
 * 手机浏览器首次访问时用一次性配对码换取长期 token；
 * 主进程只保存 token 的 SHA-256 hash（写入 settings），明文仅出现在配对响应中。
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { updateSettings, getSettings } from './settings-service'

/** 配对码有效期（毫秒） */
const PAIRING_CODE_TTL_MS = 120_000

interface PendingPairingCode {
  code: string
  expiresAt: number
}

let pendingPairing: PendingPairingCode | null = null

/** 生成一次性配对码（6 位数字，120 秒有效） */
export function generatePairingCode(): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  pendingPairing = { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS }
  return code
}

/** 校验并消费配对码；过期或不匹配返回 false */
export function verifyPairingCode(code: string): boolean {
  if (!pendingPairing || Date.now() > pendingPairing.expiresAt) return false
  const ok = code === pendingPairing.code
  pendingPairing = null // 无论匹配与否都消费，防暴力枚举
  return ok
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 签发新 token：明文返回给调用方（配对响应），hash 持久化到 settings */
export async function issueToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = sha256(token)
  updateSettings({ companionServer: { tokenHash } })
  return { token, tokenHash }
}

/** 常量时间校验 Bearer token */
export function verifyToken(token: string | undefined | null): boolean {
  const storedHash = getSettings().companionServer?.tokenHash
  if (!token || !storedHash) return false
  const given = Buffer.from(sha256(token), 'hex')
  const stored = Buffer.from(storedHash, 'hex')
  return given.length === stored.length && timingSafeEqual(given, stored)
}

/** 测试专用：清空内存态 */
export function _resetForTest(): void {
  pendingPairing = null
}
```

注意：`updateSettings({ companionServer: {...} })` 依赖 Task 2 已把 `companionServer` 加入 `NESTED_MERGE_FIELDS`，否则会覆盖掉 `tokenHash` 之外的键。

**Step 4: 运行测试通过**

Run: `cd apps/electron && bun test src/main/lib/companion-auth.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/companion-auth.ts apps/electron/src/main/lib/companion-auth.test.ts
git commit -m "feat(electron): companion 配对码与 token 认证模块"
```

---

### Task 4: companion-api 纯路由表（依赖注入，可单测）

**Files:**
- Create: `apps/electron/src/main/lib/companion-api.ts`
- Test: `apps/electron/src/main/lib/companion-api.test.ts`

**设计要点：** 把「HTTP 解析」与「业务调用」分离。`createCompanionApi(deps)` 返回 `(method, pathname, body, query) => Promise<Response | null>` 的纯函数，方便用 fake deps 单测；`companion-server.ts`（Task 6）只负责 node:http 解析与 SSE 长连接。

**Step 1: 写失败测试**

```ts
import { describe, expect, test } from 'bun:test'
import { createCompanionApi, type CompanionApiDeps } from './companion-api'

function makeDeps(overrides: Partial<CompanionApiDeps> = {}): CompanionApiDeps {
  return {
    verifyPairingCode: (code: string) => code === '123456',
    issueToken: async () => ({ token: 't'.repeat(64) }),
    verifyToken: (t: string | undefined) => t === 'good-token',
    listSessions: () => [{ id: 's1', title: '测试会话' } as never],
    getMessages: (id: string) => (id === 's1' ? [{ role: 'user', content: [] }] : null) as never,
    getPendingPermissions: () => [],
    getPendingAskUsers: () => [],
    respondPermission: async () => 's1',
    respondAskUser: async () => 's1',
    isSessionActive: () => false,
    sendUserMessage: async () => undefined,
    stopSession: () => true,
    appendAudit: async () => undefined,
    ...overrides,
  }
}

describe('companion-api 路由', () => {
  test('无 token 的业务接口返回 401', async () => {
    const api = createCompanionApi(makeDeps())
    const res = await api('GET', '/api/sessions', undefined, new URLSearchParams())
    expect(res!.status).toBe(401)
  })

  test('配对成功返回 token，错误配对码返回 403', async () => {
    const api = createCompanionApi(makeDeps())
    const ok = await api('POST', '/api/pair', { code: '123456' }, new URLSearchParams())
    expect(ok!.status).toBe(200)
    expect(((await ok!.json()) as { token: string }).token).toBe('t'.repeat(64))
    const bad = await api('POST', '/api/pair', { code: '000000' }, new URLSearchParams())
    expect(bad!.status).toBe(403)
  })

  test('GET /api/sessions 返回会话列表', async () => {
    const api = createCompanionApi(makeDeps())
    const res = await api('GET', '/api/sessions', undefined, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(200)
    expect(((await res!.json()) as { sessions: unknown[] }).sessions.length).toBe(1)
  })

  test('发送消息：会话运行中返回 409，空闲时调用 sendUserMessage 并审计', async () => {
    let audited = false
    const api = createCompanionApi(makeDeps({
      isSessionActive: () => true,
      appendAudit: async () => { audited = true },
    }))
    const busy = await api('POST', '/api/sessions/s1/messages', { text: 'hi' }, new URLSearchParams(), 'good-token')
    expect(busy!.status).toBe(409)

    const idleApi = createCompanionApi(makeDeps({
      sendUserMessage: async () => { audited = true },
    }))
    const ok = await idleApi('POST', '/api/sessions/s1/messages', { text: 'hi' }, new URLSearchParams(), 'good-token')
    expect(ok!.status).toBe(202)
    expect(audited).toBe(true)
  })

  test('权限应答：拒绝 alwaysAllow=true（远程确认不落盘白名单）', async () => {
    let capturedAlwaysAllow: boolean | undefined
    const api = createCompanionApi(makeDeps({
      respondPermission: async (_id: string, _behavior: 'allow' | 'deny', alwaysAllow?: boolean) => {
        capturedAlwaysAllow = alwaysAllow
        return 's1'
      },
    }))
    const res = await api('POST', '/api/permission/p1', { behavior: 'allow', alwaysAllow: true }, new URLSearchParams(), 'good-token')
    expect(res!.status).toBe(200)
    expect(capturedAlwaysAllow).toBe(false) // 强制覆盖为 false
  })
})
```

**Step 2: 运行确认失败**

Run: `cd apps/electron && bun test src/main/lib/companion-api.test.ts`
Expected: FAIL，模块不存在。

**Step 3: 实现 `companion-api.ts`**

```ts
/**
 * Companion API — 纯路由表
 *
 * 与传输层（node:http）解耦：输入 method/path/body/query/token，输出 Response。
 * 依赖通过 CompanionApiDeps 注入，主进程装配真实服务，单测注入 fake。
 */

import type { AgentMessage, AgentSessionMeta, AskUserRequest, PermissionRequest } from '@gravitas/shared'

export interface CompanionApiDeps {
  verifyPairingCode(code: string): boolean
  issueToken(): Promise<{ token: string }>
  verifyToken(token: string | undefined | null): boolean
  listSessions(): AgentSessionMeta[]
  getMessages(sessionId: string): AgentMessage[] | null
  getPendingPermissions(): PermissionRequest[]
  getPendingAskUsers(): AskUserRequest[]
  respondPermission(requestId: string, behavior: 'allow' | 'deny', alwaysAllow?: boolean): Promise<string | null>
  respondAskUser(requestId: string, answers: Record<string, string>): Promise<string | null>
  isSessionActive(sessionId: string): boolean
  sendUserMessage(sessionId: string, text: string): Promise<void>
  stopSession(sessionId: string): boolean
  appendAudit(input: { action: string; sessionId?: string; detail?: string }): Promise<void>
}

/** 未知路由返回 null，由传输层决定 404 */
export type CompanionApiHandler = (
  method: string,
  pathname: string,
  body: { code?: string; text?: string; behavior?: 'allow' | 'deny'; answers?: Record<string, string> } | undefined,
  query: URLSearchParams,
  token?: string,
) => Promise<Response | null>

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export function createCompanionApi(deps: CompanionApiDeps): CompanionApiHandler {
  return async (method, pathname, body, query, token) => {
    // ---- 配对接口不需要 token ----
    if (method === 'POST' && pathname === '/api/pair') {
      const code = typeof body?.code === 'string' ? body.code : ''
      if (!deps.verifyPairingCode(code)) return json({ error: '配对码无效或已过期' }, 403)
      const { token: newToken } = await deps.issueToken()
      await deps.appendAudit({ action: 'pair' })
      return json({ token: newToken })
    }

    // ---- 其余接口一律要求 Bearer token ----
    if (!deps.verifyToken(token)) return json({ error: '未认证' }, 401)

    if (method === 'GET' && pathname === '/api/sessions') {
      return json({ sessions: deps.listSessions() })
    }
    if (method === 'GET' && pathname.startsWith('/api/sessions/')) {
      const sessionId = decodeURIComponent(pathname.split('/')[3] ?? '')
      if (pathname.endsWith('/messages')) {
        const messages = deps.getMessages(sessionId)
        return messages === null ? json({ error: '会话不存在' }, 404) : json({ messages })
      }
      if (pathname.endsWith('/stop') && method === 'POST') {
        const ok = deps.stopSession(sessionId)
        await deps.appendAudit({ action: 'stop', sessionId })
        return ok ? json({ ok: true }) : json({ error: '会话未在运行' }, 409)
      }
      if (method === 'POST' && pathname.endsWith('/messages')) {
        const text = typeof body?.text === 'string' ? body.text.trim() : ''
        if (!text) return json({ error: '消息不能为空' }, 400)
        if (deps.isSessionActive(sessionId)) return json({ error: '会话正在运行中' }, 409)
        await deps.sendUserMessage(sessionId, text)
        await deps.appendAudit({ action: 'send_message', sessionId })
        return json({ ok: true }, 202)
      }
      return null
    }
    if (method === 'GET' && pathname === '/api/pending') {
      return json({ permissions: deps.getPendingPermissions(), askUsers: deps.getPendingAskUsers() })
    }
    if (method === 'POST' && pathname.startsWith('/api/permission/')) {
      const requestId = decodeURIComponent(pathname.split('/')[3] ?? '')
      const behavior = body?.behavior
      if (behavior !== 'allow' && behavior !== 'deny') return json({ error: 'behavior 必须是 allow 或 deny' }, 400)
      // 安全边界：远程确认不落盘白名单，alwaysAllow 强制 false
      const sessionId = await deps.respondPermission(requestId, behavior, false)
      await deps.appendAudit({ action: `permission_${behavior}`, sessionId: sessionId ?? undefined, detail: requestId })
      return sessionId ? json({ ok: true }) : json({ error: '请求不存在或已处理' }, 404)
    }
    if (method === 'POST' && pathname.startsWith('/api/ask-user/')) {
      const requestId = decodeURIComponent(pathname.split('/')[3] ?? '')
      const answers = body?.answers ?? {}
      const sessionId = await deps.respondAskUser(requestId, answers)
      await deps.appendAudit({ action: 'ask_user_respond', sessionId: sessionId ?? undefined, detail: requestId })
      return sessionId ? json({ ok: true }) : json({ error: '请求不存在或已处理' }, 404)
    }
    return null
  }
}
```

注意：`pathname.split('/')[3]` 对应 `/api/sessions/{id}/messages` 中 `{id}` 的位置（split 后：`['', 'api', 'sessions', id, ...]`）。

**Step 4: 运行测试通过**

Run: `cd apps/electron && bun test src/main/lib/companion-api.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/companion-api.ts apps/electron/src/main/lib/companion-api.test.ts
git commit -m "feat(electron): companion 纯路由表（依赖注入 + 认证/权限边界）"
```

---

### Task 5: companion-server（node:http 装配 + SSE 事件流）

**Files:**
- Create: `apps/electron/src/main/lib/companion-server.ts`
- Test: `apps/electron/src/main/lib/companion-server.test.ts`

**设计要点：**
- `startCompanionServer(): Promise<number>` / `stopCompanionServer(): Promise<void>`，幂等，参照 `brief-callback-server.ts` 的模式。
- 装配真实 deps：`permissionService.respondToPermission` / `askUserService.respondToAskUser` / `listAgentSessions` / `getAgentSessionMessages` / `runAgentHeadless` / `stopAgent` / `isAgentSessionActive` / `generatePairingCode` / `verifyPairingCode` / `issueToken` / `verifyToken`。
- SSE：订阅 `agentEventBus`，用 shared 的 `createAgentStreamEnvelope` + `serializeAgentStreamEnvelopeForSSE` 序列化；内存环形缓冲最近 500 条，支持 `?lastEventId=` 补发。只透传必要 payload（`agent_event`、`queue_state`、以及 `proma_event` 中的 permission/ask_user 相关类型），过滤大体积 `sdk_message`。

**Step 1: 写失败测试**

```ts
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const testDir = join(tmpdir(), `gravitas-companion-server-test-${Date.now()}`)

process.env.PROMA_TEST_CONFIG_DIR = testDir

describe('companion-server', () => {
  test('启动/停止幂等，静态页面可访问，业务接口 401', async () => {
    const { startCompanionServer, stopCompanionServer } = await import('./companion-server')
    const port = await startCompanionServer()
    expect(port).toBeGreaterThan(0)
    // 幂等
    expect(await startCompanionServer()).toBe(port)

    // 静态页面（无需 token）
    const page = await fetch(`http://127.0.0.1:${port}/companion`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Gravitas Companion')

    // 未带 token 的 API → 401
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`)
    expect(res.status).toBe(401)

    await stopCompanionServer()
    await stopCompanionServer() // 幂等
  })
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  try { rmSync(testDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
})
```

（SSE 事件流测试放在同文件第二个 test：先 `startCompanionServer`，用 `fetch` 建 SSE 连接，再从 `agentEventBus` emit 一条测试事件，断言流中收到 `data:` 行且 envelope 含 sessionId。）

**Step 2: 运行确认失败**

Run: `cd apps/electron && bun test src/main/lib/companion-server.test.ts`
Expected: FAIL，模块不存在。

**Step 3: 实现 `companion-server.ts`（核心骨架）**

```ts
/**
 * Companion Server — 手机浏览器远程访问入口
 *
 * 内嵌 Electron 主进程的 node:http 服务（默认端口 8790）：
 * - GET  /companion          → 移动端单页（无需认证，页面本身不含数据）
 * - 其余路由 → companion-api（全部要求 Bearer token）
 * - GET  /api/events         → SSE 实时事件流（agentEventBus 同源，支持 Last-Event-ID 补发）
 *
 * 安全：配对码换 token；token 只存 hash；不建议直接暴露公网（建议 Tailscale）。
 */

import { createServer, type Server } from 'node:http'
import type { AgentStreamPayload, AgentStreamEnvelope } from '@gravitas/shared'
import { createAgentStreamEnvelope, serializeAgentStreamEnvelopeForSSE } from '@gravitas/shared'
import { agentEventBus } from './agent-service'
import { permissionService } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { listAgentSessions, getAgentSessionMessages } from './agent-session-manager'
import { runAgentHeadless, stopAgent, isAgentSessionActive } from './agent-service'
import { getSettings, updateSettings } from './settings-service'
import { generatePairingCode, verifyPairingCode, issueToken, verifyToken } from './companion-auth'
import { createCompanionApi } from './companion-api'
import { getCompanionPageHtml } from './companion-page'
import { appendCompanionAudit } from './companion-audit-service'

const SSE_BUFFER_LIMIT = 500

let server: Server | null = null
let currentPort = 0
let unsubscribeEventBus: (() => void) | null = null
const sseClients = new Set<import('node:http').ServerResponse>()
const sseBuffer: AgentStreamEnvelope[] = []

/** 只透传 companion 需要的 payload，过滤大体积 sdk_message */
function shouldForward(payload: AgentStreamPayload): boolean {
  if (payload.kind === 'agent_event' || payload.kind === 'queue_state') return true
  if (payload.kind === 'proma_event') {
    const t = (payload.event as { type?: string }).type ?? ''
    return t.startsWith('permission_') || t === 'ask_user_request' || t === 'goal_updated'
  }
  return false // sdk_message 不推送（手机端按需拉取历史），避免大 payload
}

function broadcastEvent(sessionId: string, payload: AgentStreamPayload): void {
  if (!shouldForward(payload)) return
  const envelope = createAgentStreamEnvelope(payload, { sessionId })
  sseBuffer.push(envelope)
  if (sseBuffer.length > SSE_BUFFER_LIMIT) sseBuffer.shift()
  const line = serializeAgentStreamEnvelopeForSSE(envelope)
  for (const client of sseClients) {
    try { client.write(line) } catch { sseClients.delete(client) }
  }
}

export function startCompanionServer(): Promise<number> {
  if (server) return Promise.resolve(currentPort)
  const settings = getSettings().companionServer
  const port = settings?.port ?? 8790
  const bindAddress = settings?.bindAddress ?? '0.0.0.0'

  // 装配真实依赖
  const api = createCompanionApi({
    verifyPairingCode,
    issueToken,
    verifyToken,
    listSessions: () => listAgentSessions(),
    getMessages: (id) => {
      if (!listAgentSessions().some((s) => s.id === id)) return null
      return getAgentSessionMessages(id)
    },
    getPendingPermissions: () => permissionService.getPendingRequests(),
    getPendingAskUsers: () => askUserService.getPendingRequests(),
    respondPermission: (id, behavior, alwaysAllow) => Promise.resolve(permissionService.respondToPermission(id, behavior, alwaysAllow ?? false)),
    respondAskUser: (id, answers) => Promise.resolve(askUserService.respondToAskUser(id, answers)),
    isSessionActive: isAgentSessionActive,
    sendUserMessage: (sessionId, text) => {
      const meta = listAgentSessions().find((s) => s.id === sessionId)
      if (!meta) return Promise.reject(new Error('会话不存在'))
      return runAgentHeadless(
        { sessionId, userMessage: text, channelId: meta.channelId, workspaceId: meta.workspaceId, modelId: meta.modelId },
        { onError: () => undefined, onComplete: () => undefined, onTitleUpdated: () => undefined, source: 'companion' },
      )
    },
    stopSession: (sessionId) => stopAgent(sessionId).stopped,
    appendAudit: appendCompanionAudit,
  })

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

        // SSE 事件流（认证 + Last-Event-ID 补发）
        if (req.method === 'GET' && url.pathname === '/api/events') {
          const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined
          if (!verifyToken(token)) { res.writeHead(401); res.end('未认证'); return }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          // 按 Last-Event-ID 补发缓冲内事件
          const lastId = Number(url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? 0)
          for (const envelope of sseBuffer) {
            if (envelope.id > lastId) res.write(serializeAgentStreamEnvelopeForSSE(envelope))
          }
          sseClients.add(res)
          req.on('close', () => sseClients.delete(res))
          return
        }

        // 业务 API → companion-api
        const body = await readJsonBody(req)
        const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined
        const response = await api(req.method ?? 'GET', url.pathname, body, url.searchParams, token)
        if (response) {
          res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(await response.text())
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not Found')
      } catch (error) {
        console.error('[CompanionServer] 请求处理错误:', error)
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal Error')
      }
    })

    server.on('error', (error) => { server = null; reject(error) })
    server.listen(port, bindAddress, () => {
      const address = server?.address()
      currentPort = typeof address === 'object' && address ? address.port : port
      unsubscribeEventBus = agentEventBus.on((sessionId, payload) => broadcastEvent(sessionId, payload))
      console.log(`[CompanionServer] 已启动: http://${bindAddress}:${currentPort}/companion`)
      resolve(currentPort)
    })
  })
}

function readJsonBody(req: import('node:http').IncomingMessage): Promise<{ code?: string; text?: string; behavior?: 'allow' | 'deny'; answers?: Record<string, string> } | undefined> {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return resolve(undefined)
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) { req.destroy(); return resolve(undefined) } // 1MB 上限
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined) }
      catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

export async function stopCompanionServer(): Promise<void> {
  unsubscribeEventBus?.()
  unsubscribeEventBus = null
  for (const client of sseClients) { try { client.end() } catch { /* 忽略 */ } }
  sseClients.clear()
  const s = server
  server = null
  if (!s) return
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

export function getCompanionStatus(): { running: boolean; port: number } {
  return { running: server !== null, port: currentPort }
}
```

实现时需对照实际签名核对（写代码前先确认，勿照抄出错）：
- `createAgentStreamEnvelope(payload, options?)` 与 `serializeAgentStreamEnvelopeForSSE(envelope)` 的确切参数（`packages/shared/src/types/agent.ts:645` 和 `:658`）——envelope 的 `sessionId` 是入参还是选项。
- `agentEventBus.on(handler)` 返回取消函数（`agent-event-bus.ts` 已确认）。
- `stopAgent()` 返回 `AgentStopResult`——确认其是否有 `stopped` 字段（`agent-headless-runner-registry`），没有就适配为 boolean 表达式。
- `permissionService.respondToPermission` 是同步还是异步（grep 显示返回 sessionId，确认后包 Promise）。

**Step 4: 运行测试通过**

Run: `cd apps/electron && bun test src/main/lib/companion-server.test.ts`
Expected: PASS。

**Step 5: Commit**

```bash
git add apps/electron/src/main/lib/companion-server.ts apps/electron/src/main/lib/companion-server.test.ts
git commit -m "feat(electron): companion HTTP+SSE 服务（agentEventBus 同源事件流）"
```

---

### Task 6: companion-audit-service（操作审计）

**Files:**
- Create: `apps/electron/src/main/lib/companion-audit-service.ts`
- Test: `apps/electron/src/main/lib/companion-audit-service.test.ts`

**Step 1: 写失败测试**（`PROMA_TEST_CONFIG_DIR` 隔离；断言 `~/.gravitas 对应 testDir/companion-audit/events.jsonl` 出现一行 JSON，含 `action`、`timestamp`，且**不含**消息正文/工具输入）。

**Step 2: 实现要点**

```ts
/** Companion 操作审计 — 追加式 JSONL，只记操作摘要，不记消息正文与工具输入 */
export async function appendCompanionAudit(input: { action: string; sessionId?: string; detail?: string }): Promise<void>
```

- 写入目录：`join(getConfigDir(), 'companion-audit')`，文件 `events.jsonl`，追加写入（参照 `external-bridge-audit-service.ts` 的实现方式，`config-paths.ts` 的 `getConfigDir()` 已被 `PROMA_TEST_CONFIG_DIR` 重定向）。
- 字段：`timestamp`（ISO 时间）、`action`、`sessionId`、`detail`（仅 requestId 类短标识，禁止传消息正文）。
- 写失败静默（`catch(() => undefined)`），不影响业务。

**Step 3: 运行测试通过后 Commit**

```bash
git commit -m "feat(electron): companion 操作审计（本地 JSONL 追加）"
```

---

### Task 7: 移动端单页 `companion-page.ts`

**Files:**
- Create: `apps/electron/src/main/lib/companion-page.ts`

**设计要点：** 导出 `getCompanionPageHtml(): string`——单文件 HTML，内联 CSS/JS（vanilla，无构建步骤），深色主题，移动优先。与 brief-callback-server 的 H5 同样做法（TS 模板字符串，不进 Vite 工程）。

**页面结构（三个视图，JS 切换）：**
1. **配对视图**：6 位配对码输入 → `POST /api/pair` → 保存 token 到 `localStorage('companion-token')`。
2. **会话列表**：`GET /api/sessions`，显示标题 + 运行中状态；顶部显示「待确认」徽标（`GET /api/pending` 计数，30s 轮询）。
3. **会话详情**：`GET /api/sessions/{id}/messages` 渲染历史 + `new EventSource('/api/events?lastEventId=0')`（EventSource 不能带 header，token 通过 query `?token=` 传入——**需在 server 的 SSE 路由额外接受 `url.searchParams.get('token')` 并用同一 `verifyToken` 校验**；Task 5 实现时补上）。底部输入框 → `POST /api/sessions/{id}/messages`。权限卡片（toolName + description + command，deny 为默认按钮）→ `POST /api/permission/{requestId}`；AskUser 卡片按 options 渲染 → `POST /api/ask-user/{requestId}`。

**注意（`proma_event` 类型过滤）：** AskUserRequest / PermissionRequest 结构见 `packages/shared/src/types/agent.ts`（`PermissionRequest` 约 line 2246、`AskUserRequest` 约 line 1795），渲染时只展示 `toolName` / `description` / `command` / `questions[].{question,header,options[].label}`，不展示原始 `toolInput` JSON。

**Step 1:** 实现页面（约 200 行，深色 CSS 变量对齐应用主题风格）。
**Step 2:** Task 5 的 server 测试已覆盖页面可达；本任务在浏览器手动验证（见 Task 9 验收清单）。
**Step 3: Commit**

```bash
git commit -m "feat(electron): companion 移动端单页（配对/会话流/权限卡片）"
```

---

### Task 8: 主进程接线 + IPC + 设置 UI

**Files:**
- Modify: `apps/electron/src/main/index.ts:516` 附近（参照 `startBriefCallbackServer` 的 `safeAwait` 模式）
- Modify: `apps/electron/src/main/ipc.ts`（注册 `COMPANION_IPC_CHANNELS` 两个 handler）
- Modify: `apps/electron/src/preload/index.ts`（暴露 `companion.generatePairingCode()` / `companion.getStatus()`）
- Modify: `apps/electron/src/renderer/components/settings/`（在合适分区加「远程访问」卡片：开关、端口、配对码按钮与倒计时展示；开关写 `companionServer.enabled` 走既有 `SETTINGS_IPC_CHANNELS.UPDATE`）

**Step 1: 生命周期接线**

`main/index.ts` 中，紧跟 `startBriefCallbackServer` 的写法：

```ts
await safeAwait('startCompanionServer', async () => {
  const { startCompanionServer } = await import('./lib/companion-server')
  if (getSettings().companionServer?.enabled) await startCompanionServer()
})
```

（若 `getSettings` 未在该作用域导入，参照 brief 的取法；`onSettingsChange` 监听 `companionServer.enabled` 变化时动态 start/stop——`settings-service.ts:133` 已有 `onSettingsChange`。）

**Step 2: IPC handler**

```ts
ipcMain.handle(COMPANION_IPC_CHANNELS.GENERATE_PAIRING_CODE, () => {
  if (!getSettings().companionServer?.enabled) throw new Error('Companion 未启用')
  return generatePairingCode()
})
ipcMain.handle(COMPANION_IPC_CHANNELS.GET_STATUS, () => getCompanionStatus())
```

**Step 3: 设置 UI** —— 最小可用即可：开关（改 settings，触发 start/stop）、端口数字输入、配对码按钮（点击调 `generatePairingCode`，展示 120s 倒计时，并显示 `http://<本机局域网IP>:<port>/companion` 提示文字）。本机 IP 获取可用 `os.networkInterfaces()` 过滤非内网 IPv4。

**Step 4: Commit**

```bash
git commit -m "feat(electron): companion 生命周期接线与设置页远程访问分区"
```

---

### Task 9: 全量验证 + 版本递增

**Step 1: 类型检查 + 全量测试**

```bash
bun run typecheck
bun test
```
Expected: 全部通过；确认 `~/.gravitas/agent-workspaces/` 无新增目录（测试隔离生效）。

**Step 2: 版本递增**

- `apps/electron/package.json`: `0.11.69` → `0.11.70`
- `packages/shared/package.json`: Task 1 已处理（0.1.76 → 0.1.77）

**Step 3: 手动验收（按设计文档验证清单）**

1. 设置页开启「远程访问」，手机（同 Wi-Fi）打开 `http://<mac-ip>:8790/companion`，输入配对码完成配对，看到会话列表。
2. 电脑上运行一个会触发 Bash 权限请求的任务，手机端出现权限卡片；点「拒绝」后桌面端任务正确收到 deny；点「允许」后工具执行。
3. 手机端发送消息（空闲会话），桌面端同会话同步出现流式输出；运行中会话发送返回 409 提示。
4. 手机断网 30s 重连，SSE 通过 lastEventId 补上中间事件。
5. 错误 token / 无 token 全部 401；`~/.gravitas/companion-audit/events.jsonl` 出现 pair/permission_allow/send_message 记录且无消息正文。
6. 关闭开关后 `lsof -i :8790` 无监听。

**Step 4: Commit**

```bash
git add apps/electron/package.json
git commit -m "chore(electron): bump 0.11.70"
```

---

## 风险与回退

- **`AgentStreamEnvelope` 签名出入**：Task 5 Step 3 已标注四处需对照实际代码核对；实现时以真实签名为准。
- **SSE 经 EventSource 无法带 header**：已决定 SSE 路由额外接受 `?token=`（仍走 `verifyToken`），注意不要把它写进任何日志。
- **回退开关**：`companionServer.enabled` 默认关闭，未启用时主进程完全不监听端口，可随时通过设置关闭回退。
