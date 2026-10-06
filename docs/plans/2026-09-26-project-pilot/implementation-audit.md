# Project Pilot 实现度审计

日期：2026-09-26 GMT+8；源码基线 HEAD `017f9088`。
范围：三路只读审计，父会话交叉读取设计、R01、台账、入口与调度源码。未运行新测试、未启动 Electron、未调用真实模型。本文的“已有”是静态源码存在且找到接入，不等于本次实测通过。

仓库：`/Users/chaihao/.proma/agent-workspaces/proma-mit/project`；`/Users/chaihao/LLM/proma-mit` 为其符号链接。外部附件和工作区级上下文受 Read 路径限制，未绕过；依据仓库内 design.md 审计，不断言附件与仓库副本字节一致。

## 1. 总结

已有后台运行、已指派任务派发、研发 Review、安全交付与部分审批通知基础；尚无证据证明“项目管理者持续组织多角色、跟进评审/返工、依赖唤醒、必要审批后自动续跑”的完整闭环。

Pilot 目录审计前只有 design.md，状态为 P0 待开工；apps/packages 中未发现 ProjectPilot/projectPilot/project-pilot 命名实现。进一步核查事件与派发链，同样未见持续的项目级管理循环。不能把基础设施数量折算成产品实现百分比。

## 2. 需求实现矩阵

| 原始需求 | 状态 | 事实 |
|---|---|---|
| 管理者持续决定下一步、组织不同角色 | 核心闭环未实现 | 当前从已配置 assignee 派发，没有项目目标到持续规划的控制循环 |
| 不进入工作区/会话页面仍能工作 | 底层已有，项目体验未接通 | headless 可无窗口调用模型，Proactive 可 newSession；不等于项目自动获得 runtime |
| 已指派员工自动执行 | 已有 | auto-sync 监听任务事件，队列与并发/重复派发保护已有 |
| 依赖解除后自动派发下游 | 未见接线 | blocker 计算存在，链路更新后未唤醒对应下游 |
| 技术审阅→返工→再审自动组织 | 未实现 | 人工 Review/requestChanges 已有，但不是自动 Reviewer 循环 |
| 必要审批主动通知、答复后项目继续 | 部分基础 | 会话通知/团队收件箱存在，聚合不完整且处理仍进入会话 |
| 项目/看板合并 | 未实现 | 仍是两个顶层 tab；BoardOverview 为统计卡片 |
| 项目内 tab 整合 | 未实现新方案 | 仍 11 个可见 tab，协作链路面板已有 |
| 团队交互简化 | 未实现 | 全局员工 roster、渠道/模型/workspace/治理混在同页 |
| 工作区绑定移配置 | 未实现 | 独立 tab；项目资料授权、员工工作区、任务工作区分离 |
| 减少配置/一次开通 | 部分基础 | 已有模板和默认回落，未形成端到端开通；不能说完全无模板 |
| 项目知识 | 已有授权与检索基础 | 绑定知识库是实际能力，不代表自动沉淀或智能管理；可移配置但不能删语义 |

## 3. 后台运行与调度证据

以下 `L/` = `apps/electron/src/main/lib/`。

- 启动注册：`apps/electron/src/main/index.ts:506–507` → `main/ipc.ts:4730–4731` → `L/work-module-ipc-handlers.ts:1001–1006`，注册 employee provider/auto-sync；员工心跳 `L/agent-employee-service.ts:1068–1115`。
- 自动派发：`L/project-service.ts:146–182` 发任务变更 → `L/project-auto-sync.ts:25–74,125–149` → `L/agent-employee-service.ts:422–567`。已有项目/全局并发和 per-task 锁。它选择的是已有负责人，不是智能选人。
- 后台执行：`L/agent-employee-service.ts:571–679` 创建 session 并调用 headless；`L/agent-service.ts:416–444` 中窗口仅承担事件同步，无窗口仍调用 orchestrator。`agent-orchestrator.ts:674–686` 按 workspace/session 解析 cwd。
- 调度：`L/agent-service.ts:106–133,150–200` 注册 runner、恢复、newSession；`L/proactive-scheduler.ts:114–125,150–202` 恢复/执行/三次定时失败暂停。`L/proactive-target-validation.ts:23–70` 只允许 proma/ai-sdk、safe/plan，要求有效 workspace/channel/model。
- Proactive UI/部分 IPC 受开发门禁，不代表 scheduler 的启动恢复也停止；应用退出/休眠不能当作云端常驻。
- `L/proactive-project-check.test.ts:1,55–64` 明确是确定性 Git runner；`L/agent-development-execution.test.ts:13–28` 使用 stub headless runner。未将它们当作真实模型自治证据。

## 4. 关键断口与权限风险

### 4.1 任务与依赖

- `L/project-sqlite-store.ts:1844–1882` 可计算上游完成/交接 accepted 的阻塞。
- `L/project-auto-sync.ts:52–73` 处理当前任务；`L/project-chain-service.ts:250–266` 保存 revision 后返回，未见下游唤醒。
- 员工心跳仅扫描已有 queued/running execution（`agent-employee-service.ts:974–985`），不扫描所有解除依赖的任务。
- 研发启动检查 blocker（`:582–592`）；普通/Workflow 路径未见等价闸门。研发遇阻塞转错误/暂停而不是等待依赖，需统一 readiness。
- `project-service.ts:210–212` 的 createSubTask 直接转 store，无同等任务变更事件；不能假定创建子任务即自动派发。
- external-sync 在 auto-sync 提前返回（`:34–36`），事件覆盖需按来源补测。

### 4.2 交付与返工

- `agent-employee-service.ts:795–937`：execution completed 不等于任务完成，主任务 paused/待确认，研发分支可采集证据和冻结交付。
- `development-review-service.ts:240–291`：accept/reject 与 requestChanges 分开；后者才更新 pending 并幂等派发。仅拒绝交付不能当作已返工。
- 研发返工复用 session/worktree 且检查执行环境一致（`agent-employee-service.ts:603–634`）。
- 员工 `delegationDepth:1` 限制自行开协作子会话（`:618–624`），主管应使用独立的系统编排命令，不让执行员工递归扩队。

### 4.3 审批恢复

- Workflow resolveApproval 在 `workflow-service.ts:663–704` 将后继标 ready；`workflow-ipc-handlers.ts:91–107` 之后仅 reconcile 员工终态，没有调用 executeWorkflowRun。
- `workflow-run-executor.ts:41–74` 才执行后继；定时 scheduler 创建新 run，不负责恢复已有待审批 run。
- 此为指定路径的静态断口，尚未真机复现，不外推为所有 Workflow 都无法续跑。若 Pilot 首版复用该路径，必须作为前置验收项；否则独立跟踪，不能无界扩范围。

### 4.4 项目上下文与权限

- `project-workspace-bindings.ts:1–9,35–48`：绑定是资料授权，不创建会话/启动模型/共享文件。
- 普通执行 workspace 优先 Task→Employee→全局设置（`agent-employee-service.ts:575–581`），不是从项目绑定可靠推导。
- `agent-session-project-service.ts:22–43` 有 projectId/正式绑定校验；普通员工新会话和 Proactive newSession 未像研发路径自动注入完整项目关联。
- 普通员工旧路径含 bypassPermissions（`agent-employee-service.ts:581–592,650–664`），不能直接扩展为全项目自治角色池。首版需明确安全运行组合，预算/权限/范围校验与动作同批交付。

## 5. UI、收件箱与通知证据

以下 `R/` = `apps/electron/src/renderer/`。

- `R/components/projects/ProjectView.tsx:495,518–534,572–577`：五个旧顶层入口；`:1396–1410,1473–1514`：11 个项目详情 tab；`:3452–3500`：BoardOverview 统计卡片不能下钻。
- `AgentTeamPanel.tsx:92–103,303–313,414,437,563`：获取全局员工/渠道/workflow/workspace，混入事件/收件箱；执行记录“打开执行会话/处理审批”；有研发模板，非完全从零配置。
- `ProjectWorkspacesPanel.tsx:54–104` 与 `main/ipc.ts:4733–4745`：真实 bind/unbind IPC，非空占位；员工/任务 workspace 另有配置。
- `kanban/TaskDetailDialog.tsx:47–79,129–131` 挂载 TaskReviewPanel；后者 `:220–312` 有验收/退回/返工/验证/应用；任务列表未复用该 Review 入口。
- `ProjectChainPanel.tsx:113–143` 调用 getChain/updateChain；`ProjectCollaborationTasks.tsx:43–54,102` 展示事实并让用户去任务页指派。
- `MailboxPanel.tsx:38–63,108–117` 已挂载在团队中，5秒轮询；处理审批跳会话，非内联审批。
- `L/team-mailbox-service.ts:50–100` 聚合权限/AskUser/ExitPlan/Todo/互调，未聚合研发交付、DACI、Workflow、Proactive 审批。
- `main/index.ts:616` 启动通知 coordinator；`L/app-event-bus.ts:45–66` waiting_action；`notification-coordinator.ts:36–56`/`notification-policy.ts:13–37` 发通知；`R/hooks/useGlobalAgentListeners.ts:1131–1135` 点击仍按 sessionId 回会话。
- `ProjectKnowledgePanel.tsx:63–109` 实际知识库绑定；`L/knowledge-scope-service.ts:63–106` 实时 scope/绑定校验。知识不是不存在，而是当前偏授权管理。
- `R/components/agent/AgentView.tsx:2011–2100,2487` 有协作拆分函数和弹窗，但触发按钮被注释；不能算可用项目主管。

## 6. 历史验收的实际边界

R01：GLM 5.3 Flash、示例仓库、开发模式随热修从 `94411dda` 到 `63c184eb`、三轮执行；确认了范围阻塞、同会话返工、真实验证、应用与 DoD。用户仍配置/退回/扩范围/验收/应用，无多角色自治验收。

证据：`../2026-09-25-task-review-loop/evidence/R01-trial.md:17–61`。

台账审计前的问题：

- “11/11完成”与 W09 部分完成、W10 缺打包冲突。
- T01–T30 全未执行与运行历史 PASS 冲突，尚无逐项完整映射，不能直接全部改 PASS。
- R02 不能因 R01 改过 Markdown 就替代独立文档语义验收。
- R03 未执行不能在 G4 写成已覆盖；确定性测试不等于真机。
- 未报告权限弹窗不能写 0 次；费用未知保持 unknown。
- R01 初始允许范围与最终 src/docs 配置口径需补 revision；不猜测补写。
- “20+点击/4处界面”没有逐步计量附件，只能作为体感反馈，不当精确基线。

本轮将修正历史台账的当前摘要、门禁与交接，保留 PASS 日志和试跑历史；不足证据项明确待补。

## 7. 审计结果对应行动

1. 新增项目级管理者/目标输入/结构化计划/受控动作，而不是新建一套模型执行器。
2. 接通项目事件→依赖/readiness→角色派发→技术审阅返工→必要人工审批→自动恢复。
3. 首个纵向切片同步实现最小收件箱、通知、必要 UI 修复与安全限额。
4. 以固定构建真实试跑证明自主推进；全量 UI 整合和跨项目优化不阻塞首次闭环验证。
5. 工作目标和拆项见 goals-and-roadmap.md、ledger.md；不报告未经定义的完成百分比。
