# M2 D03：ai-sdk 独立工具加载（opt-in）证据

> 2026-10-11 00:55 GMT+8。基线 77eaa09e。

## 设计

- 唯一 opt-in 入口：`AISDKAgentTurnInput.toolLoading?: ToolLoadingSpec`。不传 = 既有全量行为（B15 钉板用例锁定）。
- `tool-loading-gate.ts`：`planToolLoading`（发现+选中集+schema 哈希快照）与 `guardLoadedToolCall`（执行边界：tool_not_loaded / schema_changed 拒绝，不执行）。
- `runAgentTurn` 接线：计划先行 → toolSet 只含选中工具（未选 schema 不进模型）→ 能力摘要注入系统提示词 → 执行包装经门禁。

## 测试

- gate 4 例：required 必现/未加载拒绝/schema 漂移拒绝/同名绑定。
- wiring 3 例（mock 脚本化 streamText，捕获 params 断言）：toolSet 过滤+摘要注入；不传 spec 行为兼容；**加载后 schema 被修订 → execute 包装拒绝且 runtime tool 未执行**。
- 修复记录：mock 初版把 steps/usage 嵌套在 result 字段下，与 AI SDK 真实返回形态（顶层惰性 Promise）不符；usage 缺 inputTokenDetails。修正 mock 而非实现。

## 权限与边界

- 不提权：门禁只窄不宽；权限流程（canUseTool）在执行包装之后照常。
- Pi/proma/claude **未接线**（每 Runtime 明确支持/不支持：仅 ai-sdk 声明支持 opt-in 加载）。
- 未默认启用：无 toolLoading spec 的调用零行为变化；默认启用是 G4 默认推广授权决策。
- schema 哈希绑定 name→parameters 快照；目录修订后旧调用明确拒绝（B07 旧 schema 引用失效）。
