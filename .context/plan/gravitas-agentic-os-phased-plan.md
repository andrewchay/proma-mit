# Gravitas Agentic OS — 分批施工方案（两部分）

> 时间：2026-08-07
> 当前用户核心诉求：
> 1. 分两部分：先「必须完成」的地基，再「后续可完成」的批次；
> 2. 员工体系除 AI 员工（agent-<id>）外，**必须建立从飞书/钉钉拉回人员信息并做双向 mapping**，形成统一的真人员工成员体系。
> 配套：`buzz-gravitas-borrowing.md`（聚焦 5 高杠杆）、`buzz-gravitas-full-leverage.md`（34 动作全库）。

---

## 0. 现状确认（基于代码）

### 已有（真人员工相关）
- `UserMapping`：`paaUserId ↔ feishuUserId / dingtalkUserId / dingTalkUnionId`，**单向映射结构已存在**
- `TodoProvider` 注册表：`'feishu' | 'dingtalk' | 'agent'` 三种已就绪
- `getUserIdByPaaUserId(paaUserId)`：本地 PAA 用户 → 平台 ID
- AI 员工：`agent-<id>` assignee + `AgentEmployee` 档案 + `AgentExecution` 记录（agent-employee-service.ts）
- 项目同步：`project-auto-sync.ts` + `project-sync-service.ts`

### 关键缺口（正是要补的）
1. **PAA 用户主要来自手动/本地，没有「从飞书/钉钉拉回组织通讯录 → 自动建立成员档案 + 双向映射」的完整链路**。
2. `UserMapping` 是「本地 PAA 用户 → 外部平台 ID」单向，缺「外部平台 ID → 本地成员」的反向沉淀为团队目录。
3. 真人员工 vs AI 员工（vs 外部 bot）仍是三套身份心智，未统一成「成员」。
4. 拉取回来的通讯录成员，尚未纳入「可按 member 查询、可指派、有活跃状态（presence）」的团队目录。

---

## 第一批：必须先完成（地基，硬依赖）

> 逻辑：没有统一成员身份，事件无从归属到人、Todo 协同无法跨平台对齐、统一审计与 Proactive 无法落地。
> 所以第一批 = 「成员身份统一 + 跨平台双边 mapping + 基础事件事实源」。

### PH1-A. 从飞书/钉钉拉回人员 + 双向 mapping（用户点名，最高优先）
- [ ] 实现**通讯录回拉**：从飞书通讯录、钉钉通讯录拉取组织成员（姓名、部门、外部 user_id / unionId）
  - 复用已有 `contact-search-service.ts`、`feishu-bridge`、`dingtalk-bridge` 的基础能力
  - 注意飞书 `find_by_department` 复数路径、department 枚举、可见范围等已踩过的坑（见 todo.md 需求3）
- [ ] **自动建立/更新 `UserMapping`**：外部平台 ID + displayName → 落成 members 档案（paaUserId 可用外部 unionId 兜底生成）
- [ ] **双向映射打通**：`getUserIdByPaaUserId`（本地→平台）已有；补「平台→本地」反向，形成可查询的团队成员目录
- [ ] **成员目录服务**：`listMembers()` / `findMember()`，供指派、@提及、权限配置、Agent 查询
- [ ] **手动 mapping 保留**：无法自动匹配的成员，支持手动关联（source='manual'）

### PH1-B. 成员身份一等公民化（统一真人/AI员工/bot）
- [x] 新建 `member-directory-service.ts` 统一**成员视图**：真人(members)+AI员工(agent_employees)+外部bot(飞书/钉钉)，聚合返回统一 `MemberResult`（kind 区分）
- [x] `MemberResult` 共享类型补 `role`/`platform`
- [x] IPC `LIST_MEMBER_DIRECTORY`/`COUNT_MEMBER_DIRECTORY` + preload `paa.project`
- [x] 团队 Tab 成员面板改为统一视图：真人/AI员工/Bot 分组计数 + 列表
- [x] 负责人选择器统一：ContactPicker 增加 `includeAgents`/`onMemberSelect`，新任务表单可同处选真人/AI员工（AI走 agent-<id>，真人走 paa-<name>）

### PH1-C. 统一基础事件事实源（最小版）
- [x] `AppEventEnvelope` 补 `memberId?`/`workspaceId?`（五态全加）+ `createAppEventBase` 支持携带
- [x] `RunRecord` 同步补 memberId/workspaceId；`run-store.toRunRecord` 透传
- [x] `app-event-bus` 新增 `resolveMemberForSession`：按 sessionId 反查 AI 员工执行 → memberId=`agent-<id>`；`toAppEvent` 归一化时自动带上
- [x] 测试：run-store 透传 + app-event-attribution（resolveMemberForSession / toAppEvent / 非AI不带）
- [ ] 真人员工/普通会话归因到具体真人（当前无稳定归属，后续可按 workspace/当前用户）

### PH1-D. 审计最小收口 + 网络边界
- [x] 审计带成员归属：`AgentAuditEvent` 补 `memberId?`；web-bridge/computer-use/external-bridge 三个审计写入时通过 `resolveMemberForSession` 补执行者归属；`agent-audit-service` 聚合自然带出
- [x] 测试：audit-member + 既有 external-bridge-audit（共 34 用例全过）
- [x] 网络边界确认：server 侧已有 `mcpEgress.allowedOrigins` 防 SSRF（未配置即禁用 MCP）；Web Bridge 导航依 README 走逐次权限确认，无绕过点 → 无需额外加 is_private_ip

### 第一批验收标准
- 从飞书、钉钉各拉回一批通讯录成员，成功落成成员档案
- 同名/同人跨平台自动对齐（unionId 匹配），无法自动的可手动 mapping
- 指派任务可选择真人(来自IM) 与 AI 员工同一成员列表
- 一次事件（如指派）即可归属到具体真人/Agent，并在审计可见

---

## 第二批：后续可完成（在地基之上迭代）

### PH2-A. 团队协作共享
- [x] **团队 Skills 目录（轻）**：`team-skill-directory-service` 汇总所有工作区从别处导入的 Skill（来源/版本/待同步），一键同步全部过期；AGENT_IPC 增 `LIST_TEAM_SKILL_UPSTREAMS`/`SYNC_TEAM_SKILL_UPDATES`；设置页 Skills Tab 新增 `TeamSkillDirectoryPanel`。复用既有 importSkillFromWorkspace/updateSkillFromSource（`de38be4` 后续批次）
- [ ] Skills 包分发（团队实体 / 版本+权限，跨真团队）——若未来建团队实体再补
- [ ] **工作区文件共享事件流**：`workspace-file-event-service`（JSONL + memberId 归因）已建，Write/Edit 工具成功后记录，IPC `LIST_FILE_EVENTS` 已接；UI 展示面板待补
- [x] **Todo 事件流化**：`todo-event-service`（JSONL 语义流），订阅 `project-service.onTaskChange` 记录创建/完成/改派/删除，memberId 归因（assignee）；IPC `LIST_TODO_EVENTS` + 团队 Tab `TodoEventPanel` 动态展示
- [ ] Todo 事件流：Goal todo 也并入同流（当前仅项目管理 Task）
- [x] **Agent 解压缩**：`InspectTodo` 核心工具（agent-runtime tool-registry 注册），取 Todo 完整上下文+同项目相关待办，Agent 据此解释/发现关联/预警
- [x] **团队级 Profile**：`team-profile-service`（每工作区 JSON），注入 `buildDynamicContext` 的【团队上下文】；IPC get/update + Settings 编辑面板

### PH2-B. 统一 Run 事件总线（完整版）+ 运行中心
- [x] Run Center：`RunRecordQuery` 补 memberId?，`run-store.query` 按成员过滤（`f9463d6`）
- [x] Run Center UI：成员过滤输入 + 每条记录显示执行者徽标（agent-<id>→🤖 / paa-姓名）（`f9463d6`）
- [x] Run Center 导出：`exportToFile` + IPC EXPORT + 保存框 + UI 导出按钮（`de38be4`）
- [ ] Agent/Workflow/Automation/AI员工 全部运行记录收敛统一 `RunEventEnvelope`（部分已有；纯非-agent 源 run 不带 memberId 待补）
- [ ] 全量事件可回放（按 member/workspace/time 重建时间线）

### PH2-C. Proactive 与注意力
- [x] **mailbox 抽象（首版）**：`team-mailbox-service` 聚合 Agent 需人工确认（权限 permissionService / 提问 askUserService / 计划审批 exitPlanService）为统一收件箱，带成员归属；IPC `LIST_MAILBOX`/`COUNT_MAILBOX_PENDING` + 团队 Tab `MailboxPanel`（可打开会话处理）。
- [x] **mailbox 扩源**：指派给成员的待办（项目管理 `listProjectWorkItems`，未完成+有 assignee）并入 inbox（kind='todo'，memberId=assignee），MailboxPanel 展示
- [x] **Proactive 动作可回放**：`ProactiveScheduler.execute` 每次运行沉淀进统一运行事实源（Run Center `source:'automation'`，标题=任务标题，detail=触发方式+结果）；自动化模块已有 `ProactiveSchedulerSettings` 展示定时任务+运行(trigger/status)
- [x] **自动服务器/费用 Audit**：`cost-audit-service`（近7天窗口：总费用/token、按模型/工作区分布、Top会话、环比、异常告警），IPC `RUN_COST_AUDIT` + 自动化模块 `CostAuditPanel` 手动触发展示；`RunCostAudit` Agent 工具（可自动/按需审计并在会话中主动报告）
- [x] ~~灵动岛会话状态机完善~~：**已达成**（动态岛已是会话状态机：phase running/needs-interaction/completed/error + attention/unread + attentionScore 优先级 + 三级节流 PUSH_THROTTLE=80ms / AGENT_STREAM_PUSH_THROTTLE=2000ms + 无变化跳过）。本次补**状态无变化跳过**（pushKey 一致时不重复推送，避免 running 流对常驻 needs-interaction 的重复重绘）

### PH2-D. 数据复利与安全增强
- [x] **成功输出转资产**：`asset-proposal-service`（从会话证据提炼 Workflow/Skill 提案：决策/写回/验证→步骤+提示词+关键工具，`proposalToText`）+ `ProposeAssetFromRun` Agent 工具；evidence-service 改为懒加载数据源（可注入 stub 便于测试）
- [ ] 本地 Context Hub / Work Graph（Session/Run/Task/Calendar/Artifact 关联）
- [ ] Token/成本记账收敛（server ledger + 本地统计统一）
- [ ] 凭据统一治理、审批门收敛

### PH2-E. 触达面扩大（团队真正可用）
- [ ] server Web UI 补全（团队浏览器也能用）
- [ ] Bridge 即远程入口（飞书/钉钉/微信 = 手持远程入口，复用成员 mapping）
- [ ] 多 surface 统一任务状态

### PH2-F. 长期/可选
- [ ] 成员间 Agent 互调协议（他人调你的 Agent 做确认）
- [ ] 多社区/多租户精细化（URL 即边界）
- [ ] 插件/SDK 开放（统一扩展契约）

---

## 依赖关系图

```
第一批（地基）
  PH1-A 飞书/钉钉人员拉取 + 双向mapping  ◄── 你最强调的
     │
     ▼
  PH1-B 成员身份统一（真人/AI员工/bot = Member）
     │
     ├─────────────► PH1-C 统一事件事实源(带memberId)
     │                       │
  PH1-D 审计最小收口          ▼
                       第二批所有协同/Proactive/复利
```

- PH1-A 是**一切的地基**：没有成员档案，PH1-B/C/D 与第二批都悬空。
- PH1-B 依赖 PH1-A（要统一，先得有统一的成员来源）。
- PH1-C 依赖 PH1-B（事件要归属 member）。
- PH2 全部依赖第一批完成后才有意义（协同/Proactive 都要"归属到成员"）。

---

## 与既有借鉴分析的承接
- 复用 todo.md「飞书通讯录搜索加固」已踩的坑（复数路径、department 枚举、可见范围）
- 复用 `ai-employees-design.md` 的 AgentEmployee 模型扩展为 Member
- 复用 `buzz-gravitas-full-leverage.md` 的 B1/B2/B3/A1/F1 等条目，归并到本分批方案
