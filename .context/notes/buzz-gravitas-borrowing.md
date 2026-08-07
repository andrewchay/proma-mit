# Buzz → Gravitas「中小公司 Agentic OS」演进建议

> 时间：2026-08-07
> 调研对象 A：`~/LLM/buzz`（Block 开源，Apache 2.0，Nostr 团队协作中继）
> 调研对象 B：`~/LLM/proma-mit` = **Gravitas**（Proma v0.11 的改造衍生版，品牌资产在 `design/gravitas`）
> ⚠ 说明：本目录 == 当前工作区 `project/` 同源（HEAD 均为 239a0c5）。称谓纠偏：**本项目叫 Gravitas**，非上游 Proma；README 沿用 Proma 自述口径，但演进方案应针对 Gravitas 自己的改造特征。

---

## 0. 一句话

**Buzz 的答案是一组心智模型：「一切皆签名事件 + 中继即工作区 + 人机对等身份 + 单一审计轨迹」。**
Gravitas 不需要 Nostr 底层，但**把这组心智吸收进「团队协作」方向**，能把已长出的团队零件（AI 员工、协作子会话、飞书/钉钉/微信 bridge、Server 多租户、Workflow、Todo/日程）收口成同一事实源，从而支撑"中小公司内部团队 + Agent"的 Agentic OS。

---

## 1. Gravitas 现状盘点（为方案定位，不重述文档）

### 1.1 形态
- Electron 桌面客户端（Bun monorepo：packages/shared|core|ui + apps/electron|executor|server|web）
- **本地优先**：会话/工作区/附件/配置存 `~/.proma/`，JSON/JSONL，无本地数据库
- 同时已有 **server 路线**：Bun server + Postgres 多租户 store + WebCrypto secret + Redis Stream replay + S3 workspace 文件 + audit + budget/ratelimit（P0-P5 基础，Web UI/OIDC 待后续）

### 1.2 已具备的"团队 + Agent"零件（这正是 Gravitas 相对泛聊天客户端的主要增值）
| 零件 | 状态 | 相关入口 |
|---|---|---|
| **AI 员工**（agent-<id> assignee、by-task 权限、心跳、并发排队、团队 UI、效能分析）| P0-P3 已实施（0.11.3-0.11.6） | `agent-todo-provider`、`agent-employee` 表 |
| **协作子会话**（父子树、并分子任务、并行执行、会话级排队、modelId 继承）| 近期密集迭代已提交 | `agent-orchestrator`、collaboration 面板 |
| **远程机器人 bridge**（飞书/钉钉/微信）| 飞书/钉钉可用、微信入口 | `dingtalk-bridge`、`feishu`、`wechat-bridge` |
| **Server 多租户** | P0 基础（Postgres store、audit、budget、lease、replay）| `apps/server` |
| **Workflow 引擎** | 有 | `workflow-service`、agent 节点 |
| **Automation（定时任务）** | 有 | automation MCP / 运行中心 |
| **项目管理 / 日程 / Goal** | 有（含 AI 维度摘要/风险）| `project-service`、`goal` |
| **灵动岛（会话状态机）** | 已从"通知条"演进到"状态条"方向 | `agent-island-service` |
| **操作审计** | WebBridge/Computer Use 有，Agent/Workflow/项目分散 | audit jsonl |

### 1.3 关键洞察
Gravitas 具备 Buzz 想统一的所有零件，但各自分散。**缺口不是功能，是"统一事件事实源 + 统一成员身份 + 统一审计"。** 这与 Buzz 的收敛心智完全对位。

---

## 2. Buzz 与 Gravitas 的心智映射

### 2.1 收敛心智对照

| Buzz 机制 | Buzz 怎么统一 | Gravitas 现状（各做各） | 可吸收的收敛 |
|---|---|---|---|
| 统一事件日志 | 人言/动作/review/审批 都是同一种事件 | Agent 会话 / Workflow run / Automation run / AI 员工执行 各自日志 | **统一 RunEventEnvelope**，所有运行记录回流同一可查事实源 |
| 人机同一身份 | Agent 用对等 pubkey 进同一 channel | AI 员工 = `agent-<id>` 前缀 + 外部 bot（飞书/钉钉/微信）各有身份 | **统一「成员」心智**：真人/AI 员工/bot 都有 Profile+角色+可指派+审计 |
| workspace 即边界 | channel membership 是唯一门槛 | 本地工作区 / server 多租户 / 项目管理 / 沙箱 权限分散 | **统一"边界即隔离"**为一套权限模型（本地+server 对齐） |
| 单一审计轨迹 | 全员签名 hash 链 | 操作审计 / Agent / Workflow / 项目审计分散 | **收敛单审计真源**，做 Proactive 凭据层 |
| kind 可扩展零破坏 | 新功能 = 新 kind | 已用模块注册表防入口膨胀 | 保持模块注册表（已做对，不新增一级模式） |

### 2.2 对官方三大方向（Proactive / 个人注意力 / 团队协作）的落点
- **团队协作（借鉴价值最高，Gravitas 已具雏形）**：Skills 分发（以项目/团队工作区为单位、带版本+权限）、工作区/文件共享（延续 server 的 Postgres+S3，加"谁改了哪个文件的共享事件流"）、Todo 协同（Todo/看板变团队可订阅事件流，Agent 帮人解压缩）、Agent 间可访问性（定义"Agent 可被他人调用做确认/小任务"协议，复用协作子会话曲线）、大上下文同步（团队级 User/Project Profile）。
- **Proactive**：Buzz 审计链 → 让每次主动动作留有可回放事件轨迹（"它为什么这么主动"），接上官方想的自动服务器/费用 Audit。
- **个人注意力**：官方 mailbox = Todo+看板+需人工确认工作 → 抽象为"一条可流转、可指派、可联动 Agent 的事件"，与灵动岛 Planning 投影、AI 员工 by-task 权限衔接。

---

## 3. Buzz 哪里不该学

- **全量切 Nostr + relay**：与 Gravitas 本地优先冲突 → 保留本地优先，事件日志做成 server 可选增量能力。
- **Schnorr 全员签名**：单机成本高 → server 端 OIDC/JWT + 本地可信，审计用 hash 链。
- **relay mesh（iroh）**：中小公司过度工程 → server 单点 + Postgres FTS。
- **事件粒度极高的消息协议**：Gravitas 面向普通人 + 模块化，不是协议产品 → 吸收心智，技术自建。

---

## 4. 建议落地的 5 个高杠杆动作（按优先级，不推翻现有架构）

| 动作 | 内容 | 关联现有代码 |
|---|---|---|
| **P0-1 统一 Run 事件总线** | 定义 `RunEventEnvelope`（started/progress/waiting_action/completed/failed + source + workspace + audit），Agent/Workflow/Automation/AI 员工运行记录收敛同源 | `agent-event-bus.ts`、`workflow-service.ts`、`agent_executions` 表 |
| **P0-2 团队工作区共享** | 以项目/团队工作区为边界统一文件/Skills/会话/权限可见与同步；先 Skills 分发>文件共享>Todo 事件流 | `agent-workspace-manager.ts`、server workspace、project 关联工作区 |
| **P1-3 成员身份一等公民化** | 真人/AI 员工/外部 bot 统一「成员」：Profile+角色+可指派+可查询+审计；对 GC 人机对等心 | `agent_employees`、`TodoProvider` 注册表、飞书/钉钉 mapping |
| **P1-4 审计收口** | 分散审计收到单一真源，作为 Proactive 凭据层，产品可见 | audit jsonl、server audit、Agent/Workflow 记录 |
| **P2-5 Todo 事件流化 + Agent 解压缩** | Todo/看板变团队可订阅语义流，联动 Proactive 与 mailbox | `project-service`、goal todos、agent-island Planning 投影 |

---

## 5. 风险与边界

- 不引入第二事实源：明确"本地优先文件 + server 共享事件流"边界，避免本地/server 双份真相。
- 事件化 ≠ 协议化；别把 Gravitas 变成协议驱动产品。
- 团队协作不变监控：不搞全量人员画像/集中数据采集（延续 habi 借鉴声明）。
- 入口收敛：坚持模块注册表 / mailbox 收纳。

---

## 6. 相关借鉴分析索引（覆盖旧笔记）

| 文档 | 主题 |
|---|---|
| `.context/notes/habi-proma-borrowing.md` | 生态心智 / 统一能力契约 / 五层产品分层 |
| `.context/notes/laminar-design-borrowing.md` | 服务端借鉴 |
| `.context/notes/proma-agent-island.md` | 灵动岛=会话状态机 |
| `.context/notes/ai-employees-design.md` | AI 员工（P0-P3 已实施） |
| docs/habi-产品设计全景.md | habi 底座/复利/收敛器 |
| **本文（buzz → gravitas）** | 事件日志 / 人机对等身份 / 单一审计 / 团队协作事件流，聚焦 Gravitas 现状 |

---

## 附：与上一版（旧笔记 buzz-agentic-os-borrowing.md）的关系
- 上一版对象代码相同（同仓库），但称谓用"Proma"、并按上游官方三方向叙述。
- 本版明确项目名为 **Gravitas**、按 Gravitas 已具备的团队零件定位方案，其余结论一致。旧笔记可删除或保留作上游视角，建议以本版为准。
