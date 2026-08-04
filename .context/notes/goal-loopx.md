# Goal 状态层（借鉴 LoopX）功能文档

> 记录 Proma MIT 引入的 Goal（长生命周期目标）状态层：架构、关键文件、数据模型、演进历史。
> 跨会话参考，后续任何改动前先读本文件。

## 定位

把 Proma MIT 从"一次性会话 + 定时任务"升级为"长生命周期目标可追踪、跨会话可持续、证据可复盘"的 Agent 工作台。借鉴 LoopX 的循环工程控制平面思想，但适配桌面应用 + 本地 JSON 存储。

**核心原则**：状态与执行解耦、人类判断永不外包（gate）、证据驱动、配额防失控、本地优先。

## 数据存储

```
~/.proma-mit/goals/
├── index.json          # Goal 索引（轻量，供列表加载）
└── {goalId}.json        # 每个 Goal 一个持久状态文件
```

## 核心数据模型（packages/shared/src/types/goal.ts）

- `Goal`：id / title / objective / scope / phase / workspaceId / todos / gates / evidence / authoritySource / quota
- `GoalPhase`：draft | active | waiting_user | blocked | completed | archived
- `GoalTodo`：id / text / class(user_gate|agent_work|monitor|checkpoint) / status / claimedBy / unblocksTodoId
- `GoalGate`：用户门控，status open|resolved
- `GoalQuota`：maxBudgetUsd / spentUsd
- `GOAL_IPC_CHANNELS`：Goal CRUD / todo / gate / evidence / should-run / spend / bind-session / list-sessions

## 关键服务（apps/electron/src/main/lib/）

| 文件 | 职责 |
|------|------|
| `goal-service.ts` | Goal CRUD、阶段推导、todo/gate/evidence、配额(shouldRun/spendBudget/canSpend)、会话绑定(bindSessionToGoal 等，惰性依赖 session-manager) |
| `turn-decision-service.ts` | Turn 前置路由决策：ready/wait_user_action/blocked/quota_exhausted/goal_terminated/replan/repair/no_goal；支持会话级配额参数 |
| `evidence-service.ts` | 从 token 记录解析结构化证据(decisions/validation/writeback/evidence)，工具名→中文动作短语语义化；预留 enrichEvidenceWithLLM(no-op) |
| `handoff-budget.ts` | SubAgent 交接预算(16行/1800字符) |
| `app-event-bus.ts` | 会话完成/失败时 `sinkGoalEvidence` 自动沉淀证据到绑定 Goal |
| `chat-tools/goal-mcp.ts` | 注入 Goal 工具到 Agent：goal_status/claim_todo/complete_todo/append_evidence/should_run |
| `token-usage-service.ts` | Token 统计（Goal/evidence 的补充数据源） |

## 关键集成点

- **agent-orchestrator.ts** `sendMessage()`：前置 Turn 决策（绑定 Goal 或会话级配额时）；`triggeredBy=automation` 且非 ready 时硬阻断，配额耗尽发系统通知(E8)
- **agent-session-manager.ts** `updateAgentSessionMeta` 白名单含 goalId/maxBudgetUsd/spentBudgetUsd
- **SessionMeta.goalId**：会话绑定 Goal；**maxBudgetUsd/spentBudgetUsd**：会话级可选配额(E7)
- **AgentMessages.tsx** `TurnDecisionNotice`：对话顶部 Goal 决策提示条(可关闭、决策变更自动重置 E3)
- **AgentHeader.tsx** `GoalBindingControl`：标题栏「绑定目标」下拉(E2)，一键绑定/解绑
- **GoalsSettings.tsx**：设置→系统与隐私→目标（Goals）Tab

## UI 入口

设置 → 系统与隐私 → **目标（Goals）**：
- 概览卡片（活跃目标/待处理门控/今日Token/总费用）
- Goal 列表（阶段筛选 all/active/completed/archived + workspace 徽标 E10）
- Goal 详情：todo 看板、用户门控、证据(折叠/导出 E6)、关联会话、编辑(title/objective/scope/quota E1)

Agent 会话标题栏「绑定目标」下拉（E2）。

## 版本演进

| commit | 内容 |
|--------|------|
| `53b376d` | P0：Goal 状态层 + Goals UI + goalId 关联 |
| `09dbe05` | P1：证据(RunEvidence) + 配额 + 自动沉淀 |
| `abe4319` | P2：Turn 决策层 + 交接预算 + Goal Dashboard 首屏 |
| `77f213d` | 闭环修复 A1-A5：goalId 绑定/入口/决策UI/Goal工具/配额阻断 |
| `01e9715` | E1-E5：创建编辑表单/会话绑定/决策条/goal_complete_todo/证据语义化 |
| `a3ff274` | E6-E9：证据折叠导出/会话级配额/配额通知/replan修复路由 |
| `56201f4` | E10：跨工作区聚合视图 |

## 已知取舍

- **自动化配额只对绑定 Goal 或有 maxBudgetUsd 的会话生效**（E7 后可给未绑定会话设配额）
- **evidence 是脚本级语义化**，未接 LLM 摘要（`enrichEvidenceWithLLM` 预留 no-op；主进程无法直接调内置 get_credentials）
- Goal 绑定链路已通，但创建/编辑体验仍可再打磨

## 测试

`goal-service.test.ts`（15）、`turn-decision-service.test.ts`（13）、`handoff-budget.test.ts`（5）、`token-usage-service.test.ts`（7）、`evidence-service.test.ts`（3）。
完整 main/lib 回归：`bun test apps/electron/src/main/lib/*.test.ts`（175 pass）。

## 注意事项（防坑）

- Bun 的 `mock.module` 是全局的 → 测试里 **avoid mock electron / session-manager**（会污染同批其他测试文件）；用**依赖注入**（如 goal-service 的 bindSession deps、turn-decision 的 deps、evidence 的 recordSource）
- `git add -A` 会把根目录漂移文件带上；提交前 check
