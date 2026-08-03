# 项目管理「AI 员工（Agent Employee）」方案设计

> 2026-08-04 v2 · 已按决策更新：执行器默认 headless（P3 补 Workflow）；权限默认 safe + by-task 申请；
> 共享项目工作区；异步队列 + 心跳检查保活。状态：P0（v0.11.3）+ P1（v0.11.4）+ P2（v0.11.5）已实施：两表 + AgentTodoProvider + headless 执行 + 60s 心跳 + 团队 UI + by-task 权限 + 并发排队 + assignee 整合 + 摘要/风险 AI 维度 + AI 团队效能总览 + 看板 AI/真人过滤。P3 待办：Workflow SOP 绑定。

---

## 1. 背景与目标

当前项目管理（projects）承载两类"员工"：
- **真人员工**：通过钉钉 / 飞书映射（`UserMapping` + `TodoProvider`），任务指派后同步到外部待办，由真人完成，状态回写。
- 目标：在团队中预定义 **AI 员工（Agent Employee）**，一旦角色确定即可像真人员工一样被指派任务，由 Agent 直接执行（子任务 Agent），并将实施结果同步回项目管理，供 AI 分析。

核心价值：
- 任务拆解后，机械/确定性/高复用的子任务可直接派给 AI 员工，真人聚焦判断与协作
- 项目进度、风险、产出全部沉淀在项目管理系统，可统一分析

---

## 2. 与现有架构的契合点

| 现有能力 | 如何复用 |
|---|---|
| `TodoProvider` 注册表（`project-sync-service`） | AI 员工 = 第三种 Provider（`name: 'agent'`），与飞书/钉钉同一套同步链路 |
| `TaskAssignee { userId, displayName }` | AI 员工用 `userId = 'agent-<id>'` 前缀，与真人员工共用 assignee 字段 |
| `onTaskChange` 事件（`project-service`） | 任务创建/确认/更新自动触发 AI 员工执行；执行完成回写再触发活动流/摘要 |
| `agent-headless-runner-registry` | **核心执行器**：主进程无人值守启动真实 Agent 会话（onComplete/onError） |
| `agent-orchestrator.isActive(sessionId)` | **心跳探测**：确认会话是否仍活跃 |
| `stopRegisteredAgent(sessionId)` | 中止/取消运行中的执行 |
| `project-agent-service.createLlmCaller` | 轻量 LLM 调用（执行结果分析、摘要、风险评估） |
| Workflow（agent 节点 + run） | P3：AI 员工可绑定 SOP 工作流，确定性流程执行 |
| `project-sqlite-store` | 新增 AI 员工档案表 + 执行记录表（同一 SQLite） |
| 项目摘要 / 风险报告 | 扩展纳入 AI 员工执行统计 |

---

## 3. 总体设计

```
                      ┌─────────────────────────────────────────────┐
                      │              项目管理（projects）             │
                      │  Task.assignee → agent-<id> / 真人 userId     │
                      │  任务可申请 per-task 权限（safe 基础 + 额外）   │
                      └───────────────┬─────────────────────────────┘
                                      │ onTaskChange（创建/确认/更新）
                    ┌─────────────────▼─────────────────┐
                    │   TodoProvider 注册表（并行分发）    │
                    │  feishu ── 钉钉 ── ★ agent(新增)    │
                    └─────────────────┬─────────────────┘
                                      │ 指派给 AI 员工时
                    ┌─────────────────▼─────────────────┐
                    │        AgentTodoProvider           │
                    │  1. 解析 AgentEmployee 档案         │
                    │  2. 构建执行 prompt（角色+任务+权限） │
                    │  3. 入队 → headless Agent 执行      │
                    │  4. onComplete/onError → 回写        │
                    │  5. ★ 心跳检查（保活/超时/中止）      │
                    └─────────────────┬─────────────────┘
                                      │ 结果回写
            ┌─────────────────────────▼──────────────────────────┐
            │  任务状态 / completionNotes / 活动流 / 执行记录表      │
            │  → 项目摘要、风险报告、AI 员工效能分析                 │
            └───────────────────────────────────────────────────────┘
```

设计原则：
- **不新增独立子系统**：AI 员工复用"外部平台员工"的心智模型（指派 → 执行 → 回写）
- **执行器可插拔**：第一版 headless Agent；P3 可绑定 Workflow SOP
- **权限按需**：默认 safe，任务创建时可申请额外权限（by-task）

---

## 4. 数据模型（sqlite 新增两表）

### 4.1 AI 员工档案表 `agent_employees`

```ts
interface AgentEmployee {
  id: string                 // UUID，对应 TaskAssignee.userId = 'agent-' + id
  name: string               // 显示名，如「前端工程师 · Nova」
  role: string               // 角色标签：前端 / 后端 / 测试 / 数据分析 / 文档 / 通用
  avatar?: string
  description: string        // 能力描述 → 注入 system prompt
  runtime: 'proma' | 'ai-sdk' | 'pi' | 'claude'
  channelId: string          // 默认渠道
  modelId?: string           // 默认模型
  systemPrompt?: string      // 自定义角色 prompt
  skills?: string[]          // 可用 Skill slug
  enabled: boolean
  totalTasks: number
  completedTasks: number
  avgDurationMs?: number
  failureCount: number
  createdAt: number
  updatedAt: number
}
```

> 工作区：**共享项目工作区**（`workspaceId` 不存员工档案，执行时取任务所属项目的关联工作区；项目无工作区时使用默认/新建隔离目录）。

### 4.2 执行记录表 `agent_executions`

```ts
interface AgentExecution {
  id: string
  projectId: string
  entityType: 'task' | 'subTask'
  entityId: string
  agentId: string
  sessionId: string          // 底层 Agent 会话 ID
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'
  prompt: string
  resultSummary?: string     // → completionNotes 来源
  outputFiles?: string[]
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  error?: string
  requestedPermissions?: string[]  // by-task 申请
  lastHeartbeatAt?: number   // 心跳时间戳
  startedAt: number
  completedAt?: number
}
```

---

## 5. 执行机制（核心）

### 5.1 AgentTodoProvider

在 `project-sync-service` 注册第三个 Provider：

```ts
const agentTodoProvider: TodoProvider = {
  name: 'agent',
  async createTodo(task, userId) {
    // 1. userId = 'agent-<id>' → 查 AgentEmployee（enabled / channelId 校验）
    // 2. 构建执行 prompt（角色 + 任务上下文 + 输出要求）
    // 3. 入队（异步队列，单员工单任务）
    // 4. 返回 { taskId: executionId }
  },
  async updateTodoStatus(taskId, status) {
    // 手动改状态 → 中止/取消对应执行（stopRegisteredAgent）
  },
  async queryTodoStatus(taskId) { /* 从 AgentExecution 派生 */ },
  async getUserIdByPaaUserId(paaUserId) { /* 'agent-<id>' 校验 */ },
}
```

### 5.2 触发链路（复用 `project-auto-sync`）

```ts
async function syncCreatedTask(task: Task): Promise<void> {
  if (isAgentAssignee(task)) {
    await dispatchToAgentEmployee(task)   // → agentTodoProvider
    return
  }
  for (const platform of ['dingtalk', 'feishu']) { /* 原有真人链路 */ }
}
```

### 5.3 权限模型：默认 safe + by-task 申请

- **默认 safe**：headless 执行在 safe 权限模式下运行（受限工具集：读文件、有限 Bash、无敏感写）
- **by-task 申请**：任务创建/编辑时，可勾选本任务需要的能力：
  - `bash`（执行命令）、`write`（写项目文件）、`web`（联网）、`mcp:<name>`（特定 MCP）
  - 申请记录到 `Task`（新字段 `permissionRequests?: string[]`）与 `AgentExecution.requestedPermissions`
  - 执行时按申请映射到权限配置（如 `permissionModeOverride` + 工具白名单 / `customMcpServers`）
- 项目管理员可在任务详情审批/撤销申请；未获批的申请不生效

### 5.4 共享项目工作区

- 执行时取**任务所属项目的工作区**（`workspaceId` 来自项目绑定；项目无工作区时创建 `agent-workspaces/projects/<projectId>` 隔离目录）
- 并发控制：同一项目同一时刻最多 N 个 AI 员工执行（防互相覆盖文件）；写操作建议员工各自使用子目录 `workspace-files/agents/<agentId>/`

### 5.5 心跳检查（保活 / 超时 / 恢复）

目的：异步队列执行时，防止 Agent 进程崩溃 / 回调丢失 / 卡死导致任务永远挂在 `running`。

```ts
// AgentTodoProvider 内部：running 执行注册表 + 定时心跳扫描（每 30s）
setInterval(scanHeartbeat, 60_000)

async function scanHeartbeat() {
  for (const exec of runningExecutions) {
    // 1. 回调已触发（onComplete/onError）→ 正常收尾，跳过
    // 2. 探测会话活跃：orchestrator.isActive(exec.sessionId)
    //    - 不活跃且无回调 → 标记 stale：写 AgentExecution(status:'stale', error:'会话失联')，
    //      任务回退 paused，活动流记录，等待人工重试
    // 3. 超时：startedAt + maxDuration（默认 60min，可 per-task 配置）→ 中止并标记 failed，
    //      任务回退 paused
    // 4. 更新 lastHeartbeatAt
  }
}
```

- 心跳来源：`orchestrator.isActive(sessionId)` + 定时扫描
- 兜底：执行记录表 `lastHeartbeatAt` 供诊断；stale/failed 均可从任务详情一键重试

---

## 6. AI 分析（结果 → 项目管理部门）

### 6.1 项目摘要/周报扩展
`generateProjectSummary` 增加 AI 员工维度：完成数 / 总数 / 成功率 / 平均执行时长 / 高风险任务。

### 6.2 风险报告扩展
`generateProjectRiskReport` 将 AI 员工执行结果纳入风险源：失败重试中的任务、stale 失联、产出质量异常。

### 6.3 新增「AI 分析」视图（项目管理内）
- 每个 AI 员工的效能卡片：任务数、完成率、平均耗时、失败率
- 最近执行记录（prompt / 结果 / 错误，可打开底层会话）
- 项目级 AI / 真人工作量占比

---

## 7. UI 设计

| 位置 | 内容 |
|---|---|
| 项目管理 → 团队/设置 Tab | 「AI 员工」区：新建/编辑/启停（名称、角色、runtime、模型、system prompt） |
| 任务创建/编辑 | assignee 选择器（真人 + AI 员工，🤖 标识）；by-task 权限申请勾选 |
| 任务详情 | 执行状态（排队/运行中/完成/失败/stale）+ 底层会话链接 + 产出摘要 + 权限审批/重试 |
| 看板 | 同列展示，按 assignee 过滤 |
| 项目管理 → 分析 | AI 员工效能 + AI/真人工作量占比 |

---

## 8. 安全与权限边界

1. **默认 safe**：headless 执行默认受限工具集
2. **by-task 申请**：额外权限按任务申请、可审批、可撤销（见 5.3）
3. **共享工作区并发控制**：同项目并发上限 + 员工子目录隔离
4. **心跳保活**：stale 检测、超时中止、失败回退可重试（见 5.5）
5. **可中止性**：任务手动改状态/删除 → `stopRegisteredAgent`
6. **审计**：全部执行写入 `agent_executions` + 活动流

---

## 9. 实施计划（分阶段）

| 阶段 | 内容 | 工作量 |
|---|---|---|
| **P0 核心闭环** | 两表 + AgentEmployee CRUD + AgentTodoProvider + 队列 + headless 执行 + 心跳检查 + 回写 + 团队 UI + 任务详情执行状态 | 4-6d |
| **P1 权限与体验** | by-task 权限申请/审批、assignee 整合、看板过滤、失败重试、并发控制 | 2-3d |
| **P2 AI 分析** | 摘要/风险报告扩展 + AI 效能分析视图 | 2-3d |
| **P3 进阶执行器** | AI 员工绑定 Workflow SOP（agent 节点）替代/补充 headless 直跑 | 2-4d |

---

## 10. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| 1 | 执行器 | **P0 headless Agent 直跑；P3 补 Workflow SOP**（差异见方案 v2 §1 回复） |
| 2 | 权限 | **默认 safe + by-task 申请额外权限**（任务可勾选 bash/write/web/mcp，管理员审批） |
| 3 | 工作区 | **共享项目工作区**（员工子目录隔离 + 并发上限） |
| 4 | 执行模型 | **异步队列 + 心跳检查**（30s 扫描，isActive 探测 + 超时中止 + stale 回退可重试） |
