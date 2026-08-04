# 风险修复记录（2026-08-05）

来源：8/04–8/05 大量更新（53 提交/218 文件）后的风险评审 → 修复。评审发现的高危项及处置。

## 已修复（4 项高危）

### 1. AI 员工并发额度计 queued 导致死锁
- 文件：`apps/electron/src/main/lib/agent-employee-service.ts`
- 问题：`tryStartExecution` 用 `listRunningAgentExecutions()` 计数并发，该函数返回 `status IN ('queued','running')`，排队中的任务也占额度。同项目 ≥3 个任务排队即互相死锁、永不执行。
- 修复：并发额度只统计 `status === 'running'`（`&& e.status === 'running'`）。

### 2. Goal 配额从不自动扣减（"只挡不扣"）
- 文件：`apps/electron/src/main/lib/token-usage-service.ts`
- 问题：`spendGoalBudget` 仅 IPC 暴露，token 消耗从不累加到 `goal.spentUsd` → 配额实为死代码；手动 spend 又会误阻断自动化。
- 修复：`handleEvent` 写入 token record 后，若 `meta.goalId` 存在且 `costTotal>0`，动态 import `spendGoalBudget(goalId, costTotal)`。`handleEvent` 改为 async。

### 3. goal-mcp 工具越权读写任意 Goal
- 文件：`apps/electron/src/main/lib/chat-tools/goal-mcp.ts`、`agent-orchestrator.ts`
- 问题：`injectGoalTools` 无条件注入所有会话，工具接收任意 `goalId` 且不校验会话绑定。
- 修复：`injectGoalMcpServer` 增加 `sessionId` 参数，从 `agent-session-manager` 解析会话绑定 goalId；所有工具（status/should_run/claim/complete/append_evidence）调用 `authDenied(boundGoalId, goalId)` 校验，未绑定或 goalId 不匹配则拒绝。

### 4. server Tool Span 双 begin 产生悬空 span
- 文件：`apps/server/src/runtime.ts`
- 问题：`tool-input-start` 用 `part.id`、`tool-call` 用 `part.toolCallId` 各建一个 tool span，而 `tool-result/error` 只关 `toolCallId` → 前者悬空（status NULL）。
- 修复：不在 `tool-input-start` 建 span（该事件无 toolCallId 无法精确对齐关闭），span 统一在 `tool-call` 创建；`beginToolSpan` 增加"已有活跃 span 则复用"双保险。

## 验证
- `bun run typecheck`（7 包）通过
- goal-service 15 / token-usage 7 / server 75 测试通过
- biome 5 文件通过
- 注：server `real-e2e.test.ts` 矩阵恒失败（漏 `deepseek-openai`）为存量问题，与本次改动无关。

## 已修复（追加：中危）

### 5. AI 员工 workflow 回写覆盖用户取消
- `agent-employee-service.ts`：`startAgentWorkflow` 的 `await executeWorkflowRun` 后、回写前检查 execution 是否已 `cancelled`，是则放弃回写；`handleExecutionError` 守卫补充跳过 `cancelled`。

### 6. workflow 手动取消无效
- `agent-employee-service.ts`：`updateTodoStatus` 取消时，若 execution 为 workflow（sessionId=`workflow:<runId>`），真正调用 `cancelWorkflowRun(workflowId, runId)`（经 employee.workflowId）；否则走 `stopRegisteredAgent`。

### 7. 审批通过后 Task/execution 不推进
- `project-sqlite-store.ts`：新增 `getAgentExecutionBySessionId`。
- `agent-employee-service.ts`：新增导出 `reconcileWorkflowApprovalRun(workflowId, runId)`，幂等回写 stale→completed/failed + task。
- `workflow-ipc-handlers.ts`：`RESOLVE_APPROVAL` 后调用 reconcile（应用启动、审批时联动）。

### 8. 任务改派给 AI 员工不派发
- `agent-employee-service.ts`：新增幂等 `dispatchTaskToAgentIfIdle`（无进行中 execution 才派发）。
- `project-auto-sync.ts`：`updated` 分支若 assignee 变 AI 员工，幂等派发。

## 已修复（再追加：低危）

### 9. session 预算 spentBudgetUsd 死代码
- `token-usage-service.ts`：token 记账时把 `costTotal` 累加到 `meta.spentBudgetUsd`（`updateAgentSessionMeta`），使 `preTickTurn` 的会话配额分支真正生效。

### 10. unblocksTodoId 依赖未实现
- `goal-service.ts`：新增 `listActionableTodos`（状态在 open/claimed/in_progress 且解锁依赖链已完成，递归+循环防护）；`shouldGoalRun` 用它。`turn-decision-service.ts`：`preTickTurn` 的 actionable 改用它。

### 11. draft Goal 派生为 blocked
- `goal-service.ts`：`derivePhase` 中 draft 且无 active todo 时保持 draft（不再误置 blocked）；有 todo 则正常转 active。

### 12. real-e2e 测试矩阵漏 deepseek-openai（消除恒失败红灯）
- `apps/server/src/real-e2e.test.ts`：matrix 补 deepseek-openai 条目（和 deepseek 同 key，矩阵一致性断言通过）。server 测试 0 fail。

## 未修复（评审中的中/低危，供后续）
- server 采样无 secret 脱敏、子代理计费漏记、signal 误报/无去重、trace_id 未闭环（独立部署、采样默认关）
- 空证据假象（无 token 记录时写"运行成功"）、runtime-services 测试并发污染（存量）
