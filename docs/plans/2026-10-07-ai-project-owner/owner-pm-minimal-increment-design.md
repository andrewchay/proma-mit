# AO-PM-01/02 最小增量：Owner 管理主体、事件收件箱与管理循环

生效：2026-10-18，工作树 `owner-a02-a05-context-role`。状态：**用户已授权按阶段实施并逐阶段本地提交**；本文件为实施草案，具体接口和阶段结果以代码与 Ledger 证据为准。本文不改任何运行授权；费用、审批、来源门禁全部沿用现有契约。

依据：[Owner 设计](owner-design.md) §2/§3 · [Ledger AO-PM-01～02](ledger.md) · [对话式配置实施记录](owner-conversational-setup.md)。

### 阶段落地边界（2026-10-18）

首片实际使用三张追加式身份/事件/消息表，接目标保存与绑定变更的主进程循环和只读会话IPC。用户显式提交/重提目标是无费管理责任的发起；旧项目仅凭历史绑定或启动扫描不启用。完整开放问题答复、follow-up及有界管理推理尚未落地。下文四表与owner_management用途是后续设计候选，不能作为已实现接口或要求额外用户审批的理由；事件消费状态允许更新、身份和消息追加，与“所有表完全append-only”的早期提法区分。默认对话层将在下一阶段接入，管理暂停不冒充业务停止。

### 后续实际增量（2026-10-19）

0.13.35/0.2.66 在首片三表基础上追加问题及答复回执两表，实际名称为 `project_owner_management_questions` / `project_owner_management_answers`；问题 open/answered/stale 从可信回执和当前来源派生。接入 planning_result 持久事件、同事务答复→目标修订→后台无费准备，以及 `OWNER_MANAGEMENT_CHANGED` 提交后推送、全局监听和启动开放问题恢复。下文四表/owner_management/全部事件覆盖仍为候选设计，不能据此推断已落地。费用继续逐请求确认，尚无自动管理推理或完整自由对话。阶段证据分别看 Ledger PM-D1 记录。

### 有界管理委托首片（2026-10-19）

0.13.36/0.2.67追加 `project_owner_management_delegations` 与 `project_owner_management_claims`，在对话内独立预览/确认管理调用的模型、范围、次数、费用与期限。后台复用已有 owner_planning/owner_execution_assignment 零工具出口及controlled最终准入，不增设通用owner_management工具。默认无委托仍逐请求确认；用户确认新委托后可在保守占额内自动调用，澄清答复沿精确目标谱系续跑，未知/失败停等，人工改目标或资料配置漂移需重确认。业务执行许可仍独立。下文owner_management及更多事件/管理承诺仍为候选，不作为本片已实现功能。

### 自动组织安排增量（2026-10-19）

0.13.37/0.2.68复用既有事件表接plan_confirmed与assignment_result；方案确认唤醒当前团队安排，有有效管理委托才付费请求。可信安排自动进入界面的执行边界确认，保护已有准备和未保存草稿；无业务派发副作用。当前仍受既有岗位模板/执行配置兼容约束，通用员工适配与完整业务执行链尚未完成。未新建管理工具用途或另建权威任务表。

## 1. 目标与范围

让"独立、持续负责的 Owner"成立的最小骨架，只回答两个问题：

- **AO-PM-01**：项目有一个可恢复的**管理主体**——重启/切页后能重建"目标、计划、开放问题、管理承诺、运行状态"。
- **AO-PM-02**：管理主体挂在**事件驱动的后台循环**上——目标/交付/失败/答复/授权/到期事件唤醒对账与行动，用户离开页面仍推进，恢复先对账。

明确**不在本片**：自动派发员工（AO-PM-03 的执行段）、质量验收/返工整链（AO-PM-04）、对话 UI 重构（AO-PM-05 的呈现层）。本片为这些能力铺地基，但第一刀必须走完一条真实业务链（见 §7）。

## 2. 调研结论（可复用 / 缺口）

### 2.1 可复用（全部经代码核实，附位置）

| 能力 | 位置 | 用途 |
|---|---|---|
| 目标/计划版本化持久化（双 CAS、来源/内容指纹、stale 派生） | `project-owner-goal-service.ts`、`project-owner-plan-service.ts` | 管理上下文重建的"目标、计划"两面 |
| Owner 身份锚（每项目一份、连续修订、配置指纹） | `project-owner-runtime-binding.ts` + `project_owner_runtime_revisions` | 管理主体的身份基础，无需新建 principal |
| Owner 推理 Run 全生命周期（晚到回调、停止意图、失联 unknown、费用结算、结论不可覆盖） | `project-owner-planning-run-service.ts`、`agent-employee-service.ts:1316-1338,1570-1590` | 管理循环"决策步"的运行载体 |
| 冻结来源 + admission + 单请求占位 | `project-owner-planning-source.ts`、`project-owner-planning-admissions` | 后台发起推理时同样不可跳过 |
| 按项目串行队列 + 指纹去重 | `project-pilot-intent-store.ts:38-78` | 事件消费的串行/幂等范式 |
| 答复绑定来源版本 + 同事务写事实 + 事件唤醒续跑（A04 完整先例） | `project-pilot-approval.ts:62-91` | 用户答复唤醒管理循环的通路 |
| 后台服务骨架（30s 补偿 + 事件即时唤醒 + 启动补偿 + 退出清理） | `project-pilot-background-reconcile.ts:47-91` | 管理循环生命周期范式 |
| Owner 续派调度器（inFlight 防并发、evaluate/行动分离、needs_reconcile 不自动重试） | `project-owner-autonomous-scheduler.ts` | 循环内的"授权内行动"执行者 |
| 微任务唤醒总线 | `project-owner-autonomous-scheduler-events.ts` | 事件 → 循环的解耦原语 |
| 到期调度 + 启动恢复参照 | `proactive-scheduler.ts:103-113,230-236` | follow-up 到期检查的范式 |
| 后台 → Renderer 推送（静默失败、不抢焦点） | `project-polling-service.ts:209-224` | Owner 状态变更推送的正确姿势 |
| 权威事实投影（attention 项带 sourceType/sourceId/sourceVersion） | `project-pilot-reconcile.ts:115-141` | 对账重建的读取面 |
| 启动/退出挂点 | `main/index.ts:526-552,731-734` | 循环生命周期挂接位置 |
| 安排提案引擎（冻结上下文 + 指纹 + 严格解析，本分支 WIP） | `project-owner-execution-assignment-*` | AO-PM-03 的半成品，本片只接通自动触发 |

### 2.2 缺口（对照 AO-PM-01/02 退出标准逐项）

| 退出标准要素 | 缺口 |
|---|---|
| 管理主体运行状态 | 绑定记录是配置不是主体：无 active/paused/recovering、无管理责任指针、无唤醒截止 |
| 开放问题 | **无注册表**：clarification 只存在于单次 Run 结论，无 open→answered 生命周期、无去重合并、无答复绑定 |
| 管理承诺 | **无持久面**：调度器 waiting 态每次现算不落盘，重启后"下一步该做什么"丢失 |
| 持久事件 | 无统一事件收件箱；进程内监听器易失，重启靠扫描补偿，无事件级幂等键 |
| 管理循环 | 调度器只监听 chain change + 启动 wake，不覆盖任务事件、Run 结论、答复、预算/到期 |
| 后台发起推理 | planning Run 启动绑定 Renderer 确认按钮；purpose 枚举封闭（`owner_planning`/`owner_execution_assignment`），无 `owner_management` |
| Owner → 用户推送 | 状态全拉取 + 页内轮询；无 OWNER_STATE_CHANGED 推送，离开页面进展丢失 |
| 答复续跑 | 澄清续跑靠 Renderer 显式触发，不是事件驱动 |

## 3. 设计总览

四个新表 + 三个薄服务 + 一个循环 + 一个推送通道。全部追加式、同 paa.db、沿用 revision + integrity_hash + fail-closed 范式；**不建第二套权威任务表**。

```text
既有提交点（goal/plan confirm、materialization、command settlement、
technical_review、approval resolve、grant issue/pause）
  → project-owner-event-inbox（dedupe 落事件，append-only）
  → project-owner-management-loop（主进程生命周期；按项目串行队列）
      1. 重建管理上下文（management-context-service 读时投影）
      2. 确定性分支先行（无新事实/无可用授权 → 不调用模型，只更新状态）
      3. 需要判断 → 检查费用/授权门禁
           门禁内 → 发起 owner_management 推理 Run（复用 planning 全链）
           门禁外 → 写 open_question（kind=authorization），推送用户
      4. 行动：写承诺（follow_ups）/注册开放问题/触发既有服务
          （调度器、澄清准备、安排准备——复用，不重写）
      5. 更新 management_states，标记事件 consumed，推送 OWNER_STATE_CHANGED
  → Renderer 全局订阅 → 项目对话呈现（后续片做 UI，本片先通数据）
```

## 4. Schema 增量（4 张新表）

均在 `project-sqlite-store.ts` migrate 中以 `CREATE TABLE IF NOT EXISTS` + `readColumnNames` 增量 ALTER 风格追加；immutable trigger 视证据属性决定。

### 4.1 `project_owner_management_states`（每项目一行，revision 追加）

Owner 管理主体的最小身份载体：

- `project_id PK`、`revision`、`payload`、`integrity_hash`
- payload：绑定指针（bindingRevision + 指纹）、当前目标/计划指针（subjectKey + revision + 指纹）、活动授权指针（grantId + state）、运行态 `active/paused/recovering/inactive`、最后对账指纹（事件水位）、唤醒截止时间、暂停原因。

旧项目无此行 = `inactive/待授权`，不自动给旧 carrier 绑定赋予管理职责（对齐 owner-design §2）。

### 4.2 `project_owner_open_questions`（开放问题注册表）

把现有 clarification / decision / authorization 三类待人事项统一为可恢复注册表：

- `id`、`project_id`、`subject_key`、`question_key`、`kind CHECK IN ('clarification','decision_required','authorization')`
- `state CHECK IN ('open','answered','expired','merged')`、`dedupe_key UNIQUE`
- `payload`（冻结问题 + 依据 + 推荐方案 + 备选 + 影响）、`source_refs JSON`、`opened_from`（receipt/command/execution id）
- `answered_payload_hash`、`answered_at`、`resolved_by`、`revision`、`integrity_hash`

同一问题合并去重靠 `dedupe_key`；答复必须绑定原问题与最新来源版本（复用 A04 的 `sourceVersion` 强制校验模式）。

### 4.3 `project_owner_follow_ups`（管理承诺与到期检查）

- `id`、`project_id`、`kind CHECK IN ('delivery_check','rework_deadline','grant_expiry','budget_check','dependency_watch')`
- `subject_refs JSON`、`due_at`、`state CHECK IN ('pending','done','cancelled','expired')`
- `last_checked_at`、`result_hash`、`revision`、`integrity_hash`

这是"Owner 说下一步做什么、何时检查"的唯一持久面；循环的到期唤醒扫这张表。

### 4.4 `project_owner_events`（事件收件箱，append-only）

- `id`（=`hash(projectId|type|sourceType|sourceId|sourceVersion)`）、`project_id`、`event_type`
  （`goal_raised/plan_confirmed/delivery_submitted/execution_terminal/answer_resolved/grant_changed/expiry_due`）
- `source_type`、`source_id`、`source_version`、`payload_hash`、`occurred_at`
- `consumed_at`、`consumed_cycle_revision`、`integrity_hash`

写路径挂既有提交后点（同事务或提交后微任务，实现时定）：目标/计划确认、材料化、命令结算、技术评审、approval resolve、grant 发行/暂停。到期事件由循环内定时扫描产生。**事件是证据不是指令**：消费端永远先重读权威库再行动。

## 5. 服务增量

### 5.1 `project-owner-management-context-service`

读时从 goal/plan/binding/grant/command/open_question/follow_up/management_states 重建"当前权威状态 + 开放问题 + 可行动边界"投影。模式照搬 `getOwnerExecutionPreparation` 的视图重建（`project-owner-execution-preparation.ts:186-243`）：全部派生态、不落盘、fail-closed。

### 5.2 `project-owner-event-inbox-service`

接收事件 → dedupe_key 幂等落 `project_owner_events` → 唤醒循环。复用 `pilot-intent-store` 的按项目串行 queues Map 模式。

### 5.3 `project-owner-management-loop`（核心）

- 生命周期与 `startOwnerAutonomousScheduler` 并列挂 `main/index.ts:547-549` 区域；退出挂 `before-quit`。
- 唤醒源：事件收件箱追加、`onTaskChange`、`onProjectChainChange`、follow_up 到期定时器（单 setTimeout 指向最近到期项，仿 `proactive-scheduler.arm()`，非轮询）、启动时对全部 active 项目补偿一次。
- 每项目 inFlight 串行（复用调度器范式）；**每轮循环至多一次 Owner 推理 Run**。
- 循环顺序：消费事件 → 对账重建上下文 → 确定性分支（能确定处理的状态直接处理，不调模型）→ 需要判断时检查费用/授权门禁 → 门禁内发起推理 / 门禁外注册 authorization 开放问题 → 行动 → 落 management_states → 标记 consumed → 推送。

### 5.4 推理步：purpose `owner_management`

- 复用 planning 全链：冻结资料 → admission → 单次请求占位 → Run → `recordOwnerPlanningRun` → outcome。新增 `OwnerPlanningLink.purpose='owner_management'`，`maxRequests` 按当轮需要（首版 1）。
- 结论结构化：next_actions（clarify / propose_arrangement / prepare_execution / follow_up / escalate）、理由、依据引用。服务端严格校验，模型自述不构成事实。
- **主进程后台发起入口**：补一个主进程内的 planning Run 发起函数（复用 preparation 逻辑 + headless 启动桥），绕过 Renderer 按钮但**费用/来源/准入门禁一步不省**。

### 5.5 推送通道

新增 `PROJECT_IPC_CHANNELS.OWNER_STATE_CHANGED`，循环每轮结束按项目 broadcast（仿 `project-polling-service.ts:209-224`，不用 `sendToMainWindow` 避免抢焦点）。Renderer 全局订阅写 atom；页面重载后用现有 GET_* 拉取恢复。本片只保证数据可达，UI 呈现归 AO-PM-05 片。

## 6. 费用与授权边界（不可裁剪）

- 有界委托契约（owner-design §6）**尚未实现**；本片全部 Owner 推理调用仍走现有逐请求费用预检/确认。循环遇到费用门禁未满足时，不自行推进，注册 `authorization` 开放问题并推送用户在对话中确认——这本身就是"Owner 主动协商"的第一种形态。
- 来源漂移、配置漂移、过期授权一律 fail-closed；unknown 费用保留不估价；不自动重试。
- 循环产生的每个动作仍经权威服务（goal/plan/preparation/scheduler），Owner 不直接改库。

## 7. 第一刀最小业务链（验收锚点）

非代码项目，用户给出目标并确认边界：

1. 目标保存 → 事件落收件箱 → 循环对账 → Owner 根据上下文判断是否需要澄清（不以固定规则虚构信息不足）→ 门禁内发起澄清推理 Run（费用按现有规则确认）→ 结论注册 `clarification` 开放问题 → 推送 OWNER_STATE_CHANGED。
2. 用户在同一项目对话答复 → 答复绑定来源版本写回 → `answer_resolved` 事件 → 循环自动触发无费准备与下一轮（规划/安排），**不需要用户点"继续"**。
3. 期间关闭并重启应用 → management_states + 对账恢复循环，开放问题不丢、不重派。

通过标准：三步全链在固定包走通；人工流程推动为 0（唯一人工动作是目标输入与必要确认）；重启恢复后状态与证据一致。

## 8. 验证计划

- 确定性测试：4 张新表迁移（含老库加表）、事件幂等/去重/串行、开放问题生命周期（open→answered 绑定来源版本，旧答复拒绝）、管理状态恢复（强杀/重启后先对账）、费用门禁阻断分支、purpose 隔离（management 不进普通执行路径）。
- 回归：现有 Owner/Pilot 全量隔离测试不得回退。
- Native 验证：真实 better-sqlite3/WAL 下走完 §7 三链并强杀恢复。
- 本片不宣称 AO-PM-01/02 完成，只交付其最小骨架证据；产品验收仍归 AO-PM-06 统一判定。

## 9. 风险与待决

| ID | 风险 | 对策 |
|---|---|---|
| PM-K1 | 循环被做成"定时轮询模型" | 确定性分支先行；无新事实/无可用授权不调用模型（owner-design §3 末段） |
| PM-K2 | 事件收件箱变成第二套事实源 | 事件仅作唤醒证据+审计，行动前永远重读权威库（与 pilot_intents 同范式） |
| PM-K3 | 后台发起推理绕过费用门禁 | 复用 planning 准入全链，费用确认前置到循环的 authorization 分支 |
| PM-K4 | 管理状态表与绑定/目标漂移 | management_states 只存指针+指纹，读时校验，漂移即 recovering + 拒绝行动 |
| PM-K5 | 本片又被 UI 工作淹没 | 第一刀只走 §7 链；对话气泡、卡片等呈现一律后置 |

## 10. 与既有编号的关系

- 本片落地后 AO-PM-01 状态可由"待开始"转"进行中（骨架已立，待完整验收）"；AO-PM-02 同理。
- AO-A08（答复续跑）、AO-UX-01（对话入口）已有切片继续复用；本片把唤醒对象从 Renderer 换成管理循环。
- 安排提案引擎（本分支 WIP）在本片中由循环自动触发，但用户审核与授权门禁保持不动（AO-PM-03 不因此关闭）。
