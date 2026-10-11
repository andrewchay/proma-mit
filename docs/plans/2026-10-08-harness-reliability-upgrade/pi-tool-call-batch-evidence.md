# E03 Pi 批次语义核验与观察接线证据

> 2026-10-09 10:55 GMT+8；基线2eef8041。核验对象：`@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 1.0.2（项目根 node_modules，与 apps/electron 声明一致）。

## 源码核验结论（只读，未运行 Provider）

1. `agent-loop.js` 在每个 assistant 消息结束后判断停止原因：
   - `stopReason` 为 `error` 或 `aborted`：不执行任何工具，直接发出 `turn_end`/`agent_end` 并返回。
   - `stopReason` 为 `length`：当前消息中的工具调用不经过 `executeToolCalls`，而由 `failToolCallsFromTruncatedMessage` 为每个调用发出失败的 `tool_execution_start/end` 与 error 工具结果（“参数可能被截断，未执行”）。这是 Pi SDK 层面对截断批次的零执行保证。
   - 其他停止原因（含 `stop` 与 `toolUse`）且存在 toolCall：经 `executeToolCalls` 执行（默认并行，`sequential` 或声明 sequential 时串行）。`stop` 带工具调用也会执行，因此共享判定把它视为完整。
2. `pi-ai` `StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"`；工具调用位于 `AssistantMessage.content` 中的 `type: "toolCall"` 项（含 `id`、`name`）。
3. `deferred`/`pending` 在 agent-loop 中未找到显式分支，行为未核实，本批按不完整处理。

## 落地（观察接线，不改执行）

- shared `SDKAssistantMessage` 新增可选 `toolCallBatchIntegrity`（仅 final 消息）。
- `pi-message-adapter.ts` 新增 `assessPiToolCallBatch`：`toolUse` 映射为共享词表 `tool-calls`，其余停止原因原样交给判定，未知/错误/中止/pending/deferred/length 均不完整。
- 未改变 `pi-agent-adapter.ts` 的事件流、重试、中断或权限路径。

## 验证

- `pi-message-adapter.test.ts`：新增4例（toolUse完整且 partial 不附加、length 原因码、aborted/error/pending/deferred 不完整且无工具 stop 完整、重复 id 报告），与既有13例合计通过（13 pass/0 fail）。
- typecheck 九包通过，lint 通过。
- 全仓回归与 workspace 目录清单见 ledger 对应条目。

## 限制

- 上述零执行结论来自**源码阅读**，不是本仓库的运行时测试；未对 Pi 真实 Provider 做任何调用。应在后续受控测试中用离线 fake 流复现 `length` 批次，才算仓库内验证。
- 观察字段是事后事实，不能撤销已执行的 `stop`/`toolUse` 工具调用；`stop` 带工具调用属完整批次但仍会执行。
- `deferred`/`pending` 的真实语义未核实，不能推断它们是否执行工具。
