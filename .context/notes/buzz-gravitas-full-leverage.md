# Gravitas「中小公司 Agentic OS」— 全部演进杠杆动作（不受数量限制）

> 时间：2026-08-07
> 配套：`buzz-gravitas-borrowing.md`（聚焦的 5 个高杠杆动作）
> 本文把 Buzz 整套设计映射到 Gravitas 现状，**不设数量上限**地列出所有值得做的演进杠杆，
> 每条都标注 Buzz 来源、Gravitas 对应改动、工作量量级（S/M/L）与当前是否已有雏形。

---

## 图例
- 工作量：S(≤2d) / M(≤1w) / L(>1w)
- 状态：🟢已有雏形需收口 / 🟡有零件但缺统一 / 🔴新建设
- 来源：Buzz 的哪个机制启发

---

## A. 统一事件事实源（Buzz: 统一事件日志 / kind 路由）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| A1 | **统一 RunEventEnvelope** | Agent 会话/Workflow run/Automation run/AI 员工执行 收敛到统一事件结构（started/progress/waiting_action/completed/failed + source + workspace + audit） | 🟡 | L |
| A2 | **全量事件可回放** | 所有会话/运行可按 (workspace,time,sessionId) 重建时间线，作为 Proactive 与审计的凭据 | 🟡 | L |
| A3 | **kind/type 即路由注册表** | 用"事件类型注册表"新增能力=注册新 type，对旧 listener 零破坏（吸收 Buzz kind 心智，不整套协议） | 🟡 | M |
| A4 | **跨进程事件总线归一** | 主进程 agent-event-bus / server 运行记录 / renderer 订阅 用同一套事件 schema | 🟡 | M |
| A5 | **审计 hash 链** | 复用 Buzz 防篡改思想，把分散审计日志接成可校验链，防篡改/可验证 | 🟡 | M |

---

## B. 统一成员身份与访问（Buzz: 人机对等身份 / workspace 即边界）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| B1 | **成员身份一等公民化** | 真人 / AI 员工 / 外部 bot（飞书/钉钉/微信）统一「成员」：Profile + 角色 + 可指派 + 可查询 + 审计轨迹 | 🟡 | L |
| B2 | **统一权限模型** | 本地工作区 / server 多租户 / 项目管理 / 沙箱 权限收敛为"边界即隔离"一套心智 | 🟡 | L |
| B3 | **成员目录/通讯录** | 团队级成员目录，供指派、@提及、权限配置，Agent 可查询 | 🟡 | M |
| B4 | **Agent 可被他人调用** | 定义"他人可调用你的 Agent 做确认/小任务"的协议（很省事但价值高） | 🔴 | L |
| B5 | **外部 bot 统一接入** | 微信从入口补全为完整 bridge；飞书/钉钉/微信用同一 connector 契约 | 🟡 | M |

---

## C. 团队协作共享（Buzz: relay 承载共享事件与媒体）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| C1 | **Skills 包分发** | 以项目/团队工作区为单位分发 Skills，带版本 + 读写权限 | 🟡 | M |
| C2 | **工作区文件共享事件流** | server 侧 Postgres+S3 workspace 文件 + "谁的 Agent 改了哪个文件"的共享事件流 | 🟡 | L |
| C3 | **Todo 事件流化 + Agent 解压缩** | Todo/看板变团队可订阅语义流，Agent 帮队友解释别人的 Todo | 🟡 | M |
| C4 | **团队级 User/Project Profile** | 最简化有效的大上下文同步（团队版 user profile，可迭代可统计） | 🔴 | M |
| C5 | **协作子会话曲线复用** | 用已有协作子会话树承载"团队共享上下文"，不用另起炉灶 | 🟡 | S |

---

## D. Proactive 与注意力（Buzz: 审计链凭据 + 官方 mailbox/看板）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| D1 | **Proactive 动作可回放** | 每次主动动作留事件轨迹，用户可看"它为什么这么主动" | 🔴 | M |
| D2 | **自动服务器/费用 Audit** | 把审计做成产品能力，定时自动检查服务器状况、服务状态、费用 | 🔴 | M |
| D3 | **mailbox 抽象** | "Todo + 看板 + 需人工确认工作"收敛为一条可流转、可指派、可联动 Agent 的事件 | 🟡 | L |
| D4 | **灵动岛会话状态机** | 已从"通知条"→"状态条"（session phase + attention/unread） | 🟢 | M（继续完善） |
| D5 | **注意力分级/节流** | 参考官方 attentionScore + 推送节流，避免多 Agent 刷屏 | 🟢 | S |

---

## E. 数据与心智复利（Buzz: 中继生态 → 本地 Context Hub）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| E1 | **本地 Context Hub / Work Graph** | 关联 Workspace/Session/Agent Run/Workflow Run/Task/Calendar/Artifact，做本地事实源复利 | 🔴 | L |
| E2 | **成功输出转资产** | 把成功运行输出沉淀为 Skill / Workflow / 项目事实（与 Proma Coach 联动） | 🔴 | M |
| E3 | **Token/成本记账收敛** | server 已有 usage/cost ledger + budget/ratelimit，与本地 token 统计统一 | 🟡 | M |
| E4 | **运行记录中心（Run Center）** | 所有运行记录（Agent/Workflow/Automation/AI 员工）一个视图可查/可重试/可导出 | 🟡 | M |

---

## F. 安全与治理（Buzz: 全员签名边界 → 收敛权限审计）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| F1 | **操作审计收口单真源** | WebBridge/Computer Use/Agent/Workflow/项目 审计收敛 | 🟡 | M |
| F2 | **凭据统一治理** | 渠道密钥 / server secret / 外部 bot token（飞书/钉钉/微信）统一凭据管理 | 🟡 | M |
| F3 | **审批门收敛** | by-task 权限 / 计划确认 / 敏感操作接管 收敛为一套审批心智 | 🟡 | M |
| F4 | **SSRF/网络边界治理** | server 侧对齐 Buzz `is_private_ip` 等网络访问边界 | 🟢 | S |

---

## G. 客户端面（Buzz: 多 surface 一底座）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| G1 | **server Web UI 补全** | server 已有多租户基础，补完整 Web UI 让团队浏览器也能用 | 🟡 | L |
| G2 | **Bridge 即远程入口** | 飞书/钉钉/微信不只是一设置项，而是本机 Gravitas 的手持远程入口（类 habit 思考） | 🟡 | M |
| G3 | **多 surface 统一任务状态** | 桌面/Quick Task/菜单栏/Bridge 共享同一任务状态与上下文 | 🟡 | M |

---

## H. 长期/可选（Buzz relay mesh 的省事替代）

| # | 杠杆 | 说明 | 状态 | 量级 |
|---|---|---|---|---|
| H1 | **server 高可用演进** | 单点足够中小公司；仅在负荷增长时做多 worker lease / replay 强化 | 🟢 | L |
| H2 | **多社区/多租户精细化** | URL/域名即工作区的边界心智（吸收 Buzz Community），不做 relay mesh | 🟡 | M |
| H3 | **插件/SDK 开放** | 第三方扩展统一契约（吸收 Buzz harness 与官方扩展思考） | 🔴 | L |

---

## 汇总：按主题分组的全量杠杆数

| 主题 | 项数 | 含🟡收口类 | 含🔴新建 |
|---|---|---|---|
| A 统一事件事实源 | 5 | 4 | 0 |
| B 统一成员身份与访问 | 5 | 3 | 2 |
| C 团队协作共享 | 5 | 5 | 1 |
| D Proactive 与注意力 | 5 | 4 | 2 |
| E 数据与心智复利 | 4 | 2 | 2 |
| F 安全与治理 | 4 | 4 | 0 |
| G 客户端面 | 3 | 3 | 0 |
| H 长期/可选 | 3 | 2 | 1 |

**总计 34 个杠杆**（不含 H 长期可选则为 31 个）。绝大多数是🟡（已有零件需收口），真正需要全新建设的🔴集中在 B4 Agent 互调、C4 团队 Profile、E1 Context Hub、D1 Proactive 凭据、H3 插件 SDK。

---

## 建议的分批节奏（回到"5 个高杠杆"之外再补充）

- **第一批（先做，地基）**：A1、A4、F1、F4（统一事件 + 审计 + 网络边界）
- **第二批（团队协作主干）**：C1、C2、B1、B2、E4、D3
- **第三批（Proactive/复利）**：D1、D2、E1、E2、B4
- **第四批（面/长期）**：G1、G2、C4、H2、H3

> 说明：这不是"全都要做"的清单，而是"值得考虑的完整动作库"。落地优先级仍以
> `buzz-gravitas-borrowing.md` 的 5 个高杠杆为先；本文按需挑选，避免一次铺开。
