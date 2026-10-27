# AI Owner 能力核验：第一批源码入口

核验日期：2026-10-07 GMT+8；分支 `feat/ai-project-owner`，基于 `2ba5dfcd`。状态：AO-02 进行中，尚未完成全量能力映射或固定构建验收。

## 1. 结论

已有目标状态、项目任务、项目链、后台对账和受控派发，不能重新造一套平行任务系统。但现有两套 Goal 与项目 Owner 的目标/计划版本关联未接通，本轮未将它们自动合并。

首片新增 `project-owner-planning.ts` 纯输入边界，形成目标简报和计划提案规范化副本；它不是目标持久化服务、模型调用或任务派发入口。项目/任务身份存在性、最新目标版本、实际角色目录仍须由后续权威服务核验。

## 2. 来源与接入判断

| 已读来源 | 目前可确认的行为 | Owner 接入约束 / 缺口 |
|---|---|---|
| `project-types.ts` | Project 保存标题/说明/状态；Task 保存负责人、工作区、依赖关联所需身份与研发范围等 | 没有在本次检索中发现项目级版本化目标/Owner 计划契约；不能直接把 description 当作已批准计划 |
| `goal-service.ts`、shared `goal.ts` | 本地 JSON 长期 Goal，含 todos/gates/evidence/quota | 有独立 Todo 模型；需明确与权威项目任务的关系，不能双写两套任务；现有 quota 的默认语义不是 Pilot 授权 |
| `goal-runtime/goal-coordinator.ts` | 会话级 AgentGoal、检查点、有限续跑、恢复；绑定 session/Runtime | 会话级续跑不是跨任务项目编排，不能直接当项目 Owner 派发；续跑次数和模型自述检查点也不代替项目费用/验收证据 |
| `project-chain-service.ts` | SQLite 项目链追加快照、revision 校验、项目/任务/身份核验，提交后变更通知 | 可复用决策/交付证据入口；新增目标/计划模型需明确版本关系，不能让模型冒充 local-user 批准 |
| `project-pilot-background-reconcile.ts` | 任务/链路事件＋30 秒补偿扫描，活动授权下走唯一受控派发入口 | 已有后台基础；它消费 ready/review candidate，不负责目标理解或生成结构化计划 |
| `project-pilot-approval.ts` | 人工询问来源绑定执行/任务/授权，sourceVersion 防旧答复；批准写权威任务后由事件对账续跑 | 已有受限续跑链；基于说明标记，不等于通用 Owner 的澄清/变更请求；需补新计划版本关联 |
| `project-pilot-dispatch.ts` | 限定执行/评审角色，费用/次数受控；同任务有限评审/返工 | 不应绕过此出口创建另一个自由员工派发器；现有研发动作不能外推所有非代码类型 |
| `project-pilot-readiness.ts` | 明确安全研发角色、Git 工作区、渠道/模型/员工一致性、费用停止阈值门禁 | 原门禁保持；当前测试仍证明缺预算停止阈值阻塞，不能为新 Owner 清除这一阻塞 |

这张表是已读入口的能力判断，不宣称仓库全局不存在其他实现。交付服务、实际 Runtime 支持、Owner 身份、继承配置、存储事务、IPC/UI、异常收口和非代码适配器仍须逐项核验。

## 3. 本轮新增的安全契约子片

文件：`apps/electron/src/main/lib/project-owner-planning.ts`、`.test.ts`。

- 输入只有项目/可选任务身份、目标版本、目标与可选约束/标准；不要求 Git、路径、员工或预算配置。
- 模型计划必须绑定同项目、同任务粒度和目标版本，给出具体成果、非空标准、可用角色键与显式依赖。
- 校验重复节点、未知/自身/重复/循环依赖、字段/数组类型和输入上限；允许前向依赖。
- 白名单拒绝夹带 grantId、permissionMode、status、completed 等字段，输出固定为 `proposal_only`。
- 不执行 I/O、模型调用、创建任务、权限变更、费用预留或派发。模型提案通过不意味着内容质量、真实证据或授权成立。
- `roleKey` 仅为能力建议键，不是员工 ID；可用键由后续权威目录适配提供，再次派发核验不可省略。

## 4. 本批验证

- BDD：先缺模块失败，再实现通过；增加单任务绑定测试时观察到缺字段失败，再补实现。
- 新规划契约测试：16/16。
- 既有 Pilot readiness 回归：9/9。
- 既有 Pilot 后台对账回归：7/7；独立进程、临时 `PROMA_TEST_CONFIG_DIR`，测试目录清理。
- 回归前后 `~/.gravitas/agent-workspaces/` 一级目录快照一致，无新增测试工作区。
- 全 workspace typecheck、两个新增文件的 Biome、diff 格式检查：通过（最终提交前再次核对）。

上述是确定性源码证据，不是 UI、固定构建或真实 Provider 验收；未运行全量测试/全量 lint/打包/付费调用。

## 2026-10-07 第二批补充

AO-01 已产出 [离线原型 v1](prototype/index.html)，15/15 模拟状态分支测试通过，代表性路径在受管浏览器走查；原型仍待用户审查。持久化收敛提案见 [目标与计划存储设计](planning-storage-design.md)：在项目数据库保存附属版本记录，不复制两套 Goal Todo、execution 或预算权威。

该提案尚未建表或迁移，缺角色/上下文映射与服务事务完整核验，AO-02 保持进行中。原型不构成真实 Provider/UI/预算/后台能力验收。

## 2026-10-07 第三批：目标草案存储

用户 01:26 GMT+8 认可原型并要求继续。新增 `project_owner_revisions` 表与 `project-owner-goal-service.ts`：项目/单任务主体键、服务生成revision/goalVersion、同内容no-op、历史和当前读取、归属/旧版本/非法输入拒绝。目标草案修改不发送项目链或任务事件，不产生候选、任务、执行或授权。

15/15新存储测试通过；回归规划16/16、项目链5/5、后台7/7，共43项。数据库旧表加新表、重开、外层回滚、损坏记录和复合主键已验证，均为临时配置下sql.js证据；没有原生SQLite多进程并发或真实用户库验收。测试前后真实工作区目录无新增，临时目录已清理。

删除项目/任务不顺带删除Owner规划历史；服务重新检查主体，失效历史不作为可操作入口。没有修改既有删除行为或迁移两套Goal。完整计划保存、费用授权、身份/来源映射与IPC/UI仍待接，因此AO-03仅存储子片完成。

## 2026-10-07 第四批：目标草案产品入口

- 共享契约统一到 `packages/shared/src/types/project-owner.ts`；主进程服务和规划简报复用，不再维护跨进程类型副本。
- `project-owner-goal-ipc.ts` 的严格请求白名单和结构化冲突响应已注册工作模块；preload暴露 get/save，不暴露运行授权或派发工具。
- 新Jotai编辑状态按项目/任务隔离，服务器快照与本地输入分开。加载/保存晚到不会覆盖新输入；冲突必须加载最新、比较确认再保存，没有自动重试。
- 新 `ProjectOwnerGoalPanel` 位于项目概览首卡，只有目标必填；没有配置也可保存，组件明确标注未启动、不收费、模型拆解待接。单任务契约/状态已支持，任务可见入口后续再接。
- 验证共60项：IPC5（包括Jotai→处理器→真实sql.js服务的进程内保存/冲突恢复）、状态9、组件SSR3、原服务/规划/链/后台43；typecheck、定向Biome和main/preload/renderer构建通过。无全量PR门禁或真实运行授权。
- 在独立受管浏览器新标签，用真实源码组件＋生成主题CSS、内存模拟API走查填写/保存并截图。用户原型标签未导航/关闭。此烟测不验证真实Electron传输或DB；真实IPC/固定构建/重开验收仍待补。
- worktree依赖已按原bun.lock冻结安装、ignore-scripts，无新增依赖，确保引用本worktree的shared而非原项目目录旧类型。
- docs:check首次因原repository-facts摘要过期失败；运行既有生成脚本只更新 `docs/generated/repository-facts.md` 后复验通过。未修改README/AGENTS，未运行全量test/lint或打包启动。

## 2026-10-07 第五批：员工创建阻塞修复

[员工创建修复](employee-creation-repair.md)新增controlled非代码配置（真实托管/本地绑定、Pi/AI SDK、safe/auto、启动重验与无全局回退），20份岗位模板接新建表单只做预填。研发限制/Pilot准入/旧general默认存储保持，已有员工不自动迁移。工作区不再静默过滤，保存缺项和失败靠近表单显示。

100项定向测试、类型检查、定向Biome、三层构建、模板资料完整性与生成一致性验证通过。React StrictMode真实源码表单＋模拟API验证创建、托管勾选、失败输入保留及手动重试，非真实ElectronIPC。动态角色匹配、Owner授权派发、受控Workflow/子任务仍未实现；不能据此标记AO-06完成或解除原费用门禁。用户旧0.12.104尚未更新，不允许新controlled档案交旧二进制执行。

## 5. 下一批建议

1. AO-01：目标驱动原型中展示 Owner 提出的计划、必要澄清和成果标准，验证非代码项目＋代码单任务。
2. AO-02：明确 Project 与两套 Goal 的权威关系、版本化计划存储及角色/默认配置继承。优先建立显式关联，不复用宽松续跑作为授权。
3. 再接目标草案保存、受控规划费用授权、IPC/preload/UI 与模型提案输出；状态始终区分 draft/proposed、确认和执行授权。
4. 完整契约审定前不开放“确认即派发”；保持原 Pilot 门禁和独立副作用确认。


## 2026-10-08 继续开发：计划版本及调用来源断口

分支已快进合并main6c71b384，PR19普通controlled指派/queue/最终Provider保护及PR20实际提示装配/停用修复沿用，旧lint阻断已解决。本片[计划版本服务](plan-version-service.md)保存同库附属计划历史，不改旧schema1 Goal表payload；来源只有真实目标修订、项目/任务元信息和20模板能力建议摘要，角色规则版本/完整规则hash可核对，未知角色拒绝。Owner真实身份、employee/代码角色映射及配置继承仍未完成，不能把模板当实例。

`project-agent-service.ts:createLlmCaller`目前直接buildTitleRequest/fetch，仅改max_tokens，不能直接当受控Owner调用：尚未接规划费用/资料确认、最终发送前目标/来源/配置核验、明确用量/unknown费用回执与代理路由证据。Goal quota、内容confirmed、普通LLMCaller均不是授权。下一片须复用既有调用控制面并补审规划专用版本/恢复契约，不独立另造grant或绕过Pilot停止预算门禁。

单任务目标入口已接真实TaskItem，UI组件替身交互和计划服务/IPC确定性回归均通过；原生Electron/产品preload/真实数据库的证据独立记录，不把SSR或内存API当持久化验收。计划编辑UI、主动模型提案和AO-06自动组织仍未接；AO-02保持进行中。


## 2026-10-08 22:11后：协议/审阅与真实调用核验

新增[规划协议与审阅](planning-protocol-review.md)的无I/O请求/响应边界与已有计划编辑UI。生成/澄清、可信Run回执仍待接。已核验现成控制面没有项目级无工具Owner execution捷径；推荐controlled目的特化、明确Owner/carrier、同库source-link、最终单请求/无工具/无隐藏上下文约束，不使用bare LLMCaller，不新造grant。

补正早期预算能力判断：当前shared/types/agent.ts的ai-sdk supportsBudgetStopThreshold=true，Pi=false，实际费用出口却仅在真实Pilot command归属下工作。普通Owner/controlled的费用确认并非金额硬上限。文档旧结论保留历史，新判断按本次源码证据；未擅改AGENTS/README。

## 2026-10-11：同步后 AO-02 当前源码矩阵

核验基线：`feat/ai-project-owner` HEAD `b0558c30c300793927d473d99b7f29d96150b50c`，相对 `origin/main` merge-base `e2ec78f2481497986aeba27be69960c38465fbd7`。本节只更新当前源码判断；2026-10-07/08各批状态保留为历史，不倒改。

| 能力 | 当前代码/测试证据 | 结论与边界 |
|---|---|---|
| 项目/单任务 Goal 历史 | `project-owner-goal-service.ts`、`project-owner-goal-service.test.ts`；同库附属revision，项目与任务主体分开，旧目标不被改写 | 目标草案存储不是缺口；不复制权威任务、Goal Todo或执行账本 |
| Plan历史及Goal关系 | `project-owner-plan-service.ts`、`project-owner-plan-service.test.ts`、`plan-version-service.md`；Plan追加revision/version，绑定Goal revision/version、项目/任务、proposal及来源指纹，双CAS、stale派生、proposed/confirmed合法历史 | 计划版本持久化、人工内容确认与来源漂移拒绝已有证据；confirmed不是执行授权 |
| 规划输入来源 | `getProjectOwnerPlanningContext()`读取同项目Goal、项目/任务元信息和岗位建议目录；`project-owner-planning-source.ts`冻结快照、严格校验link/目的标记、发送来源和当前配置，并在漂移/停止/关联损坏时拒绝续发；对应`project-owner-planning-source.test.ts`、`project-owner-planning-admission.test.ts` | 规划来源可核对但范围有限；不包含本地文件正文、外部网页、渠道凭据或执行资料授权 |
| Owner身份与carrier | `project-owner-runtime-binding.ts`及`owner-runtime-binding.md`：项目级`project_owner`职责名绑定到明确启用的AI SDK controlled carrier，历史CAS与配置指纹；操作者固定`local-user` | 有明确的本地Owner/carrier绑定；没有远端Owner身份认证或多用户权限系统。carrier是实现载体，不等同业务Owner，也不因此获得额外权限 |
| 岗位池 | `project-owner-role-catalog.ts`、20份岗位模板、计划服务测试；计划输入校验模板key/版本与规则摘要；AO-02切片将稳定`roleKey`逐步绑定到实际`AgentEmployee` | 岗位建议仍不是员工实例或授权；新准备逐roleKey显式冻结员工，唯一精确`roleTemplateId`仅作推荐；缺失/冲突时必须选择，command/dispatch再次核验身份与配置 |
| 配置/授权继承 | `project-owner-execution-preparation.ts`冻结逐roleKey员工映射、Reviewer、共同workspace/channel/model/Runtime、员工/Skill/MCP配置摘要、项目绑定知识来源及计划版本；准备状态仍为`pending_task_links`，不发行grant | 员工/workspace候选限于当前项目显式绑定；唯一项目workspace可推荐，唯一精确`roleTemplateId`可推荐。缺失/多匹配需明确选择；channel/model/runtime仍须兼容并在快照中冻结，不视为通用自动继承。carrier及其他来源优先级/问答尚未整体收敛 |
| 项目范围候选隔离 | 新增BDD覆盖于`project-owner-execution-preparation.test.ts`：两项目独立workspace/员工/知识源及未绑定workspace，读取当前项目选项只返回当前显式关联资源，且无task/grant/command/execution/request副作用 | 当前测试命令`bun test apps/electron/src/main/lib/project-owner-execution-preparation.test.ts`：28项通过（含新增用例），101断言；只证明隔离候选列表，不证明自动推荐或默认继承 |
| 任务/步骤链接与运行时授权 | `project-owner-task-materialization.ts`、`owner-task-materialization.md`以及后续Stage A/B ledger：从已确认版本材料化暂停权威Task并绑定准确step/依赖；grant/command/请求/预算/stop/recovery另行复核 | 证明已有受控执行底座，不可把Goal/Plan/准备确认视为grant或请求许可；费用unknown仍保留占额 |
| 非代码执行与Review | `noncode-project-entry.md`记录既有人工受控非代码入口；Owner preparation支持controlled非代码模式但源码blocker仍指出非代码Pilot发行/资料适配器未接通 | 不代表Owner可自治执行任意非代码成果，也没有证明通用非代码Review/业务验收适配器完成 |

AO-02仍为进行中：本切片完成每个稳定roleKey显式绑定实际员工，并贯穿到Task负责人、重验证快照、grant、command/执行身份与确认预览；不按可编辑`role`文本推断。唯一精确roleTemplateId、项目唯一workspace可作推荐，缺失或冲突要求显式选择。项目carrier/来源优先级、channel/model/runtime默认继承、默认值冲突问答、AO-07～12后续Review/交付/恢复契约仍未整体完成。真实Provider、账单、费用、生产授权及物理确认不是本节测试结论。

## 2026-10-11：AO-02逐roleKey员工身份闭环（隔离分支，未提交）

基线`feat/owner-a02-a05-context-role` / `c56c182b`。员工新增稳定`roleTemplateId`列（旧记录为空，不从`role`文案反推）；岗位模板元数据可显式设置。新Owner执行准备要求roleAssignments精确覆盖所选步骤的全部稳定roleKey；不能缺项、重复或跨项目取员工。一个roleKey只能匹配唯一且符合executionProfile/workspace的roleTemplateId候选，缺失/多候选不自动择人；所有执行员工与Reviewer身份分离，渠道、模型、Runtime及工作区约束一致。

每步执行员工冻结到材料化Task负责人；重验证重建时以步骤projection的roleKey核对负责人；v2任务快照保存员工配置摘要；授权预览和grant历史显示roleKey→员工；命令在ack预览、command账本与AgentExecution中使用同一冻结员工，并把员工/岗位放进确认摘要。执行前及Dispatcher仍核验当前员工启用、配置/roleTemplateId、Task负责人、来源和授权版本；漂移即stale/拒绝，不降级至legacy默认。Reviewer继续使用单独冻结Reviewer员工。

定向BDD共137项通过（准备29、材料化20、重验证11、grant发行17、execution gates 12、Stage B 24、员工迁移2、Owner准备Jotai 18、员工模板表单4）；测试均使用临时配置。覆盖缺失/重复roleKey、唯一/缺失/冲突模板候选、角色映射材料化、grant/command预览与账本身份一致、配置漂移拒绝。Stage B仅含loopback/Fake Provider与fixture usage，无真实Provider、无真实费用。全workspace`bun run typecheck`通过；Biome全仓2147文件检查通过；`bun run docs:check`和`git diff --check`通过。完整全量test/build尚未在本切片重跑；AO-02～AO-05整体未关闭。

## 2026-10-11 Owner fetch前失败对账（实现中，真实账本待人工确认）

新增主进程类型化预发送拒绝证据、指纹预览/确认IPC、Preload与命令面板核对UI。只允许价格协议拒绝且无逐请求reservation、无未解决停止升级的严格候选；确认会在隔离事务中释放该命令占额、将旧grant暂停，并追加标明本地操作人声明的独立审计。Provider usage字段保持null；页面文案要求用户本人核对Provider控制台无请求/用量。该功能不自动重试请求、不复活grant；真实费用/Provider账单未验证。

定向Stage B 28/28、IPC 3/3、UI 2/2与workspace typecheck通过；完整测试、lint、docs:check及build尚待本切片最终门禁。真实command `302e37b9-635c-4afb-9503-001bbf3d2dc3`仍为`needs_reconcile`、500000微美元reserved、actual cost null，本轮未在产品UI完成用户核对与确认。AO-G0～G3和真实零费用证明仍未通过。

最终门禁补记（2026-10-11）：全量640个隔离测试文件失败0、workspace typecheck通过、Biome 2150文件通过、docs:check、diff check和build通过。docs摘要通过项目既有生成器更新后检查通过；renderer chunk-size warning非构建失败。当前人工对账仅在隔离数据库测试，真实命令未确认、未清账、未重试，出网关闭；AO-G0～G3及生产真实费用验收仍未通过。

### 2026-10-11 人工对账unknown标记兼容修复

实测拒绝原因为Owner command含Runtime终态unknown标记，不是逐请求reservation：0条request reservation、0条open stop escalation；真实command与grant保持needs_reconcile且占额未变。对账服务现只允许与execution/session/channel/model及固定Runtime unknown reason一致的标记，并将旧标记/record key哈希纳入指纹和不可变人工审计；畸形/漂移仍拒绝。预览要求用户确认Provider控制台无请求/用量，不伪造Provider receipt。Stage B 30、IPC 3、UI 2定向测试及typecheck/lint/docs/diff/main/preload构建通过。目标run尚待用户在更新后的隔离界面完成最终确认。

### 2026-10-12 00:02 GMT+8：发送前失败人工对账已由用户确认

隔离run `b8cb14a3-4376-483f-89f9-c6062848ecec`的command现为`released`，旧grant为`paused`；授权有效run/cost占额聚合为0，历史reserved列仍保留500000微美元，actual cost=0来自用户声明流程。不可变本地审计保留旧Runtime unknown标记/record key哈希，标识`legacy_operator_attested`和控制台核对声明。用户报告智谱无请求/用量；未由Agent独立验证Provider账单。无重试/新Provider请求。该确认完成此单条隔离run对账，不代表AO-G0～G3、真实Provider账单/零费用、真实stop/恢复或完整Owner产品闭环通过。

## 2026-10-12 N1产品流增量：前端引导与澄清草案

`project-owner-planning-flow.ts`以显式Goal/Runtime binding/Plan/Run状态纯函数推导唯一下一步提示；unknown、失败、停止及来源冲突均引导核查，不提示盲目重试。`ProjectOwnerRuntimePanel`接入状态卡和当前Run的澄清答复控件；答案按当前Goal subject写入Jotai编辑草案，成为带问题标签、可删除/修改的Goal约束行。缺目标/版本冲突/答案不完整/长度或数量超限均拒绝。该路径不调用save/prepare/start API，未保存答案按渲染态隔离；保存Goal新版本后旧准备失效，fake回归证实须新建准备并再次显式确认费用才有唯一第二次fake请求。

验证边界：6个定向测试文件36项/197断言通过，含项目与单任务Goal隔离、SSR澄清展示、Goal编辑器dirty且保存API调用数为0，以及`example.invalid` fake transport完整链。全量`bun run test` 643个隔离测试文件失败0；全workspace typecheck通过；Biome 2155文件无错误；`docs:check`、`git diff --check`和完整`bun run build`通过。首次`docs:check`因repository-facts过期失败，运行既有`bun run docs:generate`后复验通过；renderer大chunk warning存在但构建退出成功。Fake transport、旧的目标/费用隔离账本及测试usage均不是真实Provider、账单或零费用证明。N1用户侧增量不代表AO-03/04整体完成，AO-07～12、代表性目标用户走查、固定产品导航与AO-G0～G3仍待验收。

## AO-02 来源字段契约（截至 2026-10-12，代码来源仅限显式绑定）

| 字段/来源 | 允许的来源与用途 | 冲突/缺失/变化行为 | 用户可见解释 |
|---|---|---|---|
| 项目目标 | 精确 project subject 的当前 Goal revision；只用于该项目规划 | 无目标不可规划；不会静默转用 task Goal | 项目目标卡与 Owner 规划标明项目主体和版本 |
| 单任务目标 | 同一 project 下精确 task subject 的当前 Goal revision；单任务规划只冻结该任务 Goal，不继承项目 Goal 正文 | 任务不存在/跨项目/Goal 缺失即拒绝；旧版本不沿用 | 任务目标卡、规划绑定展示任务主体与版本 |
| 项目/任务说明 | 当前项目的显式元信息，加当前 task 元信息（若为单任务）；不是 Goal/验收批准 | 修改后来源指纹变化，旧预览不可继续 | 计划来源/版本可核对；说明文本不冒充授权 |
| Owner carrier | 当前 project Owner runtime binding 中明确绑定的 enabled controlled AI SDK employee；只作规划调用载体 | 未绑定、配置漂移或关联不一致即阻断；不自动变为执行岗位 | UI 说明“规划载体”；准备候选显示 `isOwnerCarrier`，不参与 roleTemplate 唯一推荐 |
| 执行工作区 | 当前项目显式绑定工作区候选；仅当唯一时可预填推荐，不从主目录/全局/最近值回退 | 缺失或多候选要求人工选择；跨项目候选不展示；source fingerprint 漂移阻断旧准备 | 执行准备卡显示项目显式绑定来源和“需要你选择”状态 |
| 岗位/执行员工 | 稳定 `roleKey` → 精确 `roleTemplateId` 员工目录映射；唯一符合条件的匹配可推荐 | 缺失、重复、角色冲突或执行配置漂移均 fail-closed；不按可编辑 role 文本推断 | 准备卡列出 roleKey/员工映射；需用户处理冲突 |
| channel/model/runtime | 用户显式选择员工的当前配置；准备快照校验与冻结 | 不从 Owner carrier、全局默认、最近使用值静默继承；不兼容/变化则阻断或要求重新准备 | UI 来源说明已明确“不静默回退”；配置不一致阻止预览 |
| 知识/资料源 | 当前 project preparation 中明确选择/冻结的项目来源；规划输入不自动读取项目文件正文或全局资料 | 缺授权/来源变更/跨项目即拒绝，旧预览失效 | 准备/Run说明来源范围；不声称已读取仓库文件 |
| 冲突与新旧版本 | 服务端按 project/task ID、revision、fingerprint 重验；客户端只呈现诊断 | 目标、绑定、员工配置、岗位来源变化时 fail-closed；不自动择优或重试 | 计划/准备显示过期或需人工选择；澄清答案仅进当前 subject 未保存草案 |

**继承边界结论：** 当前只允许“当前项目唯一显式绑定工作区”和“唯一稳定 roleTemplateId 匹配”作为 UI 预填推荐；最终来源仍需当前主体/员工配置校验。规划 carrier 不会自动推荐为执行/评审人员；当前契约允许用户显式选择 carrier，服务端仍按员工配置及角色兼容性完整核验，并非强制身份隔离。channel/model/runtime 尚无安全的通用默认继承契约，因此必须显式选择，不以缺省为由回退。不同来源的同级候选不做静默合并。

## 2026-10-12：AO-02 carrier 与执行配置来源边界收敛（实现切片）

- `OwnerExecutionPreparationView.choices.employees` 现在标记当前 Owner carrier（只暴露非敏感 `isOwnerCarrier`）；它仍可由用户显式选择，但不再参与唯一 `roleTemplateId` 自动推荐。项目绑定的唯一 workspace 仍可推荐，候选仅从当前项目明确绑定工作区与当前员工目录中筛出。
- 准备 UI 明示来源顺序与语义：workspace 推荐来自当前项目显式绑定；岗位推荐来自唯一稳定 `roleTemplateId`；channel/model/runtime 是选定员工当前配置，不从规划 carrier、全局默认或最近使用值静默继承。用户显式选择 carrier 仍必须通过服务端完整的当前配置及岗位兼容性检查。
- `buildOwnerExecutionSource()` 在预览、保存和读取当前准备时重读当前 carrier 绑定及员工/渠道/工作区事实。新绑定附带排除任务计数、耗时、失败计数与更新时间的配置指纹，避免纯运行统计变化误报漂移；旧绑定保留历史指纹算法并继续严格核验。任何实际配置不匹配时 fail-closed，不伪装为无绑定，不发起模型请求。
- 回归：`project-owner-execution-preparation.test.ts`覆盖 carrier 标记、显式选择仍按员工配置校验、carrier配置漂移阻断；`project-owner-execution-atoms.test.ts`覆盖 carrier 即便是唯一roleTemplate候选也不自动继承。原有项目候选隔离测试覆盖多项目workspace/员工/知识源边界；项目级/同项目单任务准备样例仍分主体，旧预览在来源变化时拒绝。
- 独立只读对抗审查未发现来源回退、跨项目越界或静默冲突绕过；其发现的新carrier指纹包含运行统计会造成误报，已改为新增可选配置指纹，并保留旧记录的strict兼容核验。审查提出的旧准备v1来源结构兼容疑虑经`git show HEAD`核实该来源字段在本切片前已存在，非本次引入。AO-02～04追加复审发现一处UI诊断矛盾：唯一匹配候选若是carrier，空选项说“没有匹配”但下拉又标“精确匹配”；现已改为说明匹配项是Owner carrier、不会自动推荐但可显式选择并接受服务端复核，并在Reviewer候选标注。独立审查确认显式选择carrier符合当前批准契约，不是硬身份隔离。用户手测指南现已交付到会话工作台，产品走查仍待用户执行。最终修复后门禁结果以2026-10-12 AO-02～04收尾条目为准。Electron/shared patch分别递增至0.13.6/0.2.53，事实摘要同步。
- 证据边界：以上是源码/隔离测试和组件渲染证据，不是固定安装包或真实 Provider 证据；无真实 Provider 请求、无新授权/派发/费用预留。AO-02整体及 AO-03/04 产品级验收仍进行中；AO-G0～G3、真实账单和旧 unknown reservation 状态不变。

## 2026-10-12 AO-03/04 代表样例离线闭环与边界

`owner-planning-controlled-flow.test.ts` 新增两个明确主体的 fake-only 代表样例。非代码项目“新产品市场定位”覆盖目标/限制保存、关键受众澄清、回答经人工写入新 Goal revision、旧准备失效、重新准备前不产生第二请求、未确认费用时请求数不增加、确认后形成含依赖/成果/验收/风险的 `proposed` 计划。单任务代码样例“修复负数量报价，保留正常行为”覆盖 task Goal 与项目 Goal 的隔离、精确 taskId/Goal revision 绑定、项目说明保留但项目级 Goal 正文不泄入 task Goal，以及仅提议定位/回归范围；目标任务原记录保持不变，不创建业务计划任务。

重要边界：该规划适配器上下文不含仓库文件正文；代码样例的模型响应仅为固定假响应，明确记载“目标文件与当前实现尚待源码核验”。它验证任务级来源隔离和结构化计划协议，不验证模型真实定位代码、代码修改、测试执行或用户验收。Fake transport 固定为 `https://example.invalid`，不发真实网络请求，不证明真实 Provider 费用/账单。当前 Native/固定安装包和真实 UI 用户走查仍待用户完成，见会话工作台 `ao02-04-product-test-guide.md`。

以上补充把 AO-03/04 的可离线工程断点逐项收敛；不把它们改记整体产品完成。AO-02剩余：默认继承边界以外的多源冲突交互、完整代表项目/单任务产品走查；AO-04代码仓库自动定位仍为能力阻塞。AO-G0～G3、AO-05执行授权/真实Provider/账单证明及AO-07～12状态不变。

## 2026-10-16：AO-A02 绑定工作区源码定位实现切片

修复“代码单任务只能得到通用计划、规划请求无仓库内容”的工程断点：

- 任务目标新增持久化 `codeSourceAccess` 选择，默认 `none`。用户必须在单任务目标表单勾选并保存后，才允许检索 Owner 当前绑定工作区；项目级目标拒绝开启。表单明确说明命中源码片段会随规划请求发送，实际模型调用仍需既有逐次费用确认。
- `project-owner-code-locator.ts` 只读扫描绑定工作区的源码类型；不跟随符号链接，拒绝符号链接根目录，跳过隐藏/依赖/构建目录、锁文件和凭据格式文件；单文件256KiB、总读取8MiB、最多扫描4000文件/16层、最多返回12个文件和28KiB上下文。引用包含相对路径、命中行号及完整文件SHA-256；敏感赋值行在片段中屏蔽。检索器只做词项/路径候选定位，不宣称语义理解或全仓覆盖，截断状态进入冻结来源。
- 规划来源快照和指纹包含工作区身份、根目录设备/节点指纹、命中文件摘要与代码片段。每次来源重验重新检索；目标授权关闭、绑定变化或源码变化会使旧准备失效。候选文件仅经受控规划请求发送。
- Prompt 将代码标记为不可信数据。AI生成的代码计划必须引用本次检索返回的 `path`、`line`、`sha256`；无匹配源码时不能生成代码计划，只能提出澄清。伪造、越界或不属于当前快照的引用被拒绝；计划审阅页展示候选源码及逐步引用。
- 定向BDD：代码定位6项/16断言；规划契约18/62；规划协议9/45；Owner运行绑定16/53；计划服务17/106；规划来源6/17；目标UI4/17；受控规划流15/142；Provider出口3/25。全量测试、全仓格式检查、文档和构建门禁以本切片结束记录为准。

证据边界：源码定位当前只证明本地受限词项检索、固定假响应协议和来源漂移阻断；源码片段对带引号的敏感键、分行配置、Bearer及含凭据URL做有限模式遮盖，不是通用secret scanner；尚未由固定Electron构建的用户真实项目走查、真实模型质量、文件级真实任务修改/测试或真实Provider账单验收。AO-A02 UI走查按用户决定暂留待验收，不标AO-A02整体通过。

2026-10-16补充回归：检索器6项/16断言通过，新增凭据遮盖场景。首次全量测试中的超时经单文件复现，随后定位并修复底层Node经Volta shim启动后仅shim被杀的问题。进程树修复后的最终全量644文件测试失败0；全workspace typecheck、完整build、全仓Biome、文档/差异检查通过，详情见Ledger同日AO-A11记录。

AO-A11工程子片：研发验证命令在Unix独立进程组运行，Windows超时调用系统`taskkill.exe /T /F`；这样超时时可终止shim及其后代并收束输出管道。测试启动孙进程并断言服务返回后进程已退出。此证据不覆盖Owner执行命令的停止账本、Provider unknown费用处理、崩溃恢复或全平台真实运行。

## 2026-10-16 AO-A04 Owner绑定覆盖冲突补充

执行准备视图现返回Owner绑定工作区与规划载体配置建议。Owner binding有效时工作区优先按该绑定建议；无Owner绑定时仅唯一项目工作区可建议；多个候选仍须人工选择。有效绑定下，手动选择其他项目工作区或channel/model/runtime与Owner默认不同，主进程均要求独立确认后才能预览；确认随规范化输入、预览指纹和追加准备记录保存。前端在工作区、人员、Reviewer、模式、步骤编辑以及来源重读变化时清除旧确认。Owner binding或carrier失效时撤销默认建议并由服务端拒绝准备。

此规则解决Owner绑定与当前人工选择的直接冲突，不定义员工、项目、载体、渠道或工具的普遍自动继承，不自动更改员工配置，也不授予模型调用或执行权限。

2026-10-17补入步骤级MCP/Skill词面候选：准备视图只向渲染端提供当前项目显式绑定工作区的已启用能力名称、类型与Skill说明，不返回MCP配置、凭据或Skill正文。候选按步骤标题、成果、验收标准与能力描述的共享词项计算，展示命中词作理由；工作区未匹配或无明显重合时返回空候选。候选及理由现在进入准备source、预览指纹和保存记录；读回时基于当前工作区能力重建source，Skill/MCP配置变化使旧准备stale。此为可解释的词面筛选，不代表语义适配、真实工具可调用或结果有效；不启用能力、不授予访问权、不代替现有逐请求审批。定向BDD覆盖跨工作区隔离、命中理由、无匹配、候选重读与Skill漂移；候选语义质量和用户验收仍未完成，AO-A04不整体关闭。

2026-10-17补入执行人员配置冲突的可见提示：所选roleKey员工与Reviewer的channel/model/runtime不一致时，面板逐人展示当前值，并要求人工改选配置一致的员工；没有兼容组合仍由服务端拒绝预览。此提示不替人选配置、不自动继承carrier/全局/最近值。项目workspace候选冲突、岗位匹配冲突和Owner binding覆盖冲突已有独立手动选择/确认边界；更一般的跨来源默认优先级仍未定义，暂不合并来源。

### 2026-10-17 来源冲突澄清引用协议

规划输出区分信息缺失与来源冲突。来源冲突问题必须带至少两个不同来源ID和冻结快照中的精确原文；解析器拒绝少于两个来源、重复来源、未知来源、错引，以及信息缺失问题夹带冲突引用。引用可以来自当前Goal、项目/任务元信息和受限源码检索结果。Run outcome保留分类及来源，Renderer显示原文并明确不替用户裁定优先级。定向协议、Run持久视图、controlled flow和Renderer测试通过；全workspace typecheck、完整652个隔离测试文件、build、相关Biome和文档门禁通过。此补充建立“模型所称冲突可追溯且由用户决定”的交互契约，不证明模型发现冲突的召回/准确率，也不引入一般来源优先级或自动合并；真实模型与用户验收仍待完成。

## 2026-10-17 当前工作树验证状态

当前AO-A02/A04切片复核：全量隔离测试644个文件失败0；全workspace typecheck、25个变更源码/测试文件Biome、`docs:check`、`git diff --check`和完整build通过。Build有既有CJS `import.meta`、过期Browserslist和renderer chunk-size警告，退出码为0。没有真实Provider请求或固定构建UI走查。用户明确选择将AO-A02固定构建UI验收暂留待验收；该选择不关闭AO-A02，也不构成真实项目、模型质量、账单、代码修改或验证证据。详见[Ledger](ledger.md)。

### 2026-10-17 AO-A04 无效员工过滤

准备候选读取现在对当前项目绑定工作区内的controlled/development员工复用对应Runtime目标校验：员工必须具备启用渠道、启用模型、可用工作区；研发员工还须绑定本地Git根目录。校验失败的员工不进入可推荐候选，防止失效配置仍成为唯一roleTemplate匹配并延迟到预览时报错。UI无有效员工时明确提示检查渠道、模型和工作区。服务BDD覆盖渠道停用与模型停用；Renderer BDD覆盖零有效员工提示。仍没有语义推荐质量或多来源自动继承契约；不据此宣称AO-A04关闭。

本轮验证：准备服务37项/135断言、Renderer准备面板10项/74断言通过；全workspace typecheck、Biome全仓2174文件、完整652隔离测试文件、完整Electron build、`docs:check`与`git diff --check`通过。真实Provider与产品用户验收未执行。
## 2026-10-12 AO-07 后台技术评审与有限返工（隔离实现切片）

AO-07原独立分支`feat/owner-a07-background-review`（基线`7b6d76b9`）的严格JSON Reviewer契约和不可覆盖SQLite评审证据，现已整合到本地`codex/owner-a07-integrated`及`feat/owner-a02-a05-context-role`分支。回执从可信Reviewer完成回调落库，依赖同项目、当前冻结来源、Executor/Reviewer对应command与execution及已知结算。Scheduler按轮次串行处理Executor→Reviewer，仅有效`changes_requested`允许创建下一返工轮；每轮重新服从grant的返工次数、执行次数、费用与期限，并重验Task/依赖/员工/来源。额度耗尽、unknown、无效输出、停止升级或来源异常停等，不释放未结占额、不自动重试。`approved`仅为技术建议；不修改Task业务状态、不写业务验收、不应用成果。

Owner命令面板新增轮次、评审意见与停等信息，明确技术评审不等于业务验收。Fake-only Stage B 34项、回执解析4项、UI状态1项通过；补充maxRuns耗尽测试时发现并修正停等原因被旧状态字段覆盖的问题，未创建额外返工command。

隔离Native run `436fdd95-9cd4-4aa6-ad37-355ea38c25e9`使用Electron39.8.10/ABI140、Production preload/IPC、React命令面板和Native SQLite WAL，验证`executor(0) → reviewer(0): changes_requested → executor(1) → reviewer(1): approved`。共4次本地fake Runner/transport，fixture结算16微美元；网络/SDK/model/业务Runner/子进程tripwire为0，临时配置清理、生产workspace数未变，Task仍为`paused`，最终状态为等待人工业务验收。Fake dialog adapter不是物理原生确认；此Native smoke不是完整产品导航或用户验收。

AO-07原分支门禁：全量645个隔离测试文件失败0；全workspace typecheck、Biome 2158文件、`docs:check`、`git diff --check`与完整`bun run build`通过（renderer大chunk warning仍在）。整合后门禁见Ledger 2026-10-17记录：646个隔离测试文件失败0、typecheck、Biome 2160文件、docs/build通过；Electron包`0.13.7`、shared `0.2.54`。独立只读审查覆盖主要调度、回执、命令、回调、SQLite、UI和测试，未发现当前代码可直接证明的高风险越权派发、越界返工、unknown误判为成功或技术评审替代业务验收。残余风险：回执格式自洽不证明Reviewer判断与证据真实；本轮没有真实Provider质量、打包产品行为或真实停止证明。AO-07仅记录工程实现切片；AO-05/06产品验收及AO-G0～G3不因此通过。
