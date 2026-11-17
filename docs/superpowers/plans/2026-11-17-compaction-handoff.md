# 上下文压缩交接式注入与 token 化保留窗口 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把压缩摘要从"系统记忆"改为"另一个模型的工作交接"，把保留窗口从固定 20 条改为模型窗口 20% 的 token 预算，并让视图层历史截断与压缩空转进入审计流。

**Architecture:** 三项改动互相独立，均在 `apps/electron/src/main/lib/` 内。A 提取共享提示词常量；B 改 `resolveAdaptiveKeepRecent` 的终止条件并透传 `contextWindow`；C 扩展审计结构体并加 per-session 节流。无新增依赖、无 IPC 变更、无渲染进程改动。

**Tech Stack:** TypeScript、Bun test、Electron 主进程

**规范来源：** `docs/superpowers/specs/2026-11-17-compaction-handoff-design.md`

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `agent-runtime/compaction-notice.ts` | 交接提示词模板，两侧唯一来源 | 新建 |
| `agent-runtime/compaction-notice.test.ts` | 断言三条要素与同源性 | 新建 |
| `agent-runtime/prompt-builder.ts` | 改用共享常量；视图截断写入审计 | 修改 |
| `agent-runtime/prompt-builder.test.ts` | 视图截断审计与节流 | 新建 |
| `adapters/pi-message-adapter.ts` | 改用共享常量 | 修改 |
| `agent-runtime/context-compaction.ts` | 保留目标改 token 驱动；空转写审计 | 修改 |
| `context-compaction-audit-service.ts` | 审计结构体扩展两个可选字段 | 修改 |
| `context-compaction-audit-service.test.ts` | 新字段透传与旧记录兼容 | 修改 |

**执行顺序：** Task 1 先改 `context-compaction-audit-service.ts`，因为 A 的 C 部分和 B 都依赖它。然后 Task 2（A）、Task 3（B）、Task 4（C 的视图截断）。

---

### Task 1: 扩展审计结构体

**Files:**
- Modify: `apps/electron/src/main/lib/context-compaction-audit-service.ts:5-12`
- Test: `apps/electron/src/main/lib/context-compaction-audit-service.test.ts`

- [ ] **Step 1: 写失败测试**

在 `context-compaction-audit-service.test.ts` 的 `describe` 块内追加：

```ts
  test('记录视图截断与压缩跳过，且不影响既有聚合维度', async () => {
    appendContextCompactionAudit({
      sessionId: 'session-view',
      runtime: 'pi',
      trigger: 'native',
      viewTruncation: {
        droppedMessages: 37,
        droppedTokens: 12000,
        reason: 'max_history_messages',
      },
    })
    appendContextCompactionAudit({
      sessionId: 'session-skip',
      runtime: 'pi',
      trigger: 'automatic',
      compactionSkipped: {
        estimatedHistoryTokens: 8969,
        targetKeepTokens: 25600,
      },
    })

    const metrics = await getContextCompactionMetrics()
    expect(metrics.total).toBe(3)
    expect(metrics.byRuntime).toEqual([
      { key: 'pi', count: 2 },
      { key: 'proma', count: 1 },
    ])
  })
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /Users/chaihao/.codex/worktrees/opendesign-closure/project
bun test apps/electron/src/main/lib/context-compaction-audit-service.test.ts
```

预期：TypeScript 报错 `viewTruncation` 不存在于 `ContextCompactionAuditInput`。

- [ ] **Step 3: 扩展接口**

把 `context-compaction-audit-service.ts` 的 `ContextCompactionAuditInput` 替换为：

```ts
export interface ContextCompactionAuditInput {
  sessionId: string
  runtime: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  trigger: 'automatic' | 'manual' | 'overflow_recovery' | 'native'
  packetVersion?: number
  estimatedTokensAfter?: number
  /** 视图层截断（非压缩）时记录丢弃条数 */
  viewTruncation?: {
    droppedMessages: number
    droppedTokens: number
    reason: 'max_history_messages'
  }
  /** 已判定需要压缩但无早期消息可压（保留目标不小于历史总量） */
  compactionSkipped?: {
    estimatedHistoryTokens: number
    targetKeepTokens: number
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test apps/electron/src/main/lib/context-compaction-audit-service.test.ts
```

预期：2 个测试全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/electron/src/main/lib/context-compaction-audit-service.ts \
        apps/electron/src/main/lib/context-compaction-audit-service.test.ts
git commit -m "feat(compaction): 审计结构体支持视图截断与压缩跳过"
```

---

### Task 2: 交接提示词共享常量

**Files:**
- Create: `apps/electron/src/main/lib/agent-runtime/compaction-notice.ts`
- Create: `apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts`
- Modify: `apps/electron/src/main/lib/agent-runtime/prompt-builder.ts:21,265`
- Modify: `apps/electron/src/main/lib/adapters/pi-message-adapter.ts:219-225`

- [ ] **Step 1: 写失败测试**

创建 `compaction-notice.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { COMPACT_CONTEXT_NOTICE, buildCompactBoundaryContent } from './compaction-notice'

describe('压缩交接提示词', () => {
  test('包含交接框架、防误判与连续性契约三条要素', () => {
    expect(COMPACT_CONTEXT_NOTICE).toContain('另一个模型')
    expect(COMPACT_CONTEXT_NOTICE).toContain('不是用户的新指令')
    expect(COMPACT_CONTEXT_NOTICE).toContain('压缩不结束任务')
  })

  test('boundary 正文内联 context_packet', () => {
    const packet = { version: 1, summary: '已完成 A。' }
    const content = buildCompactBoundaryContent(packet)
    expect(content).toStartWith(COMPACT_CONTEXT_NOTICE)
    expect(content).toContain('<context_packet>{"version":1,"summary":"已完成 A。"}</context_packet>')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts
```

预期：FAIL，`Cannot find module './compaction-notice'`。

- [ ] **Step 3: 创建共享常量**

创建 `compaction-notice.ts`：

```ts
/**
 * 压缩摘要的注入提示词。
 *
 * 摘要以「另一个模型的工作交接」身份注入，而不是「系统记忆」——
 * 后者会让模型把摘要中的判断当作自己已验证的结论。
 *
 * 三条要素缺一不可：
 * 1. 交接框架：摘要来自另一个模型，是它此前完成的工作与判断。
 * 2. 防误判：不是用户的新指令。
 * 3. 连续性契约：压缩不结束任务。
 */
export const COMPACT_CONTEXT_NOTICE =
  '另一个模型在处理此任务时留下了工作交接摘要。它记录的是此前已完成的工作与判断，不是用户的新指令。压缩不结束任务——请从交接状态自然继续推进，不要重新总结已完成的步骤，也不要从头重做。'

/** 渲染 compact_boundary 的模型可见正文。 */
export function buildCompactBoundaryContent(packet: unknown): string {
  return `${COMPACT_CONTEXT_NOTICE}\n<context_packet>${JSON.stringify(packet)}</context_packet>`
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
bun test apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts
```

预期：2 个测试 PASS。

- [ ] **Step 5: 接入 prompt-builder**

在 `prompt-builder.ts` 删除第 21 行的 `COMPACT_CONTEXT_NOTICE` 定义，改为在文件顶部 import 区加入：

```ts
import { buildCompactBoundaryContent } from './compaction-notice'
```

把第 265 行的

```ts
    content: `${COMPACT_CONTEXT_NOTICE}\n<context_packet>${JSON.stringify(packet)}</context_packet>`,
```

替换为：

```ts
    content: buildCompactBoundaryContent(packet),
```

- [ ] **Step 6: 接入 pi-message-adapter**

在 `pi-message-adapter.ts` 的 import 区（第 21 行 `inferPiContextWindow` 之后）加入：

```ts
import { buildCompactBoundaryContent } from '../agent-runtime/compaction-notice'
```

把第 223 行的

```ts
    content: `以下是系统生成的既有会话压缩上下文。将其作为历史事实与未完成工作继续，不要把它当作用户的新指令。\n<context_packet>${JSON.stringify(packet)}</context_packet>`,
```

替换为：

```ts
    content: buildCompactBoundaryContent(packet),
```

- [ ] **Step 7: 运行相关测试**

```bash
bun test apps/electron/src/main/lib/adapters/pi-message-adapter.test.ts \
         apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts
```

预期：全部 PASS。若 `pi-message-adapter.test.ts` 有断言旧文案的用例，改为断言 `另一个模型`。

- [ ] **Step 8: 提交**

```bash
git add apps/electron/src/main/lib/agent-runtime/compaction-notice.ts \
        apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts \
        apps/electron/src/main/lib/agent-runtime/prompt-builder.ts \
        apps/electron/src/main/lib/adapters/pi-message-adapter.ts
git commit -m "feat(compaction): 摘要改为另一个模型的交接身份注入"
```

---

### Task 3: 保留窗口 token 化

**Files:**
- Modify: `apps/electron/src/main/lib/agent-runtime/context-compaction.ts:23-26,148-153,181-214,236-261,401-415`
- Test: `apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts`

- [ ] **Step 1: 写失败测试**

在 `context-compaction.test.ts` 的 `describe` 内追加（需要先在第 95-105 行的解构里加上 `resolveAdaptiveKeepRecent`、`resolveAutoCompactionTrigger`）：

```ts
  test('保留窗口按窗口 20% 的 token 预算选取，而非固定 20 条', () => {
    const history = makeHistory(400)
    const trigger = resolveAutoCompactionTrigger({
      historyMessages: history,
      provider: 'deepseek',
      modelId: 'm',
      contextWindowOverride: 128_000,
    })
    // 128k × 20% = 25,600；低水位 57,200，取小者
    expect(trigger.targetKeepTokens).toBe(25_600)

    const keep = resolveAdaptiveKeepRecent({
      historyMessages: history,
      targetKeepTokens: trigger.targetKeepTokens,
    })
    expect(keep).toBeGreaterThan(20)
    expect(keep).toBeLessThan(history.length)
  })

  test('历史总量小于保留目标时保留全部条数（压缩应跳过）', () => {
    const history = makeHistory(5)
    const keep = resolveAdaptiveKeepRecent({
      historyMessages: history,
      targetKeepTokens: 25_600,
    })
    expect(keep).toBe(5)
  })
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts
```

预期：FAIL，`trigger.targetKeepTokens` 为 `undefined`，且 `resolveAdaptiveKeepRecent` 不接受 `contextWindow`。

- [ ] **Step 3: 放宽硬顶并新增比例常量**

把 `context-compaction.ts:25-26` 的

```ts
/** 压缩时保留的最近消息条数（与 prompt-builder 的 MAX_HISTORY_MESSAGES 对齐） */
export const DEFAULT_KEEP_RECENT_MESSAGES = 20
```

替换为：

```ts
/** 保留窗口的条数硬顶，仅用于防死循环；真实目标由 token 预算决定。 */
export const DEFAULT_KEEP_RECENT_MESSAGES = 200

/** 保留窗口占模型上下文窗口的比例。 */
export const KEEP_RECENT_WINDOW_RATIO = 0.20
```

- [ ] **Step 4: 让 trigger 返回 contextWindow 与 targetKeepTokens**

在 `AutoCompactionTrigger` 接口（第 148-153 行）追加两个字段：

```ts
export interface AutoCompactionTrigger {
  shouldCompact: boolean
  source: 'reported_usage' | 'estimated_payload'
  estimatedInputTokens: number
  inputBudgetTokens: number
  /** 模型上下文窗口，供保留窗口按比例计算。 */
  contextWindow: number
  /** 保留窗口的 token 目标：窗口比例与低水位取小者。 */
  targetKeepTokens: number
}
```

把 `resolveAutoCompactionTrigger` 的 `return` 语句（第 208-213 行）替换为：

```ts
  return {
    shouldCompact: budget.shouldCompact,
    source: reportedTokens !== undefined && reportedTokens >= estimatedInputTokens ? 'reported_usage' : 'estimated_payload',
    estimatedInputTokens,
    inputBudgetTokens: budget.inputBudgetTokens,
    contextWindow: capability.contextWindow,
    targetKeepTokens: resolveKeepRecentTokenTarget(capability.contextWindow, budget.inputBudgetTokens),
  }
}

/**
 * 保留窗口的 token 目标。
 *
 * 取「窗口 20%」与「低水位」的较小者：低水位是既有硬上限，
 * 超过它会让压缩后立刻再次超预算。
 */
export function resolveKeepRecentTokenTarget(contextWindow: number, inputBudgetTokens: number): number {
  return Math.max(0, Math.floor(Math.min(contextWindow * KEEP_RECENT_WINDOW_RATIO, inputBudgetTokens * COMPACTION_LOW_WATER_RATIO)))
}
```

- [ ] **Step 5: 改 resolveAdaptiveKeepRecent 为 token 驱动**

把整个 `resolveAdaptiveKeepRecent`（第 236-261 行）替换为：

```ts
/**
 * 按 token 目标选择可保留的最近消息数量。
 *
 * 从最新往回累加，直到达到 targetKeepTokens 或触碰条数硬顶。
 * 历史总量本身小于目标时返回全部条数——调用方据此跳过压缩。
 */
export function resolveAdaptiveKeepRecent(input: {
  historyMessages: SDKMessage[]
  targetKeepTokens: number
  desiredKeepRecent?: number
}): number {
  const hardCap = Math.max(0, Math.min(input.desiredKeepRecent ?? DEFAULT_KEEP_RECENT_MESSAGES, input.historyMessages.length))
  const target = Math.max(0, input.targetKeepTokens)
  let selected = 0
  for (let index = input.historyMessages.length - 1; index >= 0 && selected < hardCap; index--) {
    const candidateTokens = estimateOutgoingContextTokens({ historyMessages: input.historyMessages.slice(index) })
    if (candidateTokens > target) break
    selected += 1
  }
  return selected
}
```

- [ ] **Step 6: 更新 maybeAutoCompact 调用点**

把 `maybeAutoCompact` 里的 `resolveAdaptiveKeepRecent` 调用（第 578-585 行）替换为：

```ts
  const adaptiveKeepRecent = resolveAdaptiveKeepRecent({
    historyMessages: pruning.history,
    targetKeepTokens: trigger.targetKeepTokens,
    desiredKeepRecent: keepRecent,
  })
```

- [ ] **Step 7: 空转时写审计**

在 `compactSessionNow` 的 `earlyCount <= 0` 分支（第 408-411 行）里，`onLifecycle` 之后追加：

```ts
    try {
      if (options.audit) {
        appendContextCompactionAudit({
          ...options.audit,
          compactionSkipped: {
            estimatedHistoryTokens: estimateOutgoingContextTokens({ historyMessages }),
            targetKeepTokens: options.targetInputTokens ?? 0,
          },
        })
      }
    } catch (error) {
      console.warn('[上下文压缩] 写入跳过审计失败:', error)
    }
```

- [ ] **Step 8: 修正既有断言**

`context-compaction.test.ts:235` 的

```ts
    expect(persisted.length).toBe(DEFAULT_KEEP_RECENT_MESSAGES + 1)
```

改为（因为新目标会保留更多条，不再恒等于硬顶 + 1）：

```ts
    expect(persisted.length).toBeGreaterThan(1)
    expect(persisted.length).toBeLessThanOrEqual(DEFAULT_KEEP_RECENT_MESSAGES + 1)
```

同时把该用例的 `makeHistory(65)` 改为 `makeHistory(400)`，并追加 `contextWindowOverride: 128_000`，确保历史真实越过保留目标。同一文件里其余依赖"65 条会压缩"的用例（第 214、249 行）同样处理。

- [ ] **Step 9: 运行测试确认通过**

```bash
bun test apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts
```

预期：全部 PASS。

- [ ] **Step 10: 提交**

```bash
git add apps/electron/src/main/lib/agent-runtime/context-compaction.ts \
        apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts
git commit -m "feat(compaction): 保留窗口改为模型窗口 20% 的 token 预算"
```

---

### Task 4: 视图层截断审计

**Files:**
- Modify: `apps/electron/src/main/lib/agent-runtime/prompt-builder.ts:229-250`
- Create: `apps/electron/src/main/lib/agent-runtime/prompt-builder.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `prompt-builder.test.ts`：

```ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { buildElectronMock } from '../testing/electron-mock'
import { mock } from 'bun:test'

mock.module('electron', () => buildElectronMock())

const { sdkMessagesToChatMessages, __resetViewTruncationThrottle } = await import('./prompt-builder')
const { getContextCompactionMetrics } = await import('../context-compaction-audit-service')

function makeHistory(count: number, sessionId: string) {
  return Array.from({ length: count }, (_, i) => ({
    type: i % 2 === 0 ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text: `消息 ${i}` }] },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: `m-${i}`,
  })) as never[]
}

describe('视图层历史截断', () => {
  beforeEach(() => { __resetViewTruncationThrottle() })

  test('无 boundary 且超限时记录丢弃条数', async () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-1'))
    const metrics = await getContextCompactionMetrics()
    expect(metrics.total).toBeGreaterThanOrEqual(1)
  })

  test('同一 session 60 秒内只记录一次', async () => {
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    sdkMessagesToChatMessages(makeHistory(100, 'view-2'))
    const metrics = await getContextCompactionMetrics()
    expect(metrics.total).toBe(1)
  })

  test('历史未超限时不记录', async () => {
    sdkMessagesToChatMessages(makeHistory(5, 'view-3'))
    expect((await getContextCompactionMetrics()).total).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
bun test apps/electron/src/main/lib/agent-runtime/prompt-builder.test.ts
```

预期：FAIL，`__resetViewTruncationThrottle` 未导出。

- [ ] **Step 3: 加节流与审计**

在 `prompt-builder.ts` 的 import 区加入：

```ts
import { appendContextCompactionAudit } from '../context-compaction-audit-service'
import { estimateOutgoingContextTokens } from './context-compaction'
```

在 `MAX_HISTORY_MESSAGES` 定义之后加入：

```ts
/** 视图截断审计的 per-session 节流间隔：历史只增不减，连续轮次持续截断是正常状态。 */
const VIEW_TRUNCATION_AUDIT_INTERVAL_MS = 60_000

const lastViewTruncationAuditAt = new Map<string, number>()

/** 仅供测试重置节流状态。 */
export function __resetViewTruncationThrottle(): void {
  lastViewTruncationAuditAt.clear()
}

function auditViewTruncation(sessionId: string | undefined, dropped: SDKMessage[]): void {
  if (!sessionId || dropped.length === 0) return
  const now = Date.now()
  const last = lastViewTruncationAuditAt.get(sessionId)
  if (last !== undefined && now - last < VIEW_TRUNCATION_AUDIT_INTERVAL_MS) return
  lastViewTruncationAuditAt.set(sessionId, now)
  try {
    appendContextCompactionAudit({
      sessionId,
      runtime: 'proma',
      trigger: 'native',
      viewTruncation: {
        droppedMessages: dropped.length,
        droppedTokens: estimateOutgoingContextTokens({ historyMessages: dropped }),
        reason: 'max_history_messages',
      },
    })
  } catch (error) {
    console.warn('[上下文压缩] 写入视图截断审计失败:', error)
  }
}
```

- [ ] **Step 4: 在 selectRecentHistory 里调用**

把 `selectRecentHistory` 的结尾（第 249 行）

```ts
  return boundary ? [boundary, ...tail.slice(start)] : tail.slice(start)
```

替换为：

```ts
  const selected = boundary ? [boundary, ...tail.slice(start)] : tail.slice(start)
  // 仅在没有 boundary 时才归因于视图截断；有 boundary 时截断由压缩边界负责。
  if (boundaryIndex < 0) {
    const sessionId = (messages[0] as { session_id?: string } | undefined)?.session_id
    auditViewTruncation(sessionId, messages.slice(0, start))
  }
  return selected
```

- [ ] **Step 5: 运行测试确认通过**

```bash
bun test apps/electron/src/main/lib/agent-runtime/prompt-builder.test.ts
```

预期：3 个测试 PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/electron/src/main/lib/agent-runtime/prompt-builder.ts \
        apps/electron/src/main/lib/agent-runtime/prompt-builder.test.ts
git commit -m "feat(compaction): 视图层历史截断写入审计流"
```

---

### Task 5: 全量回归

- [ ] **Step 1: 跑压缩相关全部测试**

```bash
cd /Users/chaihao/.codex/worktrees/opendesign-closure/project
bun test apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts \
         apps/electron/src/main/lib/context-compaction-audit-service.test.ts \
         apps/electron/src/main/lib/context-compaction-integrity.test.ts \
         apps/electron/src/main/lib/agent-runtime/prompt-builder.test.ts \
         apps/electron/src/main/lib/agent-runtime/compaction-notice.test.ts \
         apps/electron/src/main/lib/adapters/pi-message-adapter.test.ts
```

预期：全部 PASS。

- [ ] **Step 2: 类型检查**

```bash
cd apps/electron && bun run typecheck
```

预期：无错误。

- [ ] **Step 3: 版本号递增**

按仓库规范递增 `apps/electron/package.json` 的 patch 版本。

- [ ] **Step 4: 提交版本号**

```bash
git add apps/electron/package.json
git commit -m "chore(electron): 递增版本号"
```
