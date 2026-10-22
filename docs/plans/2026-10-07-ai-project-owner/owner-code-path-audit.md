# AI Project Owner 阶段 0：源码链路与断点诊断

日期：2026-10-19。核验分支：`feat/agent-input-ux`，HEAD `2a209dc3`。工作区在核验时包含其他与 Owner 无关的未提交 Dev/Stable 改动；下列 Owner 文件未显示为工作区修改。此记录是当前源码/契约核验，不代表固定应用或真实 Provider 端到端验收。

## 结论

**主断点在目标到编排之间。** 项目目标可以本地保存，执行侧也已有 AI 员工、受控任务、Pilot 授权、后台派发和项目活动记录；但 Owner 目标/计划没有接入模型规划、团队选择或权威任务创建。实际用户还要从项目进展页面进入单独的目标表单，并手工建立/指派任务及处理内部授权流程。故“已存在执行员工”不等于“Owner 会从目标自动组织员工”。

### 按链路标记现状

| 链路段 | 分类 | 源码证据 | 实际边界 |
|---|---|---|---|
| 项目目标保存 | 已存在且可用 | [`project-owner-goal-service.ts`](../../../apps/electron/src/main/lib/project-owner-goal-service.ts#L60) 的读取与追加版本；[`project-owner-goal-ipc.ts`](../../../apps/electron/src/main/lib/project-owner-goal-ipc.ts#L32) 只提供读写 IPC | 本地 SQLite 草案；保存不产生模型调用、任务、项目链或授权事件 |
| 目标输入界面 | 已存在但与目标体验不符 | [`ProjectOwnerGoalPanel.tsx`](../../../apps/electron/src/renderer/components/projects/ProjectOwnerGoalPanel.tsx#L8) 明确“模型规划/授权/派发未接入”；[`ProjectPilotOverview.tsx`](../../../apps/electron/src/renderer/components/projects/ProjectPilotOverview.tsx#L80) 将其作为项目进展面板内的一个表单 | 不是项目 Owner 对话；目标仅保存为草案，退出窗口前要求用户自行保存 |
| Owner 规划 | 已存在但未接通 | [`project-owner-planning.ts`](../../../apps/electron/src/main/lib/project-owner-planning.ts#L1) 是无持久化/Runtime 依赖的提案校验器；生产非测试引用只在 [`project-owner-goal-service.ts`](../../../apps/electron/src/main/lib/project-owner-goal-service.ts#L3) 用于目标简报校验 | 全仓非测试源码没有调用 `parseProjectOwnerPlanProposal` 的规划入口；没有由目标触发的 Provider 请求、员工匹配或计划保存/确认链 |
| 团队员工与执行 Runtime | 已存在且可复用 | [`agent-employee-service.ts`](../../../apps/electron/src/main/lib/agent-employee-service.ts#L504) 从既有任务 `assignee.userId` 派发；[`controlled-project-task-service.ts`](../../../apps/electron/src/main/lib/controlled-project-task-service.ts#L221) 创建受控员工任务 | 派发以任务和负责人已存在为前提；controlled 任务还须显式预览并确认费用后启动。它们不是 Owner 的自然语言规划/选择接口 |
| Pilot 后台派发 | 已存在但起点更靠后 | [`project-pilot-background-reconcile.ts`](../../../apps/electron/src/main/lib/project-pilot-background-reconcile.ts#L18) 扫描权威项目事实；[`project-pilot-dispatch.ts`](../../../apps/electron/src/main/lib/project-pilot-dispatch.ts#L58) 要求任务负责人匹配授权员工且工作区匹配；[`index.ts`](../../../apps/electron/src/main/index.ts#L541) 启动后台对账 | 活动授权通过时可自动派发 ready/review 候选并推进评审/返工；候选来自已存在任务，员工来自固定 Pilot grant，不是 Owner 对团队目录的自主选择 |
| 执行结果与项目活动 | 已存在但没有 Owner 决策回路 | [`agent-employee-service.ts`](../../../apps/electron/src/main/lib/agent-employee-service.ts#L462) 记录执行活动；[`ProjectPilotOverview.tsx`](../../../apps/electron/src/renderer/components/projects/ProjectPilotOverview.tsx#L43) 监听活动并刷新概览 | 活动推送触发数据刷新；没有证据显示事件交给项目 Owner 模型判断下一步或生成面向用户的对话消息 |
| 项目对话入口与主动沟通 | 缺失（当前 Owner 目标链） | [`ProjectView.tsx`](../../../apps/electron/src/renderer/components/projects/ProjectView.tsx#L1485) 仅在 `detailTab === 'pilot'` 渲染 `ProjectPilotOverview`；其目标子组件仍是上述表单 | 当前源码没有把该 Owner 草案/规划绑定到一个项目会话，也没有证明用户离开概览后仍能收到 Owner 主动提醒 |

## 已有执行能力如何自动化

当前有两种可复用的执行基础，但都不是完整 Owner：

1. 普通员工派发以 `Task.assignee` 为入口，任务必须已存在且处于可执行状态。活动 Pilot 项目会拒绝普通派发入口；`controlled` 员工也不能走普通派发，避免绕过准备与费用授权。
2. Project Pilot 后台监听任务/项目链变化并周期对账。仅当项目有活动 Pilot grant、授权绑定/readiness 通过、任务候选有效且任务负责人/工作区匹配 grant 时才派发；grant 内可覆盖依赖推进、执行、评审和有限返工。
3. 因此目前“无需用户逐项点开始”只在既有任务、既有员工绑定和有效 Pilot 授权条件下成立。源码没有 Owner 将自然语言目标变成计划、调用员工目录选人并创建这些权威任务的生产链。

## 首个纵向切片建议

先实现**项目 Owner 对话中的目标理解与受控计划**，不要再扩展孤立配置表单：

1. 将项目的目标、约束和必要资料与单一项目 Owner 对话绑定，用户在此直接表达目标/修订。
2. Owner 获取真实的可用员工/能力、项目授权和可访问上下文，模型输出与当前目标版本绑定的简明计划；角色建议需解析为真实员工身份，不能虚构员工或把建议当作派发。
3. 用户审阅/修改计划；执行范围、资料访问和费用授权分别按实际门禁确认。确认后经权威项目/Pilot 服务创建或关联任务，再由现有后台 Runtime 执行。
4. 执行活动和终态进入该项目 Owner 的持久上下文；Owner 根据真实状态提出后续动作或在需要人决定时发送有原因、影响和建议的消息。

第一条可运行代表路径建议选当前已支持、授权和员工绑定明确的一种任务类型。非代码项目仍须纳入产品设计和后续端到端验收，不能由此推导其执行能力已存在。真实 Provider 调用继续按独立的次数/费用授权执行；本次诊断未发送请求。

## 本轮未证明

- 没有通过当前固定应用走查 Owner 完整闭环。
- 没有验证可用员工目录针对自然语言目标的匹配质量，也没有让 Owner 选择员工。
- 没有新增、绑定或派发项目任务，没有启动 Runtime/Provider。
- 没有重新运行测试；历史测试只证明各自覆盖的独立服务，不证明目标到员工的集成链。
