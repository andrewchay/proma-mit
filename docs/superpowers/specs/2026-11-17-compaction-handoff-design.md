# 上下文压缩：交接式注入与 token 化保留窗口

日期：2026-11-17
状态：设计已确认，待实现
参考：`docs/reverse-engineering-codex-compact.md`（Codex handoff compaction 逆向调研）

## 背景

Gravitas 已有一套自研上下文压缩（`apps/electron/src/main/lib/agent-runtime/context-compaction.ts`，630 行）：

- **触发**：`resolveAutoCompactionTrigger` 以「估算 outgoing payload」与「同模型已报告 usage」的较高值对比 `窗口 - 32k 输出预留 - 8k 安全缓冲`。
- **分层治理**：先 `pruneOldToolResults` 裁剪最近窗口之外、超过 2000 字符的成功工具结果（只改模型视图，JSONL 不重写）；仍超预算才摘要。
- **摘要**：`summarizeHistory` 让模型输出结构化 ContextPacket v1（summary / facts / decisions / openTasks / importantFiles / toolState），并把上一版 packet 作为增量基线。
- **落盘**：`compactSDKMessages` 先把压缩前 JSONL 全量归档到 `compaction-archive/{sessionId}/`，再写 `system(compact_boundary)` + 最近 N 条。
- **审计**：`context-compaction-audit-service.ts` 追加 `~/.gravitas/context-compaction-audit/events.jsonl`。

对照 Codex 的 handoff compaction，现有实现在**注入身份**、**保留窗口单位**、**静默截断**三处存在可改进点。本设计只处理这三项，不引入 Codex 的远程压缩、四层兜底或 `new_context` 自转身机制。

## 目标

- 压缩摘要以「另一个模型的交接」身份注入，而不是「系统记忆」。
- 保留窗口按 token 预算决定，不按固定条数。
- 视图层的历史截断不再静默发生，且进入审计流。
- 不改变 ContextPacket 结构、不改变 JSONL 存储格式、不改变压缩触发阈值。

## 非目标

- 不实现 Codex 的远程压缩 V2（服务端总结）。
- 不实现「压缩请求自身超限则从头 trim 重试」。
- 不实现 PreCompact / PostCompact 可中止钩子。
- 不实现 `new_context` 自转身兜底。
- 不改变 `COMPACTION_LOW_WATER_RATIO`（0.65）与 `DEFAULT_CONTEXT_OUTPUT_RESERVE_TOKENS`（32k）等既有阈值。

## 设计

### A. 注入身份：系统记忆 → 工作交接

**现状**两处措辞一致，均把摘要描述为"系统生成的既有会话压缩上下文"：

| 位置 | 常量 |
|---|---|
| `agent-runtime/prompt-builder.ts:21` | `COMPACT_CONTEXT_NOTICE` |
| `adapters/pi-message-adapter.ts:222` | 内联字符串 |

**问题**：以"系统记忆"身份注入，模型会把摘要中的判断当作自己已验证的结论。Codex 的做法相反——伪装成"另一个模型做的工作交接"，让模型以接手同事工作的姿态继续，对摘要内容保持正常的审慎。

**改动**：两处统一为同一份常量，内容包含三条要素：

1. **交接框架**：摘要来自另一个模型，是它此前完成的工作与判断。
2. **防误判**：不是用户的新指令（保留现有防护，不可丢）。
3. **连续性契约**：压缩不结束任务；从交接状态自然继续推进，不重新总结已完成步骤，不从头重做。

第 3 条是 Codex 系统提示中的原文契约，Gravitas 当前完全没有——这是"压缩后模型重新开始"类问题的直接原因。

**实现约束**：`pi-message-adapter.ts` 与 `prompt-builder.ts` 分属 `adapters/` 与 `agent-runtime/`，把常量放在任一侧都会让另一侧产生反向依赖。新建 `agent-runtime/compaction-notice.ts` 存放共享常量与模板函数——该目录已被两侧共同依赖，不引入新的循环依赖风险。两处文本由同一常量渲染，不可能漂移。

### B. 保留窗口：条数上限 → token 预算

**现状**：`DEFAULT_KEEP_RECENT_MESSAGES = 20` 条。`resolveAdaptiveKeepRecent` 确实按预算计算，但**只减不增**——`desired` 被 `Math.min(desiredKeepRecent, historyMessages.length)` 锁死在 20。20 条大工具消息可能超过 200k token，20 条短对话只有 3k token，单位与目标不匹配。

**改动**：目标保留量改为模型窗口的 20%，并以上行低水位封顶：

```
targetKeepTokens = min(contextWindow * 0.20, inputBudgetTokens * 0.65)
```

不设下限——20% 已随窗口自然缩放，任何额外钳制都会在极端窗口下与低水位硬上限打架（见下表 8,192 一行：20% 为 1,638，若强行设 4,000 下限反而越过 3,660 的低水位）。

`resolveAdaptiveKeepRecent` 的循环终止条件从"选满 desired 条"改为"累计 token 达到 targetKeepTokens"。返回值仍是条数，因此 `pruneOldToolResults`、`summarizeHistory`、`compactSDKMessages` 的签名均不变。

**签名影响**：`resolveAdaptiveKeepRecent` 目前只接收 `inputBudgetTokens`，拿不到 `contextWindow`。`resolveAutoCompactionTrigger` 内部已解析出 `capability.contextWindow`，将其加入 `AutoCompactionTrigger` 返回值即可，不需要新增解析调用。

`DEFAULT_KEEP_RECENT_MESSAGES` 保留为防死循环的硬顶，值从 20 放宽到 200。

#### B-1. 必须处理的空转风险

保留目标是**上限**不是下限。当历史本身小于目标时，`resolveAdaptiveKeepRecent` 返回全部条数 → `earlyCount = 0` → `compactSessionNow` 走 `noop` 分支，**压缩永不发生**。

这不是理论风险。本地 token 估算只覆盖文本，无法计入图片、附件与超大工具结果。已报告 usage 220k 而本地可估算历史仅 9k 的会话真实存在——此时触发条件成立，但保留目标（128k 窗口下 25,600）远高于历史总量，压缩被跳过，且下一轮重复同样判断，会话静默卡在超预算状态。

处理方式：

1. **不修改 noop 语义**——历史确实小于保留目标时，压缩无法降低 token（预算被 system prompt / 工具 schema / 当前输入占满），强行压缩只会破坏上下文而不解决问题。
2. **把空转变成可诊断事实**：`compactSessionNow` 在 `earlyCount <= 0` 时写一条审计事件（`compactionSkipped`），记录 `estimatedHistoryTokens` 与 `targetKeepTokens`。运维据此判断"是保留目标过大"还是"预算被非历史部分占满"。
3. **测试夹具修正**：既有 `context-compaction.test.ts` 的 `makeHistory(65)` 只有约 9k token，在新目标下必然空转。测试用例需要放大到能真实越过保留目标的规模，并**额外新增**一个"历史小于目标时记录跳过审计且不调 LLM"的用例。

**参数校验**（按 `model-context-catalog.generated.json` 的 137 个模型窗口分布）：

| 窗口 | 输入预算 | 低水位 0.65 | 保留 20% |
|---|---|---|---|
| 8,192 | 5,632 | 3,660 | 1,638 |
| 128,000 | 88,000 | 57,200 | 25,600 |
| 200,000 | 160,000 | 104,000 | 40,000 |
| 262,144 | 222,144 | 144,393 | 52,428 |
| 400,000 | 360,000 | 234,000 | 80,000 |
| 500,000 | 460,000 | 299,000 | 100,000 |
| 1,000,000 | 960,000 | 624,000 | 200,000 |

所有窗口下 20% 均低于低水位硬上限，不会触发截断，无需调整 `COMPACTION_LOW_WATER_RATIO`。

**与 Codex 的刻意偏离**：Codex 只保留最近 20k token 的**用户消息**原文，丢弃工具结果。Gravitas 的 adapter（`pi-message-adapter.ts`、`prompt-builder.ts`）要求 `tool_use` / `tool_result` 成对出现，孤儿 tool_result 会被严格网关拒绝（见 `convertSDKMessagesToPiMessages` 的既有注释）。因此这里保留的是"最近消息按序 + 工具对对齐"，不是纯用户消息。

### C. 视图层静默截断

**现状**：`prompt-builder.ts:242` 的 `selectRecentHistory` 在**不存在** compact_boundary 时执行 `slice(-MAX_HISTORY_MESSAGES)`，静默丢弃更早的历史，无日志、无审计。

**问题**：这发生在压缩链路之外。压缩可能因为未达阈值而不触发，但视图层已经在丢历史——100 条历史的会话，模型只看到 20 条，且无任何迹象。这比 B 本身更隐蔽。

**改动**：截断发生时记录被丢弃的条数与原因，写入审计流。

审计事件扩展现有 `ContextCompactionAuditInput`：

```ts
export interface ContextCompactionAuditInput {
  sessionId: string
  runtime: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  trigger: 'automatic' | 'manual' | 'overflow_recovery' | 'native'
  packetVersion?: number
  estimatedTokensAfter?: number
  /** 新增：视图层截断（非压缩）时记录丢弃条数 */
  viewTruncation?: {
    droppedMessages: number
    droppedTokens: number
    reason: 'max_history_messages'
  }
  /** 新增：已判定需要压缩但无早期消息可压（保留目标不小于历史总量） */
  compactionSkipped?: {
    estimatedHistoryTokens: number
    targetKeepTokens: number
  }
}
```

`trigger` 不新增枚举值，避免破坏 `isTrigger` 校验与既有 `getContextCompactionMetrics` 的聚合维度。视图截断是一个**独立维度**，不是压缩触发原因。

**节流**：`selectRecentHistory` 每轮都会被调用。同一 session 在连续轮次中持续截断是正常状态（历史只增不减），因此按 sessionId 做进程内节流——同一 sessionId 在 60 秒内最多记录一次，避免审计文件被刷爆。

## 架构影响

| 文件 | 改动 |
|---|---|
| `agent-runtime/compaction-notice.ts`（新建） | 共享的交接提示词常量与模板函数 |
| `agent-runtime/prompt-builder.ts` | 改用共享常量；`selectRecentHistory` 增加截断审计 |
| `adapters/pi-message-adapter.ts` | 改用共享常量 |
| `agent-runtime/context-compaction.ts` | `resolveAdaptiveKeepRecent` 改为 token 目标驱动；`DEFAULT_KEEP_RECENT_MESSAGES` 20 → 200 |
| `context-compaction-audit-service.ts` | `ContextCompactionAuditInput` 增加 `viewTruncation` 字段 |

无新增依赖，无 IPC 通道变更，无渲染进程改动。

## 测试

**A（注入身份）**
- `prompt-builder` 与 `pi-message-adapter` 产出的文本包含三条要素（交接框架 / 防误判 / 连续性契约）。
- 两处使用同一常量，文本不漂移。

**B（保留窗口）**
- 128k 窗口：目标保留 = min(25,600, 57,200) = 25,600 token，不再固定 20 条。
- 1M 窗口：目标保留 = min(200,000, 624,000) = 200,000 token。
- 小窗口（8k）：目标 1,638 token，且不得越过 3,660 低水位。
- 历史总量小于目标时：返回全部条数、不发 LLM 请求、写 `compactionSkipped` 审计。
- 既有 `context-compaction.test.ts:235` 的 `DEFAULT_KEEP_RECENT_MESSAGES + 1` 断言需同步更新。
- 工具对对齐：保留窗口不以孤儿 `tool_result` 开头（既有 `alignKeepStartToToolPairs` 行为不回归）。

**C（静默截断）**
- 存在 compact_boundary 时不记录 `viewTruncation`（截断由压缩边界负责）。
- 不存在 boundary 且历史超限时记录 `viewTruncation`，条数与实际丢弃一致。
- 同一 session 60 秒内多次截断只记录一次。
- `getContextCompactionMetrics` 的既有断言不受影响（`byTrigger` 维度不变）。

**回归**
- `bun test apps/electron/src/main/lib/agent-runtime/context-compaction.test.ts`
- `bun test apps/electron/src/main/lib/context-compaction-audit-service.test.ts`
- `bun test apps/electron/src/main/lib/context-compaction-integrity.test.ts`
- `cd apps/electron && bun run typecheck`

## 风险

| 风险 | 评估 |
|---|---|
| 20% 保留窗口挤压正常对话空间 | 已验证：所有窗口下均低于 0.65 低水位，且保留的是最近消息（本就该保留的部分） |
| 1M 窗口保留 200k token 导致摘要请求变慢 | 摘要输入侧已有 `SUMMARY_SOURCE_MAX_CHARS`（60k 字符）截断与自适应超时，不受保留窗口影响 |
| 审计 `viewTruncation` 刷爆文件 | 60 秒 per-session 节流 |
| 两处提示词文本漂移 | 提取为共享常量，测试断言同源 |

## 回滚

三项改动相互独立，可单独回滚：
- A 回滚：恢复两处原始字符串。
- B 回滚：`DEFAULT_KEEP_RECENT_MESSAGES` 改回 20，`resolveAdaptiveKeepRecent` 恢复条数终止条件。
- C 回滚：移除 `viewTruncation` 字段与调用点（审计为追加式 JSONL，旧记录仍可解析）。
