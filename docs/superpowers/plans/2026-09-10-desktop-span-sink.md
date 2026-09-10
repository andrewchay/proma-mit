# 桌面端 Span 采集与瀑布图（Desktop Span Sink）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Electron 桌面端的 Pi runtime 会话采集工具调用 span（begin/end 计时），落盘 JSONL，并在 Agent 会话头部提供「运行瀑布图」面板，复用 `@gravitas/server` 已有的 `RuntimeSpan` / `RuntimeSpanSink` 契约。

**Architecture:** 桌面端实现一个 JSONL 版 `RuntimeSpanSink`（server 侧已有 Postgres 版，接口共享）。Pi adapter 的 `session.subscribe` 回调新增 `tool_execution_start/end` 分支产出 tool span；query 主体包一层 task span（开始→finally 结束）。落盘 `~/.proma-mit/agent-spans/{YYYY-MM}.jsonl` 按月分文件（对齐 token-usage 模式）。读取走新 IPC 通道，UI 用纯 CSS 时间条渲染瀑布图（不引图表库，local-first）。

**Tech Stack:** TypeScript (Bun)、Electron IPC 四件套（shared 类型 → ipc.ts → preload → renderer）、React + Jotai、现有 Radix `ui/dialog`。

**关键取舍（已确认）：**
- **begin 只入内存，end 时写整行**：崩溃丢未完成 span（观测 best-effort，可接受）。
- **默认不存输入值/结果内容**：只存 `inputKeys`（参数键名）与 `isError`，对齐 server 侧「span 表只存轻量 meta」与脱敏精神。
- **provider span 第一版不做**：task + tool 两级已够瀑布图；model 记入 task span meta。
- **traceId 复用 sessionId**（对齐 server P-I 阶段做法）；taskId = task span 的 spanId（一次 query = 一个 run）。
- 桌面端 scope 填 `tenantId: 'local' / userId: 'local'`（无多租户概念，占位对齐契约）。

**测试隔离：** 所有落盘测试用 `process.env.PROMA_TEST_CONFIG_DIR` 覆盖（仓库既有模式，见 `apps/electron/src/main/lib/agent-registry-service.test.ts`）。

---

### Task 1: shared 包 — IPC 通道与查询类型

**Files:**
- Modify: `packages/shared/src/types/agent.ts`（`AGENT_IPC_CHANNELS` 常量区，约 1957 行起）
- Modify: `packages/shared/package.json`（version 0.1.70 → 0.1.71）

- [ ] **Step 1: 添加通道常量与查询类型**

在 `packages/shared/src/types/agent.ts` 中，`AGENT_IPC_CHANNELS` 内 `EXPORT_AUDIT_EVENTS` 行后追加：

```typescript
  /** 查询会话的运行 span（瀑布图数据源） */
  LIST_SESSION_SPANS: 'agent:list-session-spans',
```

在同一文件 `AgentAuditQuery` 接口（约 68 行）后追加类型：

```typescript
/** 会话运行 span 查询条件；返回类型复用 RuntimeSpan（runtime-span.ts）。 */
export interface AgentSpanQuery {
  /** 按会话过滤（省略 = 全部会话） */
  sessionId?: string
  /** 只返回 startedAt >= sinceMs 的 span */
  sinceMs?: number
  /** 最多返回条数（默认 500，读取按时间倒序裁剪后返回升序） */
  limit?: number
}
```

注意：`RuntimeSpan` 已从 `packages/shared/src/types/index.ts:16`（`export * from './runtime-span'`）根导出，renderer/main 直接 `import type { RuntimeSpan, AgentSpanQuery } from '@gravitas/shared'` 即可，无需新导出。

- [ ] **Step 2: 递增版本**

`packages/shared/package.json` 的 `"version": "0.1.70"` 改为 `"0.1.71"`。

- [ ] **Step 3: typecheck**

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/agent.ts packages/shared/package.json
git commit -m "feat(shared): 新增 agent span 查询 IPC 通道与类型"
```

---

### Task 2: config-paths — span 存储目录函数

**Files:**
- Modify: `apps/electron/src/main/lib/config-paths.ts`（`getTokenUsageIndexPath` 后，约 140 行处插入）

- [ ] **Step 1: 添加目录/文件路径函数**

在 `getTokenUsageIndexPath()` 函数后追加（模式对齐 `getTokenUsageDir` / `getTokenUsageMonthPath`）：

```typescript
/**
 * 获取 Agent 运行 span 目录路径
 *
 * @returns ~/.proma-mit/agent-spans/
 */
export function getAgentSpansDir(): string {
  const dir = join(getConfigDir(), 'agent-spans')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    console.log(`[配置] 已创建 Agent span 目录: ${dir}`)
  }
  return dir
}

/**
 * 获取指定时间所在月份的 Agent span 文件路径
 *
 * @param ts 毫秒时间戳
 * @returns ~/.proma-mit/agent-spans/{YYYY-MM}.jsonl
 */
export function getAgentSpanMonthPath(ts: number): string {
  const d = new Date(ts)
  const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  return join(getAgentSpansDir(), `${month}.jsonl`)
}
```

- [ ] **Step 2: typecheck**

Run: `cd apps/electron && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 3: Commit**

```bash
git add apps/electron/src/main/lib/config-paths.ts
git commit -m "feat(electron): agent span 按月 JSONL 存储路径"
```

---

### Task 3: agent-span-sink — JSONL 版 RuntimeSpanSink（TDD）

**Files:**
- Test: `apps/electron/src/main/lib/agent-span-sink.test.ts`（新建）
- Create: `apps/electron/src/main/lib/agent-span-sink.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * JSONLSpanSink 单元测试
 *
 * 覆盖：begin/end 配对落盘、错误 status、查询过滤、月度分文件、pending 不落盘。
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { JSONLLocalAgentSpanSink, listAgentSpans } = await import('./agent-span-sink')
const { getAgentSpanMonthPath } = await import('./config-paths')

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'gravitas-span-sink-'))
  process.env.PROMA_TEST_CONFIG_DIR = testDir
})

afterAll(() => {
  delete process.env.PROMA_TEST_CONFIG_DIR
  rmSync(testDir, { recursive: true, force: true })
})

const scope = { tenantId: 'local', userId: 'local' }

function makeSink() {
  return new JSONLLocalAgentSpanSink()
}

describe('JSONLLocalAgentSpanSink', () => {
  test('begin 后 pending 不落盘，end 后写入完整 span', async () => {
    const sink = makeSink()
    const spanId = 'span-tool-1'
    await sink.begin({
      ...scope,
      traceId: 'session-1',
      sessionId: 'session-1',
      taskId: 'task-1',
      spanId,
      kind: 'tool',
      name: 'tool:Bash',
      startedAt: Date.now(),
      meta: { model: 'deepseek-v4' },
    })
    // begin 只入内存：此时文件不存在或无该 span 行
    const before = await listAgentSpans({ sessionId: 'session-1' })
    expect(before.filter((s) => s.spanId === spanId)).toHaveLength(0)

    await sink.end(spanId, { status: 'ok', meta: { inputKeys: ['command'], durationMs: 120 } })
    const after = await listAgentSpans({ sessionId: 'session-1' })
    const span = after.find((s) => s.spanId === spanId)
    expect(span).toBeDefined()
    expect(span!.status).toBe('ok')
    expect(span!.endedAt).toBeGreaterThanOrEqual(span!.startedAt)
    expect(span!.meta?.inputKeys).toEqual(['command'])
  })

  test('end 未知 spanId 静默忽略（不抛错）', async () => {
    const sink = makeSink()
    await sink.end('not-exists', { status: 'error', error: 'x' })
    expect(true).toBe(true)
  })

  test('错误 status 携带 error 字段落盘', async () => {
    const sink = makeSink()
    const spanId = 'span-err'
    await sink.begin({
      ...scope, traceId: 'session-2', sessionId: 'session-2', taskId: 'task-2',
      spanId, kind: 'tool', name: 'tool:Write', startedAt: Date.now(),
    })
    await sink.end(spanId, { status: 'error', error: '权限拒绝' })
    const spans = await listAgentSpans({ sessionId: 'session-2' })
    const span = spans.find((s) => s.spanId === spanId)
    expect(span?.status).toBe('error')
    expect(span?.error).toBe('权限拒绝')
  })

  test('attachCost 为空实现（不抛错、不写盘）', async () => {
    const sink = makeSink()
    await sink.attachCost(scope, 'task-x', 123)
    expect(true).toBe(true)
  })

  test('查询支持 sinceMs 与 limit，结果按 startedAt 升序', async () => {
    const sink = makeSink()
    const base = Date.now() - 10_000
    for (let i = 0; i < 5; i++) {
      const spanId = `span-q-${i}`
      await sink.begin({
        ...scope, traceId: 'session-q', sessionId: 'session-q', taskId: 'task-q',
        spanId, kind: 'tool', name: `tool:T${i}`, startedAt: base + i * 100,
      })
      await sink.end(spanId, { status: 'ok' })
    }
    // sinceMs 过滤：只留后 3 条
    const recent = await listAgentSpans({ sessionId: 'session-q', sinceMs: base + 200 })
    expect(recent).toHaveLength(3)
    // 升序
    const times = recent.map((s) => s.startedAt)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // limit
    const limited = await listAgentSpans({ sessionId: 'session-q', limit: 2 })
    expect(limited).toHaveLength(2)
  })

  test('按月分文件：跨月 span 写入各自月份文件', async () => {
    const path = getAgentSpanMonthPath(Date.now())
    expect(path).toContain('agent-spans')
    expect(path.endsWith('.jsonl')).toBe(true)
    // 直接验证 listAgentSpans 读两个文件（当月 + 上月）
    const lastMonth = new Date()
    lastMonth.setMonth(lastMonth.getMonth() - 1)
    const oldPath = getAgentSpanMonthPath(lastMonth.getTime())
    // 手工造一条上月记录
    const { dirname } = await import('node:path')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dirname(oldPath), { recursive: true })
    if (!existsSync(oldPath)) writeFileSync(oldPath, '', 'utf-8')
    const raw = JSON.stringify({
      ...scope, traceId: 'session-old', sessionId: 'session-old', taskId: 'task-old',
      spanId: 'span-old', kind: 'task', name: 'task:pi:old',
      startedAt: lastMonth.getTime(), endedAt: lastMonth.getTime() + 100, status: 'ok',
    })
    writeFileSync(oldPath, `${raw}\n`, 'utf-8')
    const spans = await listAgentSpans({ sessionId: 'session-old' })
    expect(spans.find((s) => s.spanId === 'span-old')).toBeDefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/main/lib/agent-span-sink.test.ts`
Expected: FAIL — `Cannot resolve module './agent-span-sink'`。

- [ ] **Step 3: 实现 agent-span-sink.ts**

```typescript
/**
 * 桌面端 Agent 运行 span 采集（JSONL 版 RuntimeSpanSink）。
 *
 * 复用 @gravitas/server 的 RuntimeSpan / RuntimeSpanSink 契约（server 侧为
 * Postgres 实现）；桌面端按月落盘 JSONL，轻量、可移植、无数据库。
 *
 * 采集语义：
 * - begin 只入内存（pending Map）；end 时补全 endedAt/status 后整行落盘。
 *   崩溃丢失未完成 span——观测数据 best-effort，可接受。
 * - 只存轻量 meta（inputKeys/isError/durationMs），不存参数值与结果内容（脱敏）。
 * - attachCost 桌面端暂为空实现（成本统计由 token-usage-service 承担）。
 */

import { appendFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentRuntimeScope, AgentSpanQuery, RuntimeSpan, RuntimeSpanBegin, RuntimeSpanSink } from '@gravitas/shared'
import { getAgentSpansDir, getAgentSpanMonthPath } from './config-paths'

/** 查询默认条数上限。 */
const DEFAULT_SPAN_LIMIT = 500
/** 读取时回看的月份数（当月 + 上月，覆盖跨月边界查询）。 */
const READ_MONTHS_BACK = 2

/** 桌面端本地 scope：无多租户概念，固定占位对齐 AgentRuntimeScope 契约。 */
const LOCAL_SCOPE = { tenantId: 'local', userId: 'local' } as const

export class JSONLLocalAgentSpanSink implements RuntimeSpanSink {
  /** begin 后尚未 end 的 span（spanId → 完整 begin 数据）。 */
  private readonly pending = new Map<string, RuntimeSpanBegin>()

  async begin(span: RuntimeSpanBegin): Promise<void> {
    this.pending.set(span.spanId, span)
  }

  async end(spanId: string, patch: { status: RuntimeSpan['status']; error?: string; meta?: Record<string, unknown> }): Promise<void> {
    const begin = this.pending.get(spanId)
    // 未知 spanId（重复 end / 未 begin）：静默忽略，不阻断执行流。
    if (!begin) return
    this.pending.delete(spanId)
    const span: RuntimeSpan = {
      ...begin,
      ...LOCAL_SCOPE,
      endedAt: Date.now(),
      status: patch.status,
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      meta: { ...begin.meta, ...patch.meta },
    }
    try {
      appendFileSync(
        getAgentSpanMonthPath(span.startedAt),
        `${JSON.stringify(span)}\n`,
        'utf-8',
      )
    } catch (error) {
      // 落盘失败不能影响 Agent 执行；观测 best-effort。
      console.error('[AgentSpan] 写入 span 失败:', error)
    }
  }

  /** 桌面端成本统计由 token-usage-service 承担；此处空实现满足契约。 */
  async attachCost(_scope: AgentRuntimeScope, _taskId: string, _costMicroUsd: number): Promise<void> {
    void _scope; void _taskId; void _costMicroUsd
  }
}

/** 解析 JSONL 行为 RuntimeSpan；非法行静默跳过。 */
function parseSpanLine(line: string): RuntimeSpan | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<RuntimeSpan>
    if (
      typeof parsed.spanId !== 'string' ||
      typeof parsed.traceId !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.endedAt !== 'number' ||
      (parsed.status !== 'ok' && parsed.status !== 'error')
    ) {
      return null
    }
    return parsed as RuntimeSpan
  } catch {
    return null
  }
}

/**
 * 查询已落盘的 agent span。
 *
 * 读取当月起往前 READ_MONTHS_BACK 个月的月度文件，过滤后按 startedAt 升序返回
 * （瀑布图时间顺序）。limit 在倒序裁剪后应用，保证留下的是最近记录。
 */
export async function listAgentSpans(query: AgentSpanQuery = {}): Promise<RuntimeSpan[]> {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_SPAN_LIMIT
  const spansDir = getAgentSpansDir()
  let files: string[] = []
  try {
    files = readdirSync(spansDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  // 只回看最近 READ_MONTHS_BACK 个月（文件名为 YYYY-MM.jsonl，字典序即时间序）。
  const recent = files.sort().slice(-READ_MONTHS_BACK)
  const all: RuntimeSpan[] = []
  for (const name of recent) {
    let raw: string
    try {
      raw = readFileSync(join(spansDir, name), 'utf-8')
    } catch {
      continue
    }
    for (const line of raw.split('\n')) {
      const span = parseSpanLine(line)
      if (!span) continue
      if (query.sessionId && span.sessionId !== query.sessionId) continue
      if (query.sinceMs !== undefined && span.startedAt < query.sinceMs) continue
      all.push(span)
    }
  }
  const newest = all.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  return newest.sort((a, b) => a.startedAt - b.startedAt)
}

/** 模块级单例；orchestrator 通过此入口复用同一 sink。 */
let sharedSink: JSONLLocalAgentSpanSink | undefined

export function getAgentSpanSink(): JSONLLocalAgentSpanSink {
  sharedSink ??= new JSONLLocalAgentSpanSink()
  return sharedSink
}
```

注意：若 `RuntimeSpanBegin` 未从 `@gravitas/shared` 根导出（`runtime-span.ts` 中有 `export type RuntimeSpanBegin`，`types/index.ts` 已 `export * from './runtime-span'`，应可用；typecheck 报错时改从 `'@gravitas/shared'` 的既有导出组合 `Omit<RuntimeSpan, 'endedAt' | 'status'>`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/electron && bun test src/main/lib/agent-span-sink.test.ts`
Expected: 全部 PASS（6 tests）。

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/main/lib/agent-span-sink.ts apps/electron/src/main/lib/agent-span-sink.test.ts
git commit -m "feat(electron): JSONL 版 RuntimeSpanSink 与 span 查询"
```

---

### Task 4: pi-agent-adapter — tool/task span 采集接线

**Files:**
- Modify: `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`
  - `PiAgentQueryOptions`（30 行起）：新增 `spanSink` 字段
  - `query()` 主体（167 行起）：task span begin/end + subscribe 新分支
- Modify: `apps/electron/src/main/lib/agent-orchestrator.ts`（约 1051 行 `queryOptions` 组装处）

- [ ] **Step 1: PiAgentQueryOptions 增加字段**

`pi-agent-adapter.ts` 的 `PiAgentQueryOptions`（`isDelegationSession` 字段后）追加：

```typescript
  /** 运行 span 采集 sink（JSONL 版）；缺省不采集。 */
  spanSink?: RuntimeSpanSink
```

文件头部 import 区（`import type { AgentSession, AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'` 附近）追加：

```typescript
import type { RuntimeSpan, RuntimeSpanSink } from '@gravitas/shared'
```

- [ ] **Step 2: query() 主体接 task span + subscribe 接 tool span**

**插入点：`session.agent.toolExecution = 'sequential'`（约 357 行）之后、`const queue = createAsyncQueue<SDKMessage>()` 之前。** 此时 `workspaceSlug`（options 解构值，可能为 undefined）与 `customTools` 均已可用，且位于历史消息恢复之前——历史恢复耗时也计入 task span，符合「一次 query = 一个 run」语义：

```typescript
    // ===== 运行 span 采集：task 级 =====
    // traceId 复用 sessionId（对齐 server P-I 阶段做法）；taskId = task span 自身。
    const spanSink = input.spanSink
    const taskSpanId = spanSink ? randomUUID() : undefined
    let queryHadError = false
    if (spanSink && taskSpanId) {
      void spanSink.begin({
        tenantId: 'local',
        userId: 'local',
        traceId: sessionId,
        sessionId,
        taskId: taskSpanId,
        spanId: taskSpanId,
        kind: 'task',
        name: `task:pi:${model}`,
        startedAt: Date.now(),
        parentSpanId: undefined,
        meta: {
          model,
          provider,
          channelId: input.channelId,
          workspaceSlug,
          triggeredBy: triggeredBy ?? 'user',
          isDelegationSession: isDelegationSession ?? false,
        },
      }).catch(() => {})
    }
```

说明：`randomUUID` 已在文件中导入（`assistantUuidFor()` 使用）；`triggeredBy` / `isDelegationSession` / `workspaceSlug` 均已从 `input` 解构（168 行）；`input.channelId` 直接访问（未解构）。

在 subscribe 回调（`session.subscribe((event: AgentSessionEvent) => {...}`，384 行起）的 `tool_execution_update` 分支（441 行）后追加两个分支。注意回调开头 `if (event.type === 'message_update' ...)` 等分支结构保持不变，新分支插入在 `tool_execution_update` 分支之后、回调结束之前：

```typescript
      if (event.type === 'tool_execution_start') {
        touchActivity()
        // tool span：begin 入内存；inputKeys 只存参数键名（脱敏，不存值）。
        void spanSink?.begin({
          tenantId: 'local',
          userId: 'local',
          traceId: sessionId,
          sessionId,
          taskId: taskSpanId ?? sessionId,
          parentSpanId: taskSpanId,
          spanId: event.toolCallId,
          kind: 'tool',
          name: `tool:${event.toolName}`,
          startedAt: Date.now(),
          meta: { inputKeys: Object.keys((event.args as Record<string, unknown> | undefined) ?? {}) },
        }).catch(() => {})
        return
      }
      if (event.type === 'tool_execution_end') {
        touchActivity()
        void spanSink?.end(event.toolCallId, {
          status: event.isError ? 'error' : 'ok',
          ...(event.isError ? { error: `工具 ${event.toolName} 执行失败` } : {}),
          meta: { toolName: event.toolName },
        }).catch(() => {})
        return
      }
```

说明：durationMs 不在 patch.meta 里重复给值——sink 的 `endedAt - startedAt` 已推导耗时，end 时无需回填。

在 query() 收尾的 `finally`（现有 `finally { partialAssistantCoalescer.dispose(); this.releaseSession(sessionId); mcpRelease?.() }`，588 行）扩展为：

```typescript
    } finally {
      partialAssistantCoalescer.dispose()
      this.releaseSession(sessionId)
      mcpRelease?.()
      // task span 收尾：query 抛错时标 error；结束时刻由 sink 补全。
      if (spanSink && taskSpanId) {
        void spanSink.end(taskSpanId, {
          status: queryHadError ? 'error' : 'ok',
          ...(queryHadError ? { error: 'Pi 运行提前终止' } : {}),
          meta: { model },
        }).catch(() => {})
      }
    }
```

`queryHadError` 置位：`void retryablePromptChain().then(() => queue.close()).catch(...)`（580 行）改为：

```typescript
      void retryablePromptChain()
        .then(() => queue.close())
        .catch((error: unknown) => {
          queryHadError = true
          queue.fail(error)
        })
```

- [ ] **Step 3: orchestrator 注入 sink**

`agent-orchestrator.ts` 的 Pi `queryOptions`（约 947 行 `const queryOptions: PiAgentQueryOptions = {`）内，`onAgentEvent` 字段后追加：

```typescript
        // 运行 span 采集：复用模块级 JSONL sink 单例
        spanSink: getAgentSpanSink(),
```

文件头部 import 区追加：

```typescript
import { getAgentSpanSink } from './agent-span-sink'
```

- [ ] **Step 4: typecheck**

Run: `cd apps/electron && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 5: 既有测试回归**

Run: `cd apps/electron && bun test src/main/lib/adapters/`
Expected: 既有 pi-tool-bridge / adapter 相关测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/electron/src/main/lib/adapters/pi-agent-adapter.ts apps/electron/src/main/lib/agent-orchestrator.ts
git commit -m "feat(electron): Pi runtime 采集 tool/task span"
```

---

### Task 5: IPC 三件套 — handler / preload

**Files:**
- Modify: `apps/electron/src/main/ipc.ts`（`LIST_AUDIT_EVENTS` handler 后，约 1890 行）
- Modify: `apps/electron/src/preload/index.ts`（类型声明区约 660 行 + 实现区约 2175 行）

- [ ] **Step 1: ipc.ts 注册 handler**

`ipc.ts` 中 `AGENT_IPC_CHANNELS.LIST_AUDIT_EVENTS` handler 行后追加：

```typescript
  ipcMain.handle(AGENT_IPC_CHANNELS.LIST_SESSION_SPANS, async (_, query: import('@gravitas/shared').AgentSpanQuery = {}) => listAgentSpans(query))
```

import 区追加：

```typescript
import { listAgentSpans } from './lib/agent-span-sink'
```

（对齐既有 `listAgentAuditEvents` 的 `./lib/agent-audit-service` 导入模式。）

- [ ] **Step 2: preload 暴露 API**

`preload/index.ts` 类型声明区（`listAgentAuditEvents` 声明后）追加：

```typescript
  /** 查询会话运行 span（瀑布图数据源；仅本机 JSONL） */
  listAgentSpans: (query?: AgentSpanQuery) => Promise<RuntimeSpan[]>
```

实现区（`listAgentAuditEvents` 实现行后）追加：

```typescript
  listAgentSpans: (query: AgentSpanQuery = {}) => ipcRenderer.invoke(AGENT_IPC_CHANNELS.LIST_SESSION_SPANS, query),
```

文件头部 type import 区追加 `AgentSpanQuery`、`RuntimeSpan`（若尚未导入）：从 `@gravitas/shared`。

- [ ] **Step 3: typecheck**

Run: `cd apps/electron && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 4: Commit**

```bash
git add apps/electron/src/main/ipc.ts apps/electron/src/preload/index.ts
git commit -m "feat(electron): listAgentSpans IPC 通道"
```

---

### Task 6: span-timeline 纯函数 + 测试（TDD）

**Files:**
- Test: `apps/electron/src/renderer/lib/span-timeline.test.ts`（新建）
- Create: `apps/electron/src/renderer/lib/span-timeline.ts`（新建）

- [ ] **Step 1: 写失败测试**

```typescript
/**
 * span-timeline 瀑布图布局纯函数测试。
 */

import { describe, test, expect } from 'bun:test'
import { buildSpanTimeline, groupSpansByRun } from './span-timeline'
import type { RuntimeSpan } from '@gravitas/shared'

function makeSpan(over: Partial<RuntimeSpan>): RuntimeSpan {
  return {
    tenantId: 'local', userId: 'local',
    traceId: 's1', sessionId: 's1', taskId: 'run-1',
    spanId: 'sp', kind: 'tool', name: 'tool:Bash',
    startedAt: 0, endedAt: 100, status: 'ok',
    ...over,
  } as RuntimeSpan
}

describe('groupSpansByRun', () => {
  test('按 taskId 分组，run 按时间倒序，组内升序', () => {
    const spans = [
      makeSpan({ spanId: 'a', taskId: 'run-1', startedAt: 100, kind: 'task', name: 'task:pi:m' }),
      makeSpan({ spanId: 'b', taskId: 'run-2', startedAt: 500, kind: 'task', name: 'task:pi:m' }),
      makeSpan({ spanId: 'c', taskId: 'run-1', startedAt: 150 }),
      makeSpan({ spanId: 'd', taskId: 'run-2', startedAt: 550 }),
    ]
    const runs = groupSpansByRun(spans)
    expect(runs.map((r) => r.taskId)).toEqual(['run-2', 'run-1'])
    expect(runs[0].spans.map((s) => s.spanId)).toEqual(['b', 'd'])
  })
})

describe('buildSpanTimeline', () => {
  test('计算 leftPct/widthPct，task 行 depth 0，tool 行 depth 1', () => {
    const run = [
      makeSpan({ spanId: 'task', kind: 'task', name: 'task:pi:m', startedAt: 0, endedAt: 1000 }),
      makeSpan({ spanId: 't1', startedAt: 100, endedAt: 400, parentSpanId: 'task' }),
      makeSpan({ spanId: 't2', startedAt: 500, endedAt: 900, parentSpanId: 'task' }),
    ]
    const rows = buildSpanTimeline(run)
    expect(rows).toHaveLength(3)
    const t1 = rows.find((r) => r.span.spanId === 't1')!
    expect(t1.leftPct).toBe(10)
    expect(t1.widthPct).toBe(30)
    expect(t1.depth).toBe(1)
    const task = rows.find((r) => r.span.spanId === 'task')!
    expect(task.depth).toBe(0)
    expect(task.widthPct).toBe(100)
  })

  test('零时长 run 不产生 NaN（最小宽度兜底）', () => {
    const run = [makeSpan({ spanId: 'z', kind: 'task', startedAt: 50, endedAt: 50 })]
    const rows = buildSpanTimeline(run)
    expect(Number.isFinite(rows[0].widthPct)).toBe(true)
  })

  test('durationMs 正确计算', () => {
    const run = [makeSpan({ spanId: 'd', startedAt: 0, endedAt: 1500 })]
    const rows = buildSpanTimeline(run)
    expect(rows[0].durationMs).toBe(1500)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/electron && bun test src/renderer/lib/span-timeline.test.ts`
Expected: FAIL — `Cannot resolve module './span-timeline'`。

- [ ] **Step 3: 实现 span-timeline.ts**

```typescript
/**
 * Span 瀑布图布局纯函数。
 *
 * 输入一次 run 的 RuntimeSpan 列表，输出时间条布局（百分比）；
 * 与渲染解耦，便于独立测试。
 */

import type { RuntimeSpan } from '@gravitas/shared'

/** 一次 run（同 taskId）的分组。 */
export interface SpanRunGroup {
  taskId: string
  /** 组内按 startedAt 升序。 */
  spans: RuntimeSpan[]
  /** run 起止（组内最早 start / 最晚 end）。 */
  startedAt: number
  endedAt: number
}

/** 单行瀑布布局。 */
export interface SpanTimelineRow {
  span: RuntimeSpan
  /** 时间条左偏移百分比（相对 run 总时长）。 */
  leftPct: number
  /** 时间条宽度百分比；最小 0.5 防止零宽不可见。 */
  widthPct: number
  /** 层级：task 行 0，tool 行 1。 */
  depth: number
  /** 耗时毫秒。 */
  durationMs: number
}

/** 按 taskId 分组；run 按开始时间倒序（最近在前），组内升序。 */
export function groupSpansByRun(spans: RuntimeSpan[]): SpanRunGroup[] {
  const byTask = new Map<string, RuntimeSpan[]>()
  for (const span of spans) {
    const list = byTask.get(span.taskId) ?? []
    list.push(span)
    byTask.set(span.taskId, list)
  }
  const groups: SpanRunGroup[] = []
  for (const [taskId, list] of byTask) {
    const sorted = [...list].sort((a, b) => a.startedAt - b.startedAt)
    const startedAt = sorted[0]?.startedAt ?? 0
    const endedAt = sorted.reduce((max, s) => Math.max(max, s.endedAt), startedAt)
    groups.push({ taskId, spans: sorted, startedAt, endedAt })
  }
  return groups.sort((a, b) => b.startedAt - a.startedAt)
}

/** 计算一次 run 内所有 span 的时间条布局。 */
export function buildSpanTimeline(run: RuntimeSpan[]): SpanTimelineRow[] {
  if (run.length === 0) return []
  const runStart = Math.min(...run.map((s) => s.startedAt))
  const runEnd = Math.max(...run.map((s) => s.endedAt), runStart)
  const total = Math.max(runEnd - runStart, 1)
  return [...run]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((span) => {
      const durationMs = Math.max(span.endedAt - span.startedAt, 0)
      const widthPct = Math.max((durationMs / total) * 100, 0.5)
      const leftPct = Math.min(((span.startedAt - runStart) / total) * 100, 100 - widthPct)
      return {
        span,
        leftPct,
        widthPct,
        depth: span.kind === 'task' ? 0 : 1,
        durationMs,
      }
    })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/electron && bun test src/renderer/lib/span-timeline.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/electron/src/renderer/lib/span-timeline.ts apps/electron/src/renderer/lib/span-timeline.test.ts
git commit -m "feat(electron): span 瀑布图布局纯函数"
```

---

### Task 7: SpanWaterfallPanel UI 组件 + AgentHeader 入口

**Files:**
- Create: `apps/electron/src/renderer/components/agent/SpanWaterfallPanel.tsx`（新建）
- Modify: `apps/electron/src/renderer/components/agent/AgentHeader.tsx`（`GoalBindingControl` 渲染处，约 169 行）

- [ ] **Step 1: 实现 SpanWaterfallPanel.tsx**

```tsx
/**
 * 会话运行瀑布图面板。
 *
 * 从本机 JSONL 读取当前会话的运行 span，按 run 分组渲染时间条瀑布；
 * 纯 CSS 实现（无图表库），local-first。
 */

import * as React from 'react'
import type { RuntimeSpan } from '@gravitas/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Activity, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildSpanTimeline, groupSpansByRun, type SpanRunGroup } from '@/lib/span-timeline'

/** 格式化耗时：<1s 用 ms，否则 s 保留 1 位。 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** 单个 run 的瀑布渲染。 */
function RunWaterfall({ run }: { run: SpanRunGroup }): React.ReactElement {
  const rows = buildSpanTimeline(run.spans)
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <ChevronRight className="size-3" />
        <span>{formatTime(run.startedAt)}</span>
        <span>·</span>
        <span>{run.spans.length} spans</span>
      </div>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <Tooltip key={row.span.spanId}>
            <TooltipTrigger asChild>
              <div className="group flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    'w-40 shrink-0 truncate text-right font-mono',
                    row.depth === 0 ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  )}
                  style={{ paddingLeft: row.depth * 12 }}
                >
                  {row.span.name}
                </span>
                <div className="relative h-3 flex-1 overflow-hidden rounded-sm bg-muted">
                  <div
                    className={cn(
                      'absolute h-full rounded-sm',
                      row.span.status === 'error'
                        ? 'bg-red-500/70'
                        : row.depth === 0
                          ? 'bg-primary/70'
                          : 'bg-primary/40',
                    )}
                    style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
                  />
                </div>
                <span className="w-14 shrink-0 text-right font-mono text-muted-foreground">
                  {formatDuration(row.durationMs)}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p className="font-mono text-xs">{row.span.name}</p>
              <p className="text-xs">
                {formatTime(row.span.startedAt)} → {formatTime(row.span.endedAt)} ·{' '}
                {row.span.status === 'error' ? `失败: ${row.span.error ?? ''}` : '成功'}
              </p>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

export function SpanWaterfallPanel({ sessionId }: { sessionId: string }): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [runs, setRuns] = React.useState<SpanRunGroup[]>([])
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(async () => {
    setLoading(true)
    try {
      const spans: RuntimeSpan[] = await window.electronAPI.listAgentSpans({ sessionId, limit: 500 })
      setRuns(groupSpansByRun(spans))
    } catch (error) {
      console.error('[SpanWaterfall] 加载 span 失败:', error)
      setRuns([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="titlebar-no-drag h-7 w-7 flex-shrink-0"
              aria-label="运行瀑布图"
            >
              <Activity className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom"><p>运行瀑布图（工具调用耗时）</p></TooltipContent>
        </Tooltip>
      </DialogTrigger>
      <DialogContent className="max-h-[70vh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>运行瀑布图</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[52vh] pr-3">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">加载中…</p>
          ) : runs.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              当前会话暂无运行记录（新会话首次运行后生成）
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {runs.map((run) => (
                <RunWaterfall key={run.taskId} run={run} />
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: AgentHeader 挂载入口**

`AgentHeader.tsx` 中 `<GoalBindingControl sessionId={sessionId} />`（约 169 行）后插入：

```tsx
          <SpanWaterfallPanel sessionId={sessionId} />
```

文件头部 import 区追加：

```typescript
import { SpanWaterfallPanel } from './SpanWaterfallPanel'
```

- [ ] **Step 3: typecheck**

Run: `cd apps/electron && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 4: Commit**

```bash
git add apps/electron/src/renderer/components/agent/SpanWaterfallPanel.tsx apps/electron/src/renderer/components/agent/AgentHeader.tsx
git commit -m "feat(electron): 会话运行瀑布图面板"
```

---

### Task 8: 收尾 — 版本、回归、手动验证

**Files:**
- Modify: `apps/electron/package.json`（version 0.11.58 → 0.11.59）

- [ ] **Step 1: 递增 electron 版本**

`"version": "0.11.58"` 改为 `"0.11.59"`。

- [ ] **Step 2: 全量回归**

Run: `cd apps/electron && bun run typecheck && bun test src/main/lib/agent-span-sink.test.ts src/renderer/lib/span-timeline.test.ts src/main/lib/adapters/`
Expected: typecheck 无错误；三个测试文件全部 PASS。

Run: `cd packages/shared && bun run typecheck`
Expected: 无错误退出。

- [ ] **Step 3: 手动验证（开发模式）**

Run: `bun run dev`（仓库根目录）
验证清单：
1. 打开任一 Pi runtime 会话，发送一条会触发工具调用的消息（如「读取 README.md」）。
2. 消息完成后点击会话头部「运行瀑布图」图标。
3. 预期：面板显示本次 run，task 行（全宽主色）+ tool 行（Read/Bash 等，含耗时）；失败的 span 显示红色。
4. `cat ~/.proma-mit/agent-spans/*.jsonl | head -3` 应有合法 JSON 行（含 spanId/startedAt/endedAt/status/meta.inputKeys）。

- [ ] **Step 4: Commit**

```bash
git add apps/electron/package.json
git commit -m "chore(electron): bump version 0.11.59"
```

---

## Self-Review 结论

- **Spec 覆盖**：采集（Task 3/4）→ 落盘（Task 2/3）→ 查询（Task 3/5）→ 可视化（Task 6/7）→ 回归（Task 8），全部对应。CLAUDE.md 更新留待用户确认后单独提交（按项目规约需经允许）。
- **占位符扫描**：无 TBD/TODO；所有步骤含完整代码。
- **类型一致性**：`JSONLLocalAgentSpanSink`/`getAgentSpanSink`/`listAgentSpans`（Task 3 定义，Task 4/5 消费）；`AgentSpanQuery`（Task 1 定义，Task 3/5 消费）；`groupSpansByRun`/`buildSpanTimeline`/`SpanRunGroup`（Task 6 定义，Task 7 消费）——已逐一核对命名一致。
- **风险提示**：Task 4 的 `RuntimeSpanBegin` 根导出可用性已注明 fallback；Pi `AgentSessionEvent` 含 `tool_execution_start/end`（已在 `pi-agent-core/dist/types.d.ts:390-406` 验证，`Exclude` 仅排除 `agent_end`）。
