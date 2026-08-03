# Pi / Proma Runtime 断流诊断记录（2026-08）

## 现象
用户在 proma-mit 中使用 pi / proma runtime 时，流式对话"容易断流"——输出到一半停止。

## 根因
**proma-mit 自研 `streamSSE`（`packages/core/src/providers/sse-reader.ts`）在流被提前关闭时静默返回不完整内容**：
- 旧逻辑：`reader.read()` 返回 `done: true`（网络/服务端提前 EOF，无异常）时直接 break，不检查是否收到过终止信号。
- 结果：OpenAI 协议未收到 `data: [DONE]` 哨兵、Anthropic 协议未收到 `message_delta`（stop_reason）时，流已提前结束但被当作"正常完成"返回，`stopReason` 为 undefined。
- 上层 adapter 看到无工具调用 + 无 stopReason → 正常 break → 用户看到"断流"：**不报错、不重试**。

Pi runtime（Pi SDK 内部）两条协议路径本身有保护：
- Anthropic: `stream ended before message_stop`（SDK 抛错）
- OpenAI: `Stream ended without finish_reason`
- 且 `isRetryableAssistantError` 的 `RETRYABLE_PROVIDER_ERROR_PATTERN` 覆盖这些文本 → Pi 会自动重试。
- 所以 Pi runtime 断流主要由 SDK 内部 retry（maxRetries=2）+ orchestrator 外层 25 次重试兜底。proma runtime（自研 streamSSE）反而最脆弱。

## 修复
1. `sse-reader.ts`：追踪终止信号 `sawTerminator`（`[DONE]` 或 `done` 事件）；EOF 时若 `adapter.requiresTerminator !== false && !sawTerminator`，抛 `stream ended prematurely: ...`。
   - 错误文本匹配 `TRANSIENT_NETWORK_PATTERN`（`stream (?:closed|ended|disconnected) prematurely`）→ 可被 `withRetry` / orchestrator 自动重试。
2. `types.ts`：`ProviderAdapter` 增加可选 `requiresTerminator?: boolean`（默认 true）。
3. `google-adapter.ts`：`requiresTerminator = false`（Google SSE 以流自然结束为终止，无 [DONE]）。
4. `openai-adapter.ts`：`finish_reason` 任意值（stop / length / tool_calls 等）都发 `done` 事件，不再只发 tool_calls，避免正常结束被误判断流。
5. `chat-service.ts`：聊天模式两个 `streamSSE` 调用（主轮 + 最终响应轮）包上 `withRetry`（`CHAT_STREAM_MAX_RETRIES = 3`，仅瞬时网络错误重试）。
6. 顺手修复 pre-existing 测试问题：`ai-sdk-agent-adapter.real.test.ts` / `pi-agent-adapter.real.test.ts` 的 attachment-service mock 缺导出（`deleteAttachment` / `deleteConversationAttachments` / `saveAttachment` 等），补全后 smoke matrix 测试可运行。

## 相关文件
- `packages/core/src/providers/sse-reader.ts`（核心修复）
- `packages/core/src/providers/sse-reader.test.ts`（新增：正常 [DONE]/finish_reason 返回、提前关闭抛错、Google 自然结束不抛错、空响应抛错）
- `packages/core/src/providers/types.ts`
- `packages/core/src/providers/openai-adapter.ts`
- `packages/core/src/providers/google-adapter.ts`
- `apps/electron/src/main/lib/chat-service.ts`
- `apps/electron/src/main/lib/adapters/{ai-sdk,pi}-agent-adapter.real.test.ts`（smoke matrix 补 deepseek-openai + attachment mock 补齐）

## 验证
- `bun run typecheck` ✅
- `bunx biome check` ✅
- `bun test`（apps/electron 360 pass / 0 fail，packages/core 13 pass）✅

## 遗留
- `apps/server/src/real-e2e.test.ts` 可能也有 attachment mock 问题（本次未触碰）。
- provider-agnostic `withRetry` maxRetries 默认 2，断流频繁时可考虑调大。
