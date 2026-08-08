# 会话生成机制系统梳理（为什么 AI 员工会“默默生成”大量子会话）

> 目的：系统性回答“为什么简单任务会爆出大量子会话，系统到底怎么设计的”。
> 关键词：会话(session)、协作子会话/委派(delegation)、AI 员工(headless)、防爆护栏。

## 0. 一次性结论

1. 系统**本身**允许「委派协作子会话」（delegate_agent/delegate_agents），这是**有意设计**的功能，不是 bug。
2. 失控的根因是：**多个与会话创建的入口没有统一走同一道闸门**，导致“简单任务被误触发大量委派”时不设防地无限建子会话。
3. 我已在**唯一收口点 `startDelegation`** 加了硬闸（`assertCanCreateDelegation`），现在无论从哪个入口（工具或前端直调）建子会话都会被兜底拦截。
4. 但仍要理解：**“session”不等于“子会话”**。某些计数（Run Center 的会话数）把 AI 员工的每次执行/重试/心跳都算进去，可能与“真正开子会话”是两回事。

---

## 1. 会话创建的全部入口（系统里能“造出会话”的地方）

| # | 入口 | 位置 | 何时发生 | 是否委派子会话 |
|---|------|------|---------|:---:|
| 1 | 用户新建会话 | ipc → `createAgentSession` | 用户点“新建” | 否（根会话） |
| 2 | AI 员工执行 | `agent-employee-service.startAgentHeadless` | 指派 AI 员工任务 | 否（但被设 `delegationDepth=1`） |
| 3 | 协作子会话（工具） | `agent-collaboration-tools` `delegate_agent/delegate_agents` | Agent 会话调用协作工具 | **是** |
| 4 | 协作子会话（前端直调） | `createCollaborationDelegations` → `startDelegation` | UI“发起协作子任务” | **是** |
| 5 | 桥接/远程 | `bridge-command-handler`、`feishu-bridge` | 飞书/钉钉命令触发 | 视情况 |
| 6 | Workflow 自动化 | `workflow-agent-executor` | 定时/自动化任务 | 否 |
| 7 | API/SDK | `pi-agent-adapter`、`agent-service` | 外部调用 | 视情况 |

---

## 2. “委派子会话”这条路怎么设计的（为什么会有它）

**设计意图**：父 Agent 觉得任务复杂需要并行/独立视角时，可以 `delegate_agents` 拉出 1~N 个**真实可见的子会话**，各自独立跑，再汇总（对应我自己的 `delegate_agent` 能力）。这是产品能力，**不是缺陷**。

关键点：子会话通过 `updateAgentSessionMeta(child, { delegationDepth: parent.depth + 1 })` 标记深度。

---

## 3. 我加的防爆护栏（三层）

| 层 | 机制 | 拦截点 | 说明 |
|---|------|--------|------|
| L1 员工防自我委派 | `startAgentHeadless` 建会话后设 `delegationDepth=1` | 会话执行时 `orchestrator` 读到 `delegationDepth>0` → `isDelegationSession=true` → **不注入协作工具** | 堵“AI 员工自发 delegate” |
| L2 委派前置闸 | `assertCanCreateDelegation` | 工具 handler（delegate_agent/delegate_agents）调用 | ①`delegationDepth>0` 拒绝②单父运行并发 ≤50③**根累计 ≤16** |
| L3 单点硬闸（本轮新增） | `startDelegation` 顶部强制 `assertCanCreateDelegation(ctx,1)` | **所有委派创建的唯一收口** | 堵**前端 `createCollaborationDelegations` 直调 `startDelegation` 的旁路**——之前它完全没查闸 |

**本轮修的核心旁路**：`createCollaborationDelegations` 循环 `startDelegation`，而 `startDelegation` 原**不查任何闸** → 前端/任何直调可无限建子会话。现在把它变成唯一收口点，L2+L3 天然覆盖所有入口。

---

## 4. 为什么“改完还会爆”（真实原因复盘）

之前 230+/60+ 的修复只加了：
- `delegationDepth=1`（堵 AI 员工工具委派）
- 根累计上限（堵工具路径）

但**漏了 `createCollaborationDelegations` 这条前端直调旁路**，它绕过所有闸直接 `startDelegation`。这就是为什么“还在默默生成”。现在已封死。

同时要提醒：**后台默默生成的可能不是“子会话”，而是“AI 员工的重复执行会话”**。见下节。

---

## 5. 需要区分的两类“会话”增长

| 现象 | 本质 | 是否危险 |
|------|------|:---:|
| 每任务 1 个 AI 员工会话 | 正常，一步一执行 | 否 |
| 一个任务反复重试/重构会话 | 失败重试或排队逻辑没收敛 | 需查（重试熔断） |
| 1 个父会话拉出 N 个子会话 | 委派功能 | 设计如此，但应设上限（现已 16） |
| N 个父会话各自拉 N 个 | 失控 | 需全局总量兜底 |

**建议再加一道「进程级总会话预算」**（所有 `createAgentSession` 收口，进程内最多累计 N 个，超了直接拒绝），把“无论哪条路”都钉死。这是比“在各入口加闸”更根本的护栏。

---

## 6. 根治建议（两层护栏合一）

1. **✅ 已做**：委派收口 `startDelegation` 强制查闸 + AI 员工 `delegationDepth=1` + 根累计 16。
2. **建议补**：在 `createAgentSession`（agent-session-manager）加**进程级总会话软上限**，超限拒绝并告警，彻底杜绝“旁路造会话”。

---

## 7. 如何验证“到底谁在建会话”

在正在跑的应用里，看 **Run Center → 会话列表** 即可（每个会话有标题前缀 `[AI员工] xxx`、`协作：xxx`、或普通话）。
- 若大量 `协作：` 前缀 → release 时委派旁路（现已修复）。
- 若大量 `[AI员工]` 且标题重复 → 是 AI 员工重试/排队问题，不是委派，往 `agent-employee` 的 dispatch/重试逻辑查。
