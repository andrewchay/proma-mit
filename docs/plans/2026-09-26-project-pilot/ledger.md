# Project Pilot 工作、测试与验收台账

建立：2026-09-26 GMT+8。最后更新：2026-09-27 GMT+8，核对 HEAD：`7109ccd1`。建账时基线 HEAD：`017f9088`；观察与意图首片提交：`da1a3c64`。后续提交状态以 Git 历史为准。
关联：[目标与路线](goals-and-roadmap.md) · [G0 命令契约草案](g0-command-contract.md) · [G1 隔离 Git 夹具](g1-isolated-fixture.md) · [实现度审计](implementation-audit.md) · [历史方案](design.md)。

## 当前结论

- 已完成原始需求对齐、静态实现度审计与路线修订。
- **截至 2026-09-27：** 只读项目观察、历史候选意图、默认暂停策略、两步确认活动 grant、暂停影响面、预算/命令账本、任务/项目链事件唤醒、受控候选派发、原子排队与启动认领、调用级预算能力门禁、Runtime 终态原始回执、unknown 终结结算、queued 取消释放及重启中断恢复均已进入产品代码。携带任务身份的统一项目服务事件和已提交的项目链修订会立即唤醒权威对账，扫描期间的多次事件合并为一次补跑；项目链事件回读精确 revision/payload 后才通知，外层事务回滚不产生假唤醒。30 秒周期继续补偿删除等缺项目身份的事件。后台仅对当前 `ready_candidate` 复核活动 grant、readiness、策略指纹、角色、工作区和预算，再以确定性命令/执行 ID 原子排队；活动 Pilot 项目的普通派发和普通 queued 启动 fail-closed。headless 完成回调会把 Runtime 原始 result 与执行身份、Runtime、哈希、token、费用绑定后写入不可更新的 SQLite 记录；带 `total_cost_usd` 时按 `runtime_reported` 结算，无费用时保留原文但仍写 `unknown_recorded` 并撤权。Project Pilot 聚合测试 16 个文件通过，其中后台对账 7、受控派发 3、预算账本 25、恢复对账 11、暂停恢复 12、活动 grant 暂停 10、Runtime 预算 3 PASS。
- 当前仍没有可通过全部 readiness 的首版安全 Runtime、Provider 直接回执 ID/版本化价格快照、真实 Runtime/Provider 启动证据、真实停止证明、技术评审返工、最小收件箱和审批续跑。受控派发测试只注入 readiness 与启动替身；Runtime 转述结果不等于 Provider 原始回执。未创建真实业务 Pilot 任务，未调用付费模型或 Provider，未修改运行权限或发布。隔离 Git 夹具只有三项无模型确定性局部测试，因此 G0/G1/G2/G3 均未通过。
- 第一交付从“全面 IA 重构”改为“受控主动推进纵向切片＋最小审批入口”。

## 1. 状态口径

实现、自动测试、真机验收分列。源码存在≠接通，接通≠测试通过，run success≠业务验收。状态使用：待开始/设计中/进行中/待审查/已实现/阻塞；验收使用未执行/部分通过/通过/失败。

下列负责人是建议职责，**没有派发真实员工任务**。

## 2. 实施拆项

| ID | 阶段 | 工作目标/交付标准 | 依赖 | 建议职责 | 实现状态 | 自动测试 | 真实验收 |
|---|---|---|---|---|---|---|---|
| PM00 | 校准 | 原始诉求、源码证据、历史边界和新路线落文档 | 无 | 父会话＋三路只读审计 | 已完成（文档） | 不适用 | 不代表产品验收 |
| PM01 | P0 | 确定首个fixture、角色、Runtime、授权、预算、返工/并发限制、暂停规则 | PM00 | 产品＋安全 | 部分：隔离 Git fixture、双角色/共同 Git 工作区/渠道/模型预检、预算/次数/返工及暂停规则已冻结；项目经理可配置 paused 草案并两步确认活动 grant，策略锁与命令入口核对发行指纹。预留额度由账本派生并接入调用级费用超额停止阈值；Runtime 无该能力时 fail-closed。SDK 阈值不保证绝对不超预留，超额仍撤权对账。当前安全研发白名单的 proma/ai-sdk 均不支持，Claude 尚未纳入白名单，故真实 Pilot 仍阻塞。Runtime 终态原文已不可变保存并接入结算，但证据仍由 Runtime 转述；尚无 Provider 直接回执 ID、版本化价格快照、角色能力证明或真实派发 | 草案 8＋预检 9＋发行 4＋控制面 3＋候选筛选 1＋预算账本 25＋Runtime 预算 3 PASS；完整门禁未执行 | 未执行 |
| PM02 | P0 | 项目管理者入口：目标输入、必要澄清、解释/调整/暂停，命令与对话分离 | PM01 | 产品/前端/主进程 | 部分：项目概览已有策略草案表单、预检阻塞原因、授权影响面两步确认、暂停影响面和运行中逐项选择；命令与只读观察分区显示。尚无目标输入/必要澄清对话、计划解释调整或真实运行反馈 | 控制面 3＋候选筛选 1＋发行 4＋暂停 10 PASS；真机 UI 未验收 | 未执行 |
| PM03 | P0 | 统一项目运行上下文；后台无页面运行；project/workspace/scope校验，无静默错路由 | PM01 | Runtime | 待开始；本轮只读项目范围观察不等于运行上下文 | 未执行 | 未执行 |
| PM04 | P0 | 持久可恢复的项目对账入口；任务/交付/审批事件合并、版本与幂等、拒绝晚到旧结果 | PM03 | 编排 | 部分：只读观察＋SQLite 历史候选意图账本；主进程启动依次尝试恢复旧暂停决定、处理遗留 running Pilot、启动 30 秒补偿扫描。携带任务身份的项目服务事件和已提交项目链修订会立即唤醒全项目权威对账，扫描期间事件合并补跑；项目链事件回读精确 revision/payload，外层回滚不误发。活动授权和全部门禁通过时，当前执行候选进入唯一受控派发。停止信号贯穿二次对账并在预算预留前检查。运行中断恢复时撤权、转 stale，并按完整绑定决定是否记录 unknown。尚无审批答复后的执行续跑；删除等缺项目身份事件依赖周期补偿 | 观察 8＋账本 6＋后台对账 7＋受控派发 3＋恢复对账 11 PASS；完整行为未执行 | 未执行 |
| PM05 | P0 | 事实驱动的结构化计划和角色选择；确定性约束校验，拒绝虚构状态/越权动作 | PM02,PM03 | 编排/模型 | 待开始 | 未执行 | 未执行 |
| PM06 | P0 | 受控命令派发、统一readiness和依赖等待/唤醒；隔离旧bypass路径 | PM01,PM04,PM05 | Runtime/安全 | 部分：当前 `ready_candidate` 进入唯一派发入口，执行前重读权威事实并复核活动 grant、readiness、策略指纹、角色、工作区和预算，以确定性 ID 原子排队后复用启动门禁；普通员工派发和普通 queued 启动在活动 Pilot 下 fail-closed。任务状态和项目链修订可即时唤醒重算，30 秒扫描兜底。尚无真实 Runtime 启动证据、审批续跑或评审/返工派发 | 后台对账 7＋受控派发 3＋研发执行 16 PASS；production readiness 仍阻塞 | 未执行 |
| PM07 | P0 | 执行→技术评审→有限返工→再审；终态与人工业务验收分离 | PM06 | 编排/研发链 | 待开始 | 未执行 | 未执行 |
| PM08 | P0 | 顶部最小收件箱：必要提问/权限/交付/决策；权威源、版本、过期、多入口幂等 | PM04 | 前端/主进程 | 待开始；本轮只有单项目决策/交付只读提示，不是收件箱 | 未执行 | 未执行 |
| PM09 | P0 | 项目事项主动通知→用户答复→自动恢复；拒绝/失效正确停等，不另点运行 | PM06,PM08 | 通知/编排 | 待开始 | 未执行 | 未执行 |
| PM10 | P0 | 预算预留、用量限制、重试/返工上限、暂停撤权、基本多项目隔离与审计 | PM01,PM03,PM04 | 安全/Runtime | 规则部分确认：用户主动暂停/撤权先看影响面并确认，确认后阻止新派发、取消未启动的 Pilot 排队执行；运行中执行逐项选择完成本轮或请求停止。活动 grant 暂停原语已接 IPC/UI；预留额度由账本按剩余额度/次数派生并传入支持该能力的 Runtime 作为调用级超额停止阈值，不支持时启动前拒绝；最终费用仍可能超预留并进入对账。command/execution 启动认领同事务提交；queued 取消同事务释放费用和次数预留。Runtime 终态原文已不可变保存，带费用时按 `runtime_reported` 结算，无费用时明确 unknown；重启恢复会复核原文哈希、回执 ID、会话和防重放键。真实停止证明、Provider 直接回执/价格快照和人工对账解除仍未接通 | 暂停恢复 12 PASS、命令关联 5 PASS、预算账本 25 PASS、恢复对账 11 PASS、活动 grant 暂停 10 PASS、Runtime 预算 3 PASS；完整 A06 未执行 | 未执行 |
| PM11 | P0并行 | 任务行可达Review、验证可发现、范围扩大后重新冻结；不额外调用模型补交付 | PM00 | 前端/研发链 | 部分：任务列表标题直达 Radix Dialog 中复用的 TaskReviewPanel，Review 操作后刷新任务列表；范围扩大后重新冻结仍未实现 | typecheck/lint PASS；UI 交互真机未执行 | 未执行 |
| PM12 | P0并行/P1 | 顶部项目/状态总览合并、可下钻；绑定移配置；不以此替代自主闭环 | PM00 | 前端 | 待开始 | 未执行 | 未执行 |
| PM13 | P0门禁 | 固定构建的无页面、多角色、自动评审返工、必要审批恢复真实试跑 | PM02–PM11 | 工程复核＋用户 | 待开始 | 未执行 | 未执行 |
| PM14 | P1 | 重启/丢事件/重复审批/晚到结果/在途撤权/多项目并发故障矩阵 | PM13 | Runtime/测试 | 待开始 | 未执行 | 未执行 |
| PM15 | P1 | 完整五组导航、团队职责拆分、默认值继承、低配置初始化、知识授权保留 | PM12,PM13 | 产品/前端 | 待开始 | 未执行 | 未执行 |
| PM16 | P1 | 约定观察窗口＋非代码项目/更多Runtime独立验收，不外推首版结果 | PM14,PM15 | 测试＋用户 | 待开始 | 未执行 | 未执行 |
| PM17 | P2 | 定时简报、授权外部通知、跨项目资源调度、策略效果反馈 | PM16 | 编排/产品 | 待开始 | 未执行 | 未执行 |

约束：PM10 是 PM06/PM07 开放真实自主运行前的硬门禁，不能因为表中排序靠后而后补。Workflow 审批恢复断口仅在首版选用 Workflow 执行路径时成为 PM09 前置修复；否则独立留风险，不扩大本轮实施范围。

## 3. 行为验收（仅有局部确定性证据，完整场景均未通过）

| ID | Given / When / Then 简要契约 | 关联 |
|---|---|---|
| A01 | 给定有效目标/授权/模型配置，用户离开项目与会话页，应用仍运行；系统自动启动并跟进任务，不以页面mount触发 | PM02,PM03,PM13 |
| A02 | 给定含并行项与依赖项的目标；系统根据角色能力形成计划并真实派发；未满足依赖不运行，解除后自动派发 | PM05,PM06 |
| A03 | 执行者提交一个预设可检测缺陷；技术评审识别并触发限额返工；新版本自动再审；不冒充人工验收 | PM07 |
| A04 | 下一步超出既有授权/缺信息；系统主动通知并给出上下文；用户批准后自动恢复对应动作，拒绝后不执行 | PM08,PM09 |
| A05 | 重复事件、重复批准、源版本改变或旧结果晚到；不重复派发，不批准旧交付，不重放失效工具请求 | PM04,PM08 |
| A06 | 用户主动暂停/撤权先预览项目、策略版本与 Pilot 执行影响面；确认后阻止新派发、取消未启动的 Pilot 排队执行；快照变化需重确认。预算耗尽/授权过期立即阻止新派发；运行中执行逐项选择完成本轮或请求停止，并报告终止确认状态 | PM10 |
| A07 | 两项目相近任务、不同工作区与知识授权；不会错用负责人、cwd、资料或审批，缺绑定时明确阻塞 | PM03,PM10,PM14 |
| A08 | 项目无需Git仅规划/非代码执行；用户不用先进入工作区；系统使用隔离管理上下文且正确授权 | PM03,PM16 |
| A09a | P0最小崩溃安全：派发/审批落地前后中断；重启先对账，结果或授权不明则暂停；不重复派发，不恢复失效授权 | PM04,PM08,PM10,PM13 |
| A09b | P1完整恢复矩阵：长期离线、事件遗漏、并发恢复、部分外部副作用；对账后正确恢复或升级人工 | PM14 |
| A10 | 约定观察窗口内保持应用运行；记录自主步骤、必要决定、人工催办/寻找入口、费用和故障，不只采成功样本 | PM13,PM16 |
| U01 | 项目列表/总览同入口且可下钻，任务行可开同一详情；工作区在配置；不需要教用户找下一步 | PM11,PM12,PM15 |
| U02 | 扩范围审批后重新预检并冻结交付，不为重新提交而多派一次模型；旧版本审批作废 | PM11 |
| U03 | 从目标开始集中确认缺少的配置；复用默认渠道/模板，不能伪造已批准的业务决策 | PM02,PM15 |

## 4. 门禁与可宣称能力

| 门禁 | 要求 | 当前 | 可宣称 |
|---|---|---|---|
| G0 设计/授权契约 | PM01确认，命令/事件/审批/预算/存储契约可评审 | 未通过 | 只有设计和可复用地基 |
| G1 确定性闭环 | fixture下A01–A07及A09a；硬断言含越权拒绝、过期/重复审批、重复派发、依赖等待/唤醒、预算耗尽、撤权、跨项目隔离、崩溃后安全对账；现有链路回归 | 部分执行，未通过：A05/A07 有局部夹具证据；A09a 已覆盖排队写入回滚、启动认领回滚、queued 取消回滚及 running 重启撤权停等，但完整派发/审批崩溃矩阵未通过；A01–A04/A06 完整场景未通过 | 仅通过范围内的确定性机制 |
| G2 首次真实自治 | 前置G0/G1通过且获用户单独试跑授权；固定构建/角色/模型/预算，无页面推进、多角色评审返工、A04续跑，人工签收 | 未执行 | 仅特定组合的受控自主推进 |
| G3 日常试用 | A08/A09b/A10、完整故障矩阵/UX、构建打包烟测、完整未支持清单 | 未执行 | 已验收范围内的本地持续管理 |

任何门禁均不能以 Task Review 的 R01 PASS 代替。没有云端常驻部署和验收，不宣称应用退出后也能推进。

## 5. 风险与待决

| ID | 风险 | 处置/关闭条件 |
|---|---|---|
| K01 | Proactive safe/plan限制与自治写动作不兼容 | 单独受控命令契约，不全局放开权限；G0审查 |
| K02 | 普通员工旧bypass执行路径 | 首版角色池排除，或先完成安全迁移与验证 |
| K03 | 三类workspace配置、projectId注入不统一 | PM03联合校验，不静默fallback |
| K04 | 任务状态和项目链修订已能即时唤醒重算，但删除等无项目身份事件仍依赖周期扫描；事件唤醒不等于审批后自动续跑 | PM06/PM09 补齐审批续跑与缺身份事件，不把周期兜底冒充全部即时 |
| K05 | Workflow审批后仅ready | 首版使用该路径则修复和验证续跑；否则独立跟踪 |
| K06 | 模型自述/技术评审冒充真实验收 | 绑定权威ID/revision/验证证据，人工门禁不变 |
| K07 | 审批过期、重复与崩溃后重放 | 源服务重校验、幂等、恢复对账，不复用失效授权 |
| K08 | 自动返工成本循环 | 预算/用量/重试次数、停止条件与通知 |
| K11 | 受控派发已复用授权、readiness、命令账本、预算和原子排队/认领，但 SQLite 认领提交与外部 Runtime 实际开始无法跨系统原子化，当前测试也只注入 readiness/start 替身 | 认领后失败进入 unknown 停等，重启遗留 running 撤权转 stale；补齐真实 Runtime 启动调用证据、真实停止证明及完整故障矩阵 |
| K09 | 范围过大、又先做完UI才补智能 | PM13为第一产品交付，UI全面重构不作为其前置 |
| K10 | 历史台账与点击基线不完整 | 保留原始失败/热修历史；逐项补证据，不补造PASS |

## 6. 本轮记录

| Run/记录ID | 日期 | 内容 | 结果 | 证据边界 |
|---|---|---|---|---|
| AUDIT-20260926-01 | 2026-09-26 | 三路源码/界面/历史台账只读审计 | 完成 | implementation-audit.md；未执行测试 |
| ALIGN-20260926-01 | 2026-09-26 | 主目标恢复为主动管理，重排阶段并建台账 | 完成 | goals-and-roadmap.md；不是产品实现 |
| PILOT-20260926-01 | 2026-09-26 | 只读观察首片：IPC/preload/概览、权威依赖/执行/链路投影 | 部分实现；7/7 新单测 PASS，project-chain 4/4 与 project-service 1/1 回归 PASS；typecheck/lint PASS；真机未执行 | 临时 SQLite fixture；`bun test apps/electron/src/main/lib/project-pilot-reconcile.test.ts`，无真实 Provider；不覆盖 A01–A07/A09a |
| PILOT-20260926-02 | 2026-09-26 | 项目策略草案：默认 paused，版本、隔离、过期/预算字段、配置损坏拒绝、锁与随机临时文件 | 仅草案内部 API，7/7 新单测 PASS；无激活/IPC/运行器；不计为授权系统完成 | `bun test apps/electron/src/main/lib/project-pilot-policy.test.ts`；未验证真实员工/工作区/渠道绑定与预算预留，G0/G1 未通过 |
| PILOT-20260926-03 | 2026-09-26 | 任务列表标题直达既有 Review（Radix Dialog），Review 操作后回读任务 | 代码已接入；真机/交互验收未执行；范围扩大后重冻结未实现 | 四个定向测试文件合计 19 PASS、typecheck/lint PASS；无新增 UI 自动化用例 |
| PILOT-20260926-04 | 2026-09-26 | SQLite 历史候选意图账本：去重、过期投影失效、项目删除清理、重启后强制重新读取权威事实 | 仅历史建议，不驱动模型/派发。无后台触发和严格跨写者快照一致性；不能作为授权或命令依据 | 新账本测试 5 PASS；连同现有四文件共 24 PASS，typecheck/lint/diff-check PASS；真实工作流未执行 |
| PILOT-20260926-05 | 2026-09-26 | 内部只读绑定预检：复核项目/策略、过期、`.git` 标记、启用渠道/模型、员工身份/执行配置/工作区一致性与两种角色名称 | 7/7 新行为测试 PASS，原策略测试 7/7 PASS；Electron typecheck、Biome、diff-check PASS。只检查当前配置，不验证评审能力或预算预留；无 IPC/UI 消费者、激活或真实运行 | `bun test apps/electron/src/main/lib/project-pilot-readiness.test.ts`；`bun test apps/electron/src/main/lib/project-pilot-policy.test.ts`；无真实 Provider，G0/G1 仍未通过 |
| PILOT-20260926-07 | 2026-09-26 | Agent execution 增加可空 `pilot_command_id`；旧执行无归属，新记录可显式保存，字段不可经普通状态更新改写 | 3/3 新定向测试 PASS，含旧库缺列迁移与普通执行保留；没有 Pilot 派发调用方，不能仅凭字段证明授权或安全取消 | `bun test apps/electron/src/main/lib/project-pilot-execution-attribution.test.ts`；真实暂停/取消未执行，A06/G1 未通过 |
| DECISION-20260926-02 | 2026-09-26 | 用户确认：暂停影响面中的每条运行中任务逐项选择“完成本轮后停止后续推进”或“立即请求停止” | 决策已入契约；请求停止后的 Runtime 终止核验与失败对账仍待实现 | 用户本次决定；A06/G1 未通过 |
| PILOT-20260926-08 | 2026-09-26 | 只读暂停影响面与选择校验：仅投影有持久命令关联的排队/运行执行，版本和状态变化使旧确认失效，每条运行中执行须单独选择 | 4/4 新定向测试 PASS；后续已增加命令关联核验与内部暂停/条件取消；仍无 UI/IPC、活动派发门禁与恢复对账，不算 A06 通过 | `bun test apps/electron/src/main/lib/project-pilot-pause-impact.test.ts`；无真实 Provider |
| DECISION-20260926-01 | 2026-09-26 | 用户主动暂停/撤权：先确认影响面，确认后立即阻止新派发并取消未启动的任务 | 产品规则已确认并接入项目概览 UI/IPC；仅处理可由 grant 命令账本证明归属的预留/排队执行，运行中逐项选择。确认同事务撤权、释放预留和条件取消未启动执行；真实停止器和完整派发门禁未接 | 用户本次决定；自动测试已覆盖原语，真机 UI/真实运行未验收，A06/G1 未通过 |
| PILOT-20260926-06 | 2026-09-26 | 策略草案新增显式 executor/reviewer 员工 ID；两者必须不同且属于员工集合。旧暂停草案保持可读，缺职责绑定时预检阻塞；再次保存须补齐 | 策略测试 8 PASS、预检测试 8 PASS；Electron typecheck、Biome、diff-check PASS。尚未核验评审能力；后续只接入内部预算原语，仍无活动授权和执行派发 | `bun test apps/electron/src/main/lib/project-pilot-policy.test.ts`；`bun test apps/electron/src/main/lib/project-pilot-readiness.test.ts`；无真实 Provider，G0/G1 未通过 |
| PILOT-20260926-09 | 2026-09-26 | 持久命令关联核验与内部暂停确认：旧快照拒绝；先持久暂停草案，再事务性条件取消关联的 queued 执行；运行项逐条选择完成本轮或请求停止，并区分已验证/未验证结果 | 命令关联 4 PASS、影响面及确认 7 PASS；普通/无关联执行不取消。无用户 UI/IPC、完整授权命令账本、完整活动策略派发/创建门禁和运行中终止对账，A06/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-command-links.test.ts`；`bun test apps/electron/src/main/lib/project-pilot-pause-impact.test.ts` |
| PILOT-20260926-10 | 2026-09-26 | 带 Pilot 标记的队列在普通员工启动入口读盘检查授权；暂停确认快照与逐项选择先落 SQLite，重启后仅在策略版本恰好前进到 paused 且确认指纹匹配时恢复原排队项的条件取消；已启动或归属不明则报告需人工对账 | 暂停/恢复定向测试 12 PASS，typecheck/静态检查 PASS；仅覆盖已有标记队列，尚无用户 UI/IPC、完整活动派发门禁和运行中终止核验，A06/A09a/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-pause-impact.test.ts`；无真实 Provider |
| PILOT-20260926-11 | 2026-09-26 | 启动前增加持久命令关联核验；形成同库 grant/命令/预算预留与崩溃恢复的 G0 契约草案 | 命令关联 5 PASS、暂停恢复 12 PASS；草案尚未实现活动授权、权威费用预留或真实派发，G0/G1 未通过 | `project-pilot-command-links.test.ts`；`g0-command-contract.md` |

| PILOT-20260926-12 | 2026-09-26 | SQLite grant/命令账本与内部费用/次数预留：幂等键、任务来源哈希与版本、角色/工作区/项目/依赖、预算及执行上限同事务检查；启动前核验账本-执行绑定 | 预算账本 12 PASS，含临时 fixture 活动 grant、重启持久、删除清理、关联重放核验及原子排队回滚；没有生产活动 grant 发行、当前策略同事务核验、原子排队的生产接线、临启动竞态防护、结算的生产用量接线/通用释放或真实模型；无效时钟已拒绝，G0/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-budget-ledger.test.ts` |
| PILOT-20260926-13 | 2026-09-26 | 活动 grant 的独立内部暂停事务：账本命令与执行/关联生成影响面，逐项记录运行选择并显式返回待发送停止请求；确认后同事务暂停 grant、释放未排队预留、条件取消未启动队列并释放其预留；旧快照、预留命令已有执行/关联、状态矛盾和晚期落库失败均拒绝或回滚 | 10 PASS；临时 fixture 直接插入活动 grant，未发行真实授权；已有可注入停止器的内部编排、失败未验证报告及重启只读对账，但没有真实停止器接线、用户 UI/IPC、JSON 草案同库迁移或临启动竞态防护，A06/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-grant-pause.test.ts`；未调用模型 |
| PILOT-20260926-14 | 2026-09-26 | 内部费用结算：仅终结且归属可核验的运行命令入账，已知费用幂等结算；未知或超过预留则保留占额、将命令置待对账并暂停 grant，预算读取按较高实际费用计 | 预算账本合计 12 PASS；实际费用由测试调用方传入，尚无可信 Provider 用量/价格证据与执行绑定、生产结算调用方或人工对账解除流程；G0/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-budget-ledger.test.ts`；未调用模型 |
| PILOT-20260926-15 | 2026-09-26 | 按用户选择新增临时隔离 Git 样例项目：合成双角色、安全研发预检、依赖解除、原子排队/幂等、预算、暂停隔离与重启对账三条无模型纵向测试（含跨项目隔离与 SQLite 写入故障注入、数据库重开核验） | 3 PASS，29 assertions；活动 grant 仅由临时 fixture 直接插入，策略草案保持 paused，不启动 Provider/Runtime；未模拟进程强制终止；覆盖范围见 `g1-isolated-fixture.md`，A05/A07/A09a 各有局部确定性证据；A01–A07/A09a 整体仍未通过，G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-g1-fixture.test.ts`；临时 Git 仓库运行后清理 |
| PILOT-20260926-16 | 2026-09-26 | 另建用户可查看的隔离本地 Git 样例仓库，最小 `sum` 模块与 Bun 测试，提交干净基线 | `/private/tmp/project-pilot-g1-s0677_5b`，HEAD `d802fd7`，`bun test` 1 PASS；仅本机临时目录，未注册为业务项目、未派发员工或模型 | `git status --short` 为空；目录可能被系统清理，测试夹具可重建 |
| PILOT-20260926-17 | 2026-09-26 | 新增只读 grant 重启对账：区分可重新核验的未排队预留/完整队列、未知运行结果、失效授权、破损关联和孤儿执行；不自动认领或重派 | 7 PASS；重开数据库后仍只读，命令状态未变；没有生产启动恢复调用方、Runtime 进程终止证据或真实崩溃注入，A09a/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-recovery.test.ts`；无模型 |
| PILOT-20260926-18 | 2026-09-26 | 主进程启动与 30 秒周期执行无页面只读候选对账，SQLite 留痕；项目概览通过单次权威观察展示当前候选并定位任务或其顶层祖先，或进入协作链路；退出时取消后台写入 | 后台行为 3 PASS，含依赖解除旧候选失效、重开数据库与跨项目隔离；仅本地数据与无模型对账，未实现事件唤醒、受控派发或审批续跑，PM04 仍为部分，G0/G1 未通过 | `bun test apps/electron/src/main/lib/project-pilot-background-reconcile.test.ts`；真机窗口和 30 秒周期尚未验收 |
| PILOT-20260926-19 | 2026-09-26 | 内部活动 grant 发行：重新预检 paused 草案，冻结完整授权指纹，在策略文件锁内幂等写 SQLite；旧确认、绑定变化、并发其他活动授权均拒绝；命令预留与启动前重新核对当前策略和发行指纹 | 发行 4 PASS、预算账本 13 PASS，既有暂停/恢复/G1 fixture 已升级为完整策略快照；没有发行 IPC/UI、真实 Provider/费用证据或 Runtime 启动，PM01 仍为部分，G0/G1 未通过 | `project-pilot-grant-issue.test.ts`、`project-pilot-budget-ledger.test.ts`；未调用模型 |
| PILOT-20260926-20 | 2026-09-26 | 项目概览新增 Pilot 控制面：只列安全研发员工，保存 paused 草案；展示预检阻塞；发行采用预览后明确确认；暂停展示预留/排队/运行影响面，运行中逐项选择后撤权并取消未启动执行。底层禁止活动 grant 下改写草案，过期、绑定漂移或旧库缺确认指纹明确显示不可派发/需对账，旧授权仍可进入保守暂停，最终确认展示模型与到期时间 | 控制面 3 PASS、候选筛选 1 PASS，发行 4 与暂停 10 回归 PASS；IPC/preload/UI 类型链通过。没有 Runtime、模型调用、可信费用结算或真实停止器；`request_stop` 只持久记录为待核验 | 真机窗口尚未验收；PM01/PM02/PM10 仍为部分，G0/G1 未通过 |
| PILOT-20260926-21 | 2026-09-26 | 费用结算由裸金额改为结构化用量声明：绑定 command 对应的终结 execution、session、员工、任务、持久来源关联、渠道和模型；保存声明 JSON，拒绝未来时间、伪造来源类型、身份漂移和重复异值结算；unknown/超预留撤权停等，恢复对账拒绝缺证据、unknown 冒充 settled 及证据金额与账本不一致 | 预算账本 14 PASS、恢复对账 7 PASS、grant 迁移测试覆盖新列；全仓 typecheck 与本切片 Biome PASS。没有 Runtime/Provider 调用 | Provider 回执 ID、价格来源和 token/费用仍由调用方声明；尚无受信原始记录核验或回执防重放，费用预留仍由调用方传入；只能称结构化结算原语，PM01/PM10 仍为部分，G0/G1 未通过 |
| PILOT-20260926-22 | 2026-09-26 | 命令输入移除预留金额，SQLite 事务按剩余授权费用/剩余次数向上取整派生每次预留；Provider 回执按渠道与回执 ID 生成哈希唯一键，跨命令重放拒绝，恢复时缺键或键不匹配停等 | 预算账本 15 PASS，暂停 10、隔离 Git 3、恢复 7 PASS；全仓 typecheck 与本切片 Biome PASS。没有 Runtime/Provider 调用 | 派生额度尚未传入 Runtime 形成单次硬上限；Provider 回执 ID、价格和 token/费用仍由调用方声明，未接受信原始记录核验；PM01/PM10 仍为部分，G0/G1 未通过 |
| PILOT-20260926-23 | 2026-09-26 | Runtime capability 增加调用级费用超额停止阈值声明；Pilot 启动先重跑绑定预检，再从账本读取已冻结预留额并换算为 USD，阈值与应用配置取较小值后传给 Claude SDK。proma/pi/ai-sdk 收到调用级阈值时 fail-closed；Workflow 分支不得丢弃阈值；不因 Claude 支持阈值而把它加入首版安全研发白名单 | Runtime 预算 3、共享能力 7、预检 9、隔离 Git 3 PASS；全仓 typecheck、Biome、docs check、Electron build PASS。没有 Provider 调用；真实 Pilot 仍无法通过预检 | SDK 只承诺超过 `maxBudgetUsd` 后停止，不能视为绝对费用封顶；尚无可信费用采集、结果结算调用方或已同时满足安全研发与预算停止阈值的 Runtime，PM01/PM10 仍为部分，G0/G1 未通过 |
| PILOT-20260927-24 | 2026-09-27 | Pilot 启动前在单一 SQLite 事务把 command 与 execution 从 queued 认领为 running 并绑定 session；更新中断全部回滚，调用 Runtime 前再复核策略与员工绑定。用户停止、任务改派/暂停/删除及状态变更取消 queued Pilot 时，同一事务释放 command 的费用和次数预留；旧暂停恢复入口对现有账本也原子释放，缺失应有账本时拒绝取消。完成/失败/卡点/确认停止事件缺少可信 Provider 回执时，生产路径统一以 unknown 结算、暂停 grant 并保留预留待对账 | 预算账本 22 PASS，含认领/取消中断注入、旧入口额度重用和 unknown 结算；命令关联 5 PASS；既有研发执行 15 PASS；Electron typecheck、Biome PASS。没有 Provider 调用 | SQLite 认领提交与 Runtime 实际开始之间不能跨系统原子化，间隙崩溃仍需恢复对账；创建会话/工作树失败保持 queued 但会留下可回收的私有会话资产；尚无可信回执采集和真实受控派发。PM10 前移但 G0/G1 未通过 |
| PILOT-20260927-25 | 2026-09-27 | 主进程初始化数据库后扫描遗留 running Pilot：不自动重派，先暂停同项目活动 grant 并将 execution 转 stale；仅当命令无旧费用痕迹且现有结算原语完整核验 execution/session/channel/model/link 时记录 unknown/needs_reconcile。缺命令/link、错版本或旧证据保持账本原样并报告 needs_attention；单条事务失败后仍单独撤权并继续扫描 | 恢复对账 11 PASS，覆盖真实数据库关闭/重开、破损账本、旧证据保留、事务回滚撤权及 queued/普通执行排除；全仓 typecheck、本切片 Biome PASS。没有 Runtime/Provider 调用 | `unknown_recorded` 仅表示未知费用已保守占额，不表示费用对账完成；无法证明崩溃前 Provider 是否已开始或仍在外部运行。真实 Runtime 停止证明、可信回执采集和受控派发仍未完成，G0/G1 未通过 |
| PILOT-20260927-26 | 2026-09-27 | headless Runtime 完成回调透传原始终态 result；Pilot 将原文、Runtime、execution/session/channel/model、token、费用、原文哈希保存到禁止更新的 SQLite 回执表。带 `total_cost_usd` 的结果转换为 micros 后按 `runtime_reported` 结算；只有 token 时保留回执但仍按 unknown 撤权。结算与重启恢复均重新核对原文哈希、派生回执 ID、原文字段、会话和防重放键 | 预算账本 25 PASS，新增带费用结算、无费用停等、伪造引用、原文不可改写、会话错配、哈希损坏及重启缺记录行为；Project Pilot 15 文件、研发执行 15、全仓 typecheck 与 Biome PASS。未调用 Runtime/Provider | 该证据是 Runtime 转述，不是具有 Provider 请求 ID 的直接回执；Proma/AI SDK 当前终态没有费用，仍进入 `unknown_recorded`。Provider 直接回执、版本化价格快照、真实派发和停止证明仍未完成，G0/G1 未通过 |
| PILOT-20260927-27 | 2026-09-27 | 当前 `ready_candidate` 接入唯一受控派发：二次权威对账后复核活动 grant、readiness、策略指纹、执行角色与工作区，生成确定性命令/执行 ID，复用预算账本原子排队及既有启动门禁。活动 Pilot 项目的普通员工派发与普通 queued 启动 fail-closed；后台停止信号贯穿二次对账并在预留前阻断 | 受控派发 3 PASS，后台对账 3 PASS，研发执行 16 PASS；Project Pilot 16 文件、全仓 typecheck、本切片 Biome、docs check 与 Electron build PASS。未调用 Runtime/Provider | 测试注入 readiness 与启动替身；production readiness 当前仍会阻塞全部首版 Runtime，因此没有真实 Runtime 开始/费用/停止证据。仅执行角色候选已接通，技术评审返工、审批续跑和依赖事件唤醒未实现；G0/G1 未通过 |
| PILOT-20260927-28 | 2026-09-27 | 后台订阅统一项目服务的携身份任务事件并立即唤醒权威对账；扫描中多个事件合并为一次补跑，扫描失败期间的新事件仍兑现补跑。停止时 abort、清定时器并取消订阅；删除等无任务身份事件继续由 30 秒扫描补偿 | 后台对账 5 PASS；Project Pilot 16 文件、全仓 typecheck、本切片 Biome PASS。未调用 Runtime/Provider | 只覆盖通过 project-service 发出的携任务事件；直接 store 写入和删除事件不会即时唤醒，周期扫描是真实兜底。交付/审批事件与真实 Runtime 仍未接通，G0/G1 未通过 |
| PILOT-20260927-29 | 2026-09-27 | project-chain 的决策、交付和审批修订提交后触发 Pilot 对账；通知延迟到 microtask，并按 project/revision/payload 回读权威行，外层事务回滚不发假事件，监听器异常逐个隔离。后台停止后取消链路订阅 | 项目链 5 PASS、后台对账 7 PASS；Project Pilot 16 文件、全仓 typecheck 与本切片 Biome PASS。未调用 Runtime/Provider | 事件只触发权威重算，不会自动批准交付或恢复审批后的 Runtime；数据库在 microtask 核验前关闭时跳过通知，启动/周期对账补偿。真实 Runtime、技术评审返工和审批续跑仍未接通，G0/G1 未通过 |

| PILOT-20260927-30 | 2026-09-27 | 启动认领同事务写入 Pilot 本地启动尝试；runner 入口前同步保存一次性交接意图，交接时复核活动授权、策略、任务来源、依赖和执行会话，并重跑渠道/模型/员工 readiness、核对交给 runner 的启动参数；认领或交接遇外层未提交事务直接拒绝。旧库只补表不回填历史。交接失败不调用 runner；崩溃窗口内即使已有交接意图，实际 Runtime/Provider 是否启动仍为 unknown | Project Pilot 定向 17 文件 122 PASS，连同研发执行共 18 文件 138 PASS；全仓 typecheck、本切片 Biome、diff-check PASS；认领/审计写入回滚、嵌套事务拒绝、认领后撤权或任务变化及重复交接有夹具测试。未运行真实 Runtime/Provider | 基线 `a44c3868`，未提交工作区改动；仅本地交接意图，不是 Runtime 实际开始证明或外部启动回执。readiness 与交接持久事务非跨配置存储原子快照，故不能据此开放生产派发；G0/G1 仍未通过 |

| PILOT-20260927-31 | 2026-09-27 | 重启时读取本地启动尝试并核对 command/project/session 与时间，按 `claim_only`、`handoff_intent`、`missing_attempt`、`invalid_attempt` 分类；输出写入启动日志。所有分类均保守撤权、running 转 stale、未知费用占额并停等；缺记录不推断为旧库或从未调用，交接意图不证明 Runtime 真正开始 | 恢复对账 14 PASS，Project Pilot 与研发执行合计 18 文件 141 PASS；全仓 typecheck、本切片 Biome、diff-check PASS。覆盖数据库重开、缺记录、会话损坏、未来时钟与重复恢复；不含真实 Runtime/Provider | 在未提交的 `-30` 工作区变更上继续；基线 HEAD `a44c3868`。只是诊断分层，既未实证外部启动或停止，也不解除 G0/G1 门禁 |

| PILOT-20260927-32 | 2026-09-27 | 隔离 Git＋双安全研发员工＋活动 grant＋原子 queued 命令走真实 `tryStartExecution` 服务入口；生产 readiness 精确报告两员工 `proma` Runtime 均缺单次费用停止阈值，因此在预检处保持 queued、无启动尝试或 runner 调用，预留仍占额。不替换 readiness，不扩大白名单 | 研发执行 17 PASS；Project Pilot 与研发执行合计 18 文件 142 PASS、全仓 typecheck、本切片 Biome、diff-check PASS；无模型/Provider 调用 | 基线 HEAD `a44c3868`，在未提交 `-30/-31` 工作区变更上继续。测试仅证明生产预检 fail-closed，不覆盖预检通过后的费用换算、真实 Runtime 启动或 G0/G1 门禁 |

| PILOT-20260927-33 | 2026-09-27 | 修复 `updateTask` 接受 `workspaceId` 但未持久化的断口；显式清空会写 NULL，省略不改变绑定，草稿创建与确认保留工作区；统一项目服务的工作区清空事件标记 `changedFields.workspaceId`。这是任务事实/隔离修复，不等于 PM03 全部统一 | 工作区定向 1、草稿规则 4 PASS；连同 Pilot、研发执行、项目服务共 21 文件 148 PASS；全仓 typecheck、本切片 Biome、diff-check PASS，含重开数据库与服务层事件检查；未在 Electron native SQLite 真机验收 | 基线 `a44c3868`，继续叠加未提交切片；无真实 Runtime/Provider，G0/G1 未通过 |

| PILOT-20260927-34 | 2026-09-27 | 用户批准评估 Pi：核对仓库已装 `@earendil-works/pi-agent-core` 0.82.1，该版无公开 `finishTurn`/请求前 `prepareRequest`；新增仅测试引用的假 stream 逐轮预算实验，不调用 Provider。验证首轮准入、下一请求拒绝、工具前阻断、缺费/超预算保守停止、失败回执费用保留和手动 abort 接线 | Pi 假流 6 PASS；与 Pilot、研发执行及任务规则合计 22 文件 154 PASS；全仓 typecheck、Biome、diff-check PASS | 基线 HEAD `a44c3868`，未提交工作区变更；实验模块未接生产 adapter，未证明真实 Pi 扩展/工具逃逸阻断、Provider 原始请求/费用回执、单次请求硬费用上限及真实停止。Pi 仍不在首版白名单、能力位仍 false，G0/G1 不变 |

| PILOT-20260927-35 | 2026-09-27 | 实际 bump `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 0.82.1→0.87.1（lockfile 同步）。迁移历史恢复断点：0.87 起 SessionManager 为会话唯一事实源，事后赋值 `session.state.messages` 不再进入模型上下文；改为创建 AgentSession 前用 `buildPiHistorySessionEntries` 把恢复历史组装成 parentId 单链 entries，经 `SessionManager.inMemory(cwd, undefined, entries)` 注入。`DefaultResourceLoader.systemPromptOverride`、`session.agent.toolExecution`、消息转换类型在 0.87.1 均保持兼容；adapter 测试的 `streamSimple` 改经 `normalizeContext`（Context→TranscriptContext 品牌类型） | 新增 3 个 0.87 回归测试（条目链结构、真实 SessionManager `buildSessionContext` 回读、预种子 manager 创建 AgentSession 后 `session.messages` 可见历史）PASS；pi-message-adapter 9 PASS；全仓 `bun run test` 498 文件 0 失败、全仓 typecheck、Biome PASS。未调用 Provider | 基线 HEAD `0c0e2d35`（已推送）；真实 Provider 冒烟（PROMA_PI_REAL_API）未开，Pi 扩展逃逸/原始回执/硬费用上限未验证；Pi 仍不在首版白名单、能力位仍 false，G0/G1 不变 |

后续每个测试Run需记录：固定HEAD及脏文件、应用形态、Runtime/model、project/task/execution/delivery IDs、状态revision、授权/预算、预期自主步骤、实际动作、人工必要决定/催办/技术支持、费用/用量、日志、结果、签收。未知填unknown，重测新增Run并引用retestOf。

## 7. 下一次执行

0. 接入 Provider 直接回执 ID 或版本化价格快照，并继续区分 Provider 原始证据、Runtime 转述、可追溯估算和 `unknown_recorded`。为首版安全研发路径实现可验证的调用级费用门禁，或在独立验证后明确纳入一个已支持该能力的 Runtime。
1. 本地认领与调用前交接意图已有记录，但实际 Runtime/Provider 开始仍不可证明；补独立的实际开始回执与进程故障注入，并把审批答复接到可核验的自动续跑，保持普通员工旧入口不可绕过。
2. 接入真实停止器和审批续跑；`request_stop` 未核验时保留预算并升级人工对账。完成执行→技术评审→有限返工→再审的确定性链路，终态仍不冒充人工业务验收。
3. 实现最小项目收件箱与必要澄清/权限/交付/决策恢复，再用隔离 Git 样例逐项执行 A01–A07/A09a 的完整确定性闭环；G0/G1 均通过后，另行冻结模型、费用和调用上限并请求 G2 真实试跑授权。
4. 每项分别记录实现、自动测试和真实验收；未知状态写 unknown，重测另记 Run，不用局部 PASS 代替门禁。
