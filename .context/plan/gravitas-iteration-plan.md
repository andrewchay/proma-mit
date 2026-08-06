# Gravitas 迭代计划 — 三大需求

> 创建：2026-08-06
> 优先级（用户确认）：需求1（子任务并行） > 需求2（Agent 发送排队） > 需求3（飞书权限排查）

## 需求1：子任务并行执行（最高优先级）

**现状**：`provider-agnostic-agent-adapter.ts` 的 `executeToolCalls` 用 `for (const tc of toolCalls)` **串行**执行同一轮所有工具调用，包括多个 SubAgent（Agent 工具）委派。

**方案**：智能分组并行
- 单工具执行逻辑提取为 `executeSingleToolCall`
- 「可并行工具」（Agent/SubAgent + Read/Write/Bash/Web 等普通工具）同一轮 `Promise.all` 并行执行，结果按 tool_use_id 重排
- 「必须串行工具」（EnterPlanMode/ExitPlanMode/AskUserQuestion/GoalCheckpoint/CompactContext）保持顺序逐个执行
- 新增测试：同一轮多个 Agent 委派并行 + 结果顺序正确

## 需求2：Agent 模式发送排队

**现状**：Agent 模式 `sendMessage`（agent-orchestrator.ts）并发守卫是「会话处理中 → 拒绝」。Chat 模式已实现同会话排队（commit 7d42fb1）可参照。

**方案**：将 Chat 的排队模型移植到 Agent 模式（sessionQueue + pumpNext + 撤回/插队 + STREAM_QUEUE_STATE）

## 需求3：飞书权限（指定责任人拉不到人）

**现状**：contact-search-service.ts 已重写为 find_by_department（未提交），但用户反馈仍拉不到。handover 文档指出还需排查「真实根部门 ID」与「可见范围授权」。

**方案**：深入排查真实根部门枚举、可见范围诊断
