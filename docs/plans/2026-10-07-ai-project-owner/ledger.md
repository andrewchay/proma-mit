# AI Project Owner：重新开始的实施与验收台账

建立/生效：2026-10-07 00:35 GMT+8 用户确认。核对 HEAD：`2ba5dfcd`（非冻结测试构建）。[统一目标与路线](goals-and-roadmap.md) 是产品目标权威入口；本台账是新交付顺序和验收状态权威入口。

## 1. 当前结论

- 核心目标：AI 是项目 Owner；人给目标、必要约束、关键授权与验收，AI 主动拆解并在有效授权内持续推进。
- 旧三条路线保留：Pilot 为编排/安全地基，Task Review 为专业执行与审阅适配器，可用性整改为过渡入口。它们的 PASS 不等于 AI Owner 已完成。
- 旧可用性整改“先手填员工/工作区/文件/决策”的主路径已不再是默认产品目标。R-P1-03 等剩余项不按旧顺序直接续做，先经新能力核验重新映射。
- 截至2026-10-09 GMT+8：受控Owner规划A–D已本地完成（HEAD `20eb5922`），包含项目/单任务目标、结构化澄清/生成提案、审阅修订/内容确认，以及费用确认→Worker→真实SDK的隔离transport链；真实Provider、代表性用户端到端及通用Owner调度仍未完成。AO-05暂停执行授权准备首片已本地完成并验收，保存准备不收费、不建业务任务、不发行许可；内容确认、规划费用确认、业务执行许可始终分离。历史PR19/20与各片证据不改写，不按基础切片折算产品完成比例。
- 截至2026-10-09 12:05 GMT+8：AO-06[暂停Task与精确步骤关联首片](owner-task-materialization.md)已本地收束。项目目标每step新paused Task与准确依赖，单任务一步显式复用目标；原准备不改，仍需重新验证。575隔离文件、全typecheck/lint/docs/build及Native45checks通过，独立复审整改收束。实际角色调度、依赖推进、执行许可与真实Provider仍未完成。
- 新产品目标不重置历史门禁结论：既有 G0 审定保留；历史 G1/G4 未补齐项继续有效，新增动作另补契约和证据。

## 管理职责设计参考（2026-10-07）

用户认可参考本地 `agency-agents` 的 Project Shepherd。已提炼为 [Owner 设计草案](owner-design.md)，覆盖项目简报、计划/依赖/角色、主动跟进、带建议升级和成果收尾。草案属于 AO-00 的设计资料；AO-01 原型方向获用户认可、AO-02 继续核验，AO-03～12 不因参考草案标记实现完成。

## 2. 状态与证据规则

状态：待开始 / 进行中 / 待审查 / 待验收 / 阻塞 / 暂缓 / 已完成。
产品确认、代码实现、确定性测试、固定构建 UI、真实模型与用户验收分别记。未重新执行的测试只能链接历史记录；负责人列为建议职责，不代表实际员工已创建或派发。

## 3. 新实施台账

| ID | 阶段 | 目标与退出标准 | 依赖 | 状态 | 本轮证据 / 未完成 |
|---|---|---|---|---|---|
| AO-00 | N0 | 统一三条路线为目标驱动 AI Owner；保留历史，停止以文件委派为默认模型 | 无 | 已完成（文档） | 2026-10-07 用户确认＋本目录；非产品代码完成 |
| AO-01 | N0 | 目标驱动可点击原型：非代码项目、代码单任务、主动澄清、计划确认、推进、成果审阅 | AO-00 | 已完成（原型方向确认） | [离线原型 v1](prototype/index.html)；15/15 模拟测试、代表性浏览器走查；用户2026-10-07 01:26 GMT+8认可并要求继续。非完整浏览器/产品验收 |
| AO-02 | N0 | 源码/契约缺口核验：Owner 上下文、目标与计划持久化、角色池、非代码执行、授权继承、审批续跑、Review/异常 | AO-00 | 进行中 | 逐roleKey员工映射与项目来源隔离已有工程证据；carrier仅作规划来源、工作区/岗位唯一匹配只作推荐、channel/model/runtime不从全局/最近值回退，配置漂移阻断；AO-02来源字段契约与跨项目负向用例已补，完整字段表见[能力核验](capability-audit.md)。本轮全量门禁通过；仍待多源冲突产品交互/代表性用户走查及后续Review/异常等能力，未关闭整体AO-02 |
| AO-03 | N1 | 项目/任务目标和必要约束可保存；缺配置不丢目标；模型规划前核验费用/资料授权 | AO-01、AO-02 | 进行中 | Goal草案、澄清答案未保存态、主体现实隔离、资料/费用门禁和单请求出口已有服务/界面实现与离线证据；本轮代表性非代码澄清→手工保存新Goal→新准备→再次费用确认才允许第二个fake请求通过。AO-03工程子片按当前适配器已核验；项目用户验收、固定构建导航、真实Provider费用仍未验收 |
| AO-04 | N1 | Owner 从目标主动提出结构化计划：任务、依赖、角色、成果、标准、风险和预算建议；可解释/修订 | AO-03 | 进行中（规划A–D子片已完成） | 新增非代码项目澄清→人工修订/保存→重新准备→fake-only结构化提案，以及单任务代码目标与项目Goal隔离/任务绑定proposal测试；代码样例没有读仓库，不能称真实定位。提案仍为proposed、不改业务任务/状态；真实Provider与代表性产品用户验收、主动业务编排仍未补 |
| AO-05 | N2 | 计划确认、执行授权分离并绑定版本；上下文继承可核对；新增命令契约补审 | AO-02、AO-04 | 进行中（暂停准备、任务材料化及Stage A/B实现切片已有证据） | [暂停执行准备](owner-execution-preparation.md)冻结confirmed版本、步骤/人员/资料配置与拟议预算；AO-06准确Task/step材料化、Stage A/B grant/command/request门禁与Scheduler已实现并有fake-only Native证据，过期unknown授权有不可复活归档路径。仅证明隔离实现；无生产active grant、Provider账单、真实费用/停止或AO-A05用户验收，不记AO-05整体完成 |
| AO-06 | N2 | 计划合法后在授权内创建权威任务、组织白名单角色、依赖推进，无重复和旧入口绕过 | AO-05 | 已完成（自主调度实现切片；产品级验收另列） | 已完成paused材料化、Stage A授权账本、Stage B执行链与自主调度实现。Native run `97382472-6dfa-43f8-8f3f-4a89b6e117ad`以fake dialog adapter验证取消不落grant、确认后两Task依赖续派；Renderer关闭后主进程继续完成角色运行，权威Task完成后仅续派下游一次。fixture执行全为fake、tripwire全零。AO-A06完整产品用户验收仍未完成；物理原生对话框点击、完整产品导航、真实Provider/费用、AO-G0～G3另行标记，未被本切片宣称通过 |
| AO-07 | N2 | Owner 后台跟进执行，组织技术评审/有限返工，主动发现卡点并提出下一步 | AO-06 | 进行中（工程实现已整合至本地 `codex/owner-a07-integrated` 分支） | 整合后全量隔离测试/typecheck/lint/docs/build通过；真实Provider、产品验收和 AO-G0～G3 未通过，不能按工程实现关闭整体 |
| AO-08 | N2 | 必要问题主动送达；答复绑定请求/源版本，批准后自动恢复，拒绝/过期正确停等 | AO-07 | 待开始 | 不能把收件箱显示存在当作通知与续跑完成 |
| AO-09 | N3 | 成果 Review 统一入口：成果/标准/证据/风险；代码附 Diff，非代码使用对应审阅类型 | AO-07 | 待开始 | 人工验收与技术评审/执行成功分开 |
| AO-10 | N3 | 修改意见形成新计划/交付版本；范围变化重新授权；写回/外发等明确确认 | AO-05、AO-09 | 待开始 | 复用 Task Review，补范围重冻结；非代码副作用不默认授权 |
| AO-11 | N3 | 异常安全收口、停止/预算 unknown、崩溃恢复、跨项目隔离；失败不被投影重新盲派 | AO-05、AO-07 | 进行中（研发验证进程树停止子片已实现） | Unix进程组/Windows进程树终止有实现与全量回归；Owner Runtime停止、unknown费用、崩溃恢复和跨平台真实验证仍需分开验收 |
| AO-12 | N4 | 固定构建、完整确定性/安全回归；两类端到端样例的 UI 和真实 Provider 验收 | AO-06～11 | 待开始 | 真实费用/执行前单独授权；旧 G1/G4 缺项独立核对 |

## 2026-10-07 17:41 GMT+8：用户优先要求员工创建修复

用户确认误选研发配置导致多数托管工作区不可用。新增 `controlled` 非代码配置和20模板预填，并显示研发排除与保存缺项；服务及Runtime启动重验绑定，不开放Pilot。100项定向回归与真实表单模拟API浏览器走查通过，证据见[修复记录](employee-creation-repair.md)。Electron0.12.108/shared0.2.26源码构建；用户0.12.104未自动更新。本批不代替固定Electron、原生驱动、真实Provider或Owner自主闭环验收。

## 2026-10-08：非代码项目入口与本地验收包

已补人工受控入口：项目任务可选择真实非代码员工及明确工作区，创建即暂停；执行需单次范围/费用确认，复用权威execution，模型发送前重验，完成仍待人工验收。见[非代码项目入口记录](noncode-project-entry.md)。19项新增服务/真实SDK离线用例及537文件全量测试通过；真实Electron组件/IPC/原生SQLite走查与0.12.109本地arm64打包烟测通过，尚未安装替换。全量lint仍有18个未改文件的原有错误，不记完整PR门禁通过。真实Provider与Owner自动组织/预算闭环均未验证，AO-06维持待开始。

## 4. 验收样例与判定

| ID | Given / When / Then | 主要证据 | 状态 |
|---|---|---|---|
| AO-A01 | 非代码项目，仅给“梳理产品定位，产出可评审方案”；Owner 提出必要资料、任务、依赖/角色与成果标准；不要求 py 文件、Git 或手工拆完任务 | 固定原型/离线fake流程样例；后续产品与真实模型 | 原型走查及隔离fake澄清/手工保存/新proposal通过；产品用户走查和真实模型未验收 |
| AO-A02 | 代码单任务，仅给“修复负数量报价，保留正常行为”；Owner 定位代码并提出修改/验证范围；人确认范围而非先提供全部路径 | 单任务Goal/计划隔离测试；需仓库检索与计划来源、范围确认记录 | fake-only覆盖任务Goal与项目Goal隔离及提案结构；仓库正文未注入规划适配器、真实文件定位/执行未验收且为当前能力阻塞 |
| AO-A03 | 目标缺决定性信息；Owner 集中提出必要问题；充分上下文不重复问，不把可继承配置转为必填 | 正/反向澄清测试和用户走查 | 离线澄清/正常分支测试通过；模型判断与用户走查待补 |
| AO-A04 | 可用项目默认值；Owner 推荐有效员工/工作区/工具；冲突时询问，不能静默跨项目访问 | 两项目候选隔离；roleKey员工映射、唯一精确roleTemplateId推荐与唯一项目workspace推荐已有离线BDD；缺失/冲突不自动挑人 | 部分离线契约通过；carrier/来源优先级与其他配置默认继承、冲突问答和用户验收未完成，不标整体通过 |
| AO-A05 | 未批准计划/无付费规划或执行授权；保存目标可以，付费调用/派发不可以；不同确认不能互相冒充 | `project-owner-plan-service.test.ts`覆盖目标/计划保存与内容确认不建Task/execution/grant；`project-owner-execution-preparation.test.ts`覆盖暂停准备零grant/command/request并拒绝旧发行入口；Stage A/B与fake-only Native另验执行授权消费门禁 | 服务级fake-only边界有证据；默认继承/冲突询问和完整产品走查未完成，真实Provider/费用/停止未验收 |
| AO-A06 | 计划/授权有效；Owner 自动落任务、安排执行/评审、依赖解除后续派；用户离开页面仍推进，正常样例人工催办次数为 0 | 固定构建后台端到端记录 | fake-only Native验证授权IPC取消/确认、两Task依赖、Renderer关闭后续派与重复事件去重；完整产品主窗口/物理原生点击与用户端到端验收未完成 |
| AO-A07 | 技术评审发现缺陷；授权内有限返工并重新评审，新交付版本不沿用旧验收；次数耗尽升级人类 | 返工/版本/预算账本证据 | 未执行 |
| AO-A08 | 缺关键决策或超范围；主动询问、停等；有效答复后自动继续，重复/旧答复不重派 | 通知、审批版本与续跑证据 | 未执行 |
| AO-A09 | 交付可审阅；人直接看到成果、标准和验证依据；模型自述不冒充验证；明确区分执行/技术评审/业务验收 | 通用 Review＋代码适配器走查 | 未执行 |
| AO-A10 | 人提出修改意见；Owner 明确改动和必要授权变化；需写回/外发时另确认，拒绝不发生副作用 | 命令、交付版本与写入/外发审计 | 未执行 |
| AO-A11 | 失败/未知费用/停止未核验；Owner 解释原因并提出处理；收口不删证据、不释放未知预算、不盲目循环重试 | 故障注入、恢复和收口测试 | 未执行 |
| AO-A12 | 暂停/撤权、应用重启、旧结果晚到、重复事件；先对账且无失效授权重放、不重复派发、不跨项目 | 旧 G0/G1 回归＋新计划版本故障矩阵 | 未执行 |

非代码样例首先验证目标→计划与通用成果模型；真实非代码执行是否成立由 AO-02 核验，不通过修改文档声称已有适配器。

## 5. 门禁

| 新门禁 | 放行条件 | 当前 |
|---|---|---|
| AO-G0 产品基线 | 用户确认目标驱动原型；职责、成果与必要人类决定明确；新增安全契约审查 | 目标/原型方向已获用户认可；新增安全契约待审查，未通过 |
| AO-G1 确定性闭环 | AO-A01～12 的适用确定性部分逐项映射，既有门禁回归，无不支持项冒充成功 | 未执行/未通过 |
| AO-G2 固定构建 UI | 两类场景可走通，不手工拆任务/找入口；审批与成果定位准确 | 未执行/未通过 |
| AO-G3 真实受控执行 | 固定角色/Runtime/模型/预算单独授权，记录全部人工介入、失败与真实费用，并人工签收 | 未执行/未通过 |

AO-G* 为新产品闭环门禁，不重命名、替代或自动追认旧 Pilot G0–G3、Task Review G0–G4。新增安全动作需增量审查，旧批准仍在原作用域内有效。

## 6. 旧任务如何处理

| 旧路线/ID | 新定位 | 后续安排 |
|---|---|---|
| Pilot PM02、PM05 | Owner 目标输入与主动规划核心 | AO-03/04，优先恢复，不以 UI 卡片完成冒充 |
| Pilot PM03/04/06～10 | 上下文、持久编排、派发、评审、审批和预算地基 | AO-02 逐项核验，再接 AO-05～08/11，不重复实施已成立服务 |
| Pilot PM11～15 | Review 可达、范围重冻结、UX/可靠性 | 按 AO-09～12 的必要断口推进，完整导航重构非前置 |
| Task Review W00～08 | 代码/文本任务适配器 | 历史证据保留；代码路径继续复用，不能外推非代码/自主 Owner |
| Task Review W09/W10、R02/R03/R04 | 固定构建真实验收与发布缺项 | 仍未自动完成；归入 AO-12 的代码适配器补验收 |
| UX R-P0-01～06/08、R-P1-01/02/04 | 已提交过渡修复，非 Owner 主流程交付 | 保留代码与证据；源码是否足够可靠由 AO-02 重核，不维持“已基本完成”的结论 |
| UX R-P0-07 | 权威异常收口 | AO-11，不删除 projection 就宣称解决 |
| UX R-P1-03、R-P2-01 | 手工任务卡片/用户层 DTO 探索 | 暂缓原交付顺序；按 Owner 场景核验后选择复用/重构，不新增表单默认必填 |

## 7. 风险与待决

| ID | 风险 | 原则/退出条件 |
|---|---|---|
| AO-K01 | “AI Owner”被实现成新名字的普通执行员工 | 明确项目级目标、计划版本、编排职责和权限主体；服务端门禁不变 |
| AO-K02 | 规划模型幻觉形成虚假依赖/执行事实 | 模型建议须结构校验及引用真实身份/来源；不接受虚构已完成结果 |
| AO-K03 | 仅优化 UX，核心主动规划继续后置 | AO-03/04 为主线，人工调度次数为硬验收指标 |
| AO-K04 | 非代码支持只停留在文案 | 从 N0 就覆盖样例，执行适配器不足明确阻塞；不混用 Git 约束 |
| AO-K05 | 计划一确认，未来所有动作自动获授权 | 计划版本/执行授权明确分离；超范围、费用和高风险动作重新校验 |
| AO-K06 | 再次重复数周的安全实现 | AO-02 来源映射先行，既有审定契约保留，只补真实断口 |

## 8. 本轮记录

| ID | 时间 | 记录 | 证据边界 |
|---|---|---|---|
| AO-RESET-20261007-01 | 2026-10-07 00:35 GMT+8 用户确认 | 更新三条路线及其目标、计划/测试文档的生效口径；建立新统一目标、台账、旧项映射与新门禁 | 仅文档校准；本轮未改代码、未重跑产品测试、未调 Provider、未新增运行授权 |
| AO-DESIGN-20261007-02 | 2026-10-07 00:48 GMT+8 用户参考建议 | 读取本地 Project Shepherd 全文（仓库 HEAD 58a6884、MIT），形成 Owner 职责/输入输出/主动循环/沟通/成果设计草案，映射 AO-A* | 方法借鉴与设计草案，不是运行实现；未复制整份角色、未创建有权限员工、未调用模型；未经验证指标不继承 |
| AO-IMPL-20261007-03 | 2026-10-07 00:56 GMT+8 用户要求开始；本轮实现 | 从 main 2ba5dfcd 创建 feat/ai-project-owner 独立 worktree；落目标/计划提案纯校验边界及初步能力核验 | 新测试 16/16，Pilot readiness 9/9、后台对账 7/7；typecheck/定向 Biome 通过；无真实调用或派发，原型/持久化/模型接入未完成 |
| AO-PROTOTYPE-20261007-04 | 2026-10-07 01:10 GMT+8 用户继续；本批交付 | 离线目标驱动原型 v1、15 条模拟分支测试、项目内目标/计划版本持久化提案 | 模拟测试15/15及独立TS/定向Biome通过；非代码完整代表路径、代码目标/计划/授权摘要浏览器走查；截图重试成功；不是产品/G0–G3/真实执行验收 |
| AO-IMPL-20261007-05 | 2026-10-07 01:26 GMT+8 用户认可原型并继续；本批实现 | paa.db新增Owner草案历史表与项目/任务目标服务：生成版本、并发拒绝、no-op、历史/回滚/重开/老库加表、无派发事件 | 新存储15/15＋规划16/16＋链服务5/5＋后台7/7，合计43项；typecheck/定向Biome通过。仅sql.js隔离测试，未接IPC/UI/模型、未做原生驱动/真实并发/产品验收 |
| AO-IMPL-20261007-06 | 2026-10-07 08:48 GMT+8 用户继续；本批实现 | 共享草案契约/严格IPC/preload、Jotai隔离与输入保护、项目概览目标表单；保存不收费/派发，冲突先比较后再保存 | 60项定向测试通过（新增IPC5＋状态9＋SSR3；服务/规划/链/后台43）；typecheck/定向检查、main/preload/renderer构建通过。源码组件模拟API浏览器填写/保存/截图通过，不是真实Electron传输/持久化或发布验收 |

## 9. 下一步

1. 受控规划A–D已完成，不重复实现。AO-05暂停准备的BDD、旧入口拒绝、Native与独立复审已收束；准备不是许可，当前不发行、不派工。
2. AO-06暂停权威Task/exact step关联首片已完成，不重复实施；关联不是执行授权。下一片需新版准备冻结真实Task/link/dep及完整派发/预算/启动/资料工具/每请求Owner来源门禁，之后另审AO-05真实许可发行与AO-06白名单调度、依赖推进。
3. AO-02继续真实职责/适配器/来源映射；AO-03/04补代表性目标与真实模型验收，真实费用仍单独授权。AO-07～12后台推进/审批恢复/Review/异常与端到端门禁尚未完成。
4. 不按旧台账继续默认手填全部任务，不清库或重置历史，不自动扩大范围，不启动真实付费试跑。

### 2026-10-08 安装更新

用户另行确认保存/停任务及备份安装，已保留完整私有配置与旧应用，`/Applications/Gravitas.app`现为0.12.109；实际安装路径的隔离package-smoke通过，无真实模型调用。用户生产导航/岗位执行与Owner自主闭环仍未验收。


### 2026-10-08 弹窗与员工停止修复

0.12.110修复确认弹窗长路径/小窗口遮挡、任务启动后停止入口刷新、真实取消回执反馈与员工执行记录停止按钮；同步取消回调不误报失败。538文件回归、typecheck/定向Biome及真实Electron组件/IPC隔离验收通过，Runtime runner/stopper为隔离替身，真实Provider及进程终止未验证。尚未替换正在使用的0.12.109；需本次独立安装许可。Owner自主闭环状态不变。

### 2026-10-08 PR #19 仓库lint清理

用户明确要求修正CI阻断。清理无调用的视频旧轮询、无展示的营销审核缓存/旧Chat状态/评分组件，测试采用真实ToolCall/ToolResult并恢复隔离环境；移除未用catch绑定，修正Hook依赖但保留主题变化同步及数据弹窗打开时重置。未调整lint规则、Owner/员工权限或Provider授权。Electron版本0.12.111。全仓lint零错误/警告、完整typecheck、538隔离测试文件失败0、docs:check/diff及完整构建通过。此前18错误的历史结果不变，本次本地门禁已通过；远端CI需以新提交实际结果为准。不安装、不发布、不合并；既有0.12.110 ZIP不冒充0.12.111产物。

### 2026-10-08 PR19授权旁路修复

合并前复查发现普通任务指派controlled员工仍复用早期自动派发测试，绕过准备/范围/费用确认。普通派发、queued启动与Provider/权限识别已按受控员工身份收束，缺回执fail-closed，历史任务无静默授权迁移。新回归先RED（旧路径产生execution）再修复；合法auto/safe测试改为显式prepare/preview/confirm。保留general/development及已准备任务任一证据保护。具体门禁结果以本轮交付及CI为准，不据此宣称真实Provider、Owner自主闭环或新版本已安装。


### 2026-10-08 PR19/20合并后的继续开发

用户17:30 GMT+8明确许可19→20合并；main最终`6c71b384`与PR20六项CI通过的tree一致，源码Electron0.12.113/shared0.2.29，不宣称独立post-merge CI完成。用户本地main已在18:13许可下安全快进并保留原note独有记录；备份/stash未清理。安装仍为0.12.109，用户此前暂缓更新，不因源码合并自动替换。

18:34与21:11 GMT+8用户要求在`feat/ai-project-owner`继续。新增[计划版本服务](plan-version-service.md)：`project_owner_plan_revisions`与目标表同库，双CAS、目标/来源/内容指纹、追加式proposed/confirmed历史、派生stale、旧来源拒绝、严格人工身份/历史解析。确认仅认可内容，模型/任务/execution/grant及派发事件为0。主进程五项IPC和typed preload已接；真实TaskItem无条件提供单任务目标入口，Jotai仅打开时加载，复用既有目标保存与冲突保护。

本片当前origin明确为manual，**没有AI生成或计划编辑UI、付费规划门禁、自动派工**。计划服务17项/106断言、IPC5项/39断言通过；固定构建和完整门禁的最终状态见[验证记录](plan-version-verification.md)。AO-02/03仍进行中，AO-04/05/06不因存储和内容确认子片标记整项完成；AO-G0～G3保持未通过。


### 2026-10-08 22:11 GMT+8继续：规划协议与审阅入口

[规划协议与审阅](planning-protocol-review.md)接严格needs_clarification/plan_proposal协议与项目/单任务计划UI，Jotai保护晚到输入与版本冲突、未保存目标禁写、旧确认不沿用，依赖选择不要求手填内部key。origin仍manual，未接Owner模型调用或生成回执。548独立文件失败0，完整typecheck/lint1981/docs/build通过；固定Electron39.8.10及实际产品preload/原生SQLite的47次IPC包含真实计划UI修订→新版本→内容确认/历史，非完整生产导航或安装包验收。Electron0.12.115/shared0.2.30，本地开发，无push/merge/安装/真实Provider。

独立源码审查推荐复用controlled权威Task/execution与启动/费用确认，通过owner_planning目的/source-link收紧为单请求零工具/历史/MCP/Skills。Owner/carrier身份、资料/费用范围、可信回执及重启unknown属新增契约，需要明确人审；go on不代表真实收费授权。当前ai-sdk capability支持预算停止，但实际费用出口为Pilot专属，不能伪造grant或误称普通Owner有硬预算。主动规划实现方案已形成，待审批，不按旧台账继续默认手工拆任务。

### 2026-10-08 受控Owner主动规划方案获实现审批：A基础

[Owner绑定/暂停关联](owner-runtime-binding.md)追加版本化职责→真实carrier绑定及同库source-link，严格目标/计划/context/config CAS、资料/协议指纹、目标业务任务与承载任务分离；复用controlled准备，paused零执行。关联或preparation目的证据任一存在即拒绝普通Agent启动，B出口未完成不会偷开放。13项/46断言、controlled23项/97、全仓549文件0失败、typecheck/lint1983/docs/build通过。Electron0.12.116/shared0.2.30；没有新增配置/启动UI、没有本片Native验收或实际模型，不能把本片记AO-02/03/04整体完成。继续B单请求零工具出口，费用仍另逐次确认。

### 2026-10-09 Owner主动规划B：受限Runtime与单请求边界

[受限出口](owner-runtime-isolation.md)：同库冻结资料、权威Owner解析、Worker/Orchestrator/AI SDK早分流，零工具/MCP/Skills/history/role/dynamic/title/steering/压缩，SDK内外retry0、输出4096；真实三协议body/解密凭据校验＋同事务唯一admission，未知发送不补跑。独立只读审查指出自动redirect P1，已强制error并用本地307/308验证目标0访问；未报告用量另保存Owner null证据，不拿兼容0当费用。两子会话均wait收敛。555隔离文件失败0、全typecheck/lint1991/docs/diff/fullbuild含两nativehelpers通过，真实Provider/外部skip不算PASS。Electron0.12.117/shared0.2.31；A禁启动仍保留，C回执/提案/费用UI未完成，不记AO-03/04整体完成，不宣称Owner自治或实际收费许可/硬金额上限。本片尚无Native schema验收，不安装/push/merge。

### 2026-10-09 Owner规划C：Run证据、待审提案与准备界面

[Run与受控准备](owner-planning-runs.md)接Owner职责/真实载体绑定与暂停准备UI、typed IPC/Jotai、完整资料/费用预检、不可覆盖回执、generated待审提案或必要澄清、双CAS、Owner专用完成/停止/心跳隔离。未知token/费用不拿兼容0估算，生成不完成业务任务或写员工学习；停止意图在abort前持久化，坏来源回调先隔离保全后stale，晚到不续跑。审查删除证据P1与吞来源错误P2已修复，关联Owner准备/Run的项目/承载/目标任务拒绝物理删除。A启动禁令继续保留，不把readonly预检或fake占位当生产费用许可。

本轮原生runId `6422d725-0233-4401-ba3d-13a654da35bd`验证Electron39.8.10/ABI140、真实better-sqlite3/SQLite3.53.4/WAL、实际产品preload及源UI的30次Owner IPC；覆盖旧A加列迁移、首次无Plan准备、费用UI+A拒绝启动0HTTP、显式fake callback生成/人工确认/澄清、receipt先提交+生成事务ABORT、重开与小窗无横向溢出。harness host/Runtime明确替身，不证明D真实start→Worker→SDK链、生产导航、打包/真实收费或进程终止。Electron0.12.118/shared0.2.32；最终工程门禁/独立复审仍待本片收束，无push/merge/安装。AO-02/03/04不记整体完成，AO-G0～G3未通过。

C收束：最新静态树559个逐文件测试失败0，全包typecheck、lint2000、docs:check、diff及完整build（renderer/preload/resources/两原生helper）通过。独立复审已wait收敛：原P1/P2关闭；新增“只剩stop/callback/receipt/outcome证据可能降级”P2随后真RED→GREEN，权威store/来源/Worker/删除均识别全部残余execution证据，只用于负向限制，不授权发送。Worker6项/62断言、Run18项/69断言，并在内部生成入口独立拒绝stop意图复用旧回执。复审原报告保留，整改不改写旧结论；D完整实际费用确认→Worker→SDK离线闭环尚未验收，仍不开启动出口。

### D：受控启动全链收束（2026-10-09 GMT+8）

C之后将A常量启动禁令替换为严格当前Owner来源校验；明确费用ack/preview/scope/TTL、既有排队原子claim与最终body/凭据/单请求占位仍不可跳过。规划只追加待审提案或必要澄清，不派工、不满足业务DoD。停止意图必须在新会话/发送前独立拒绝；完整链RED复现并GREEN修复，已发送的费用/远端停止仍未知。

独立D审查与Native两个子会话均已`wait_for_delegations(mode=all)`收敛，续轮再wait all。审查P2“真实准入后空request_hash仍生成”已修复：占位增加全部列本地integrity SHA，坏摘要/时间/legacy NULL先隔离callback，不生成或补发；旧schema additive ALTER，旧行NULL不补造发送证明。本地SHA不是签名。复审42项260断言及独立3项17断言通过，原P2关闭、无确认剩余实质P0/P1/P2；旧报告不覆写。

真实产品fee assert/claim→Worker→Orchestrator→AISDKAdapter/真实SDK→内存transport→Run/Plan BDD **12项112断言**（Bun sql.js）通过，包含必要澄清、未知usage、并发双击、TTL/scope损坏0请求、网络/断流/length/302不重发、停止generation、失联late、重开，以及五类准入损坏。全量逐文件 **560文件失败0**，全包typecheck、lint2001、docs:check、diff与完整build（含renderer/preload/resources/原生helpers）通过。

最新Native D runId **642c8bd7-1eaa-4784-b08a-14b8022f23da**，Electron39.8.10/ABI140、better-sqlite3/SQLite3.53.4 WAL、真实产品UI/生产preload/Owner IPC、实际费用确认/原子claim/Worker/Orchestrator/Adapter/SDK，未SQL伪造授权/admission。proposal与clarification各1请求；五类真实准入后故障各1请求并stale，raw callback重开持久、0完整receipt/outcome/新Plan；7条真实准入行旧schema迁移后其余列不变、integrity NULL；共7个内存HTTP，4096/no-tools、重复preview不补发、外部联网0、cleanup成功、360px无横溢出。Source hash父核验无差异。证据在会话`owner-planning-full-native-validation/runs/<runId>/`，保留每轮原文、15项哈希、SDK版本、截图及复跑脚本。仅host桥接与最终transport替身，不宣称完整生产导航、安装包、真实Provider费用/Provider请求ID、金额硬封顶、远端停止、断电/多进程或自主业务闭环。

本批准方案A/B/C/D本地研发与离线验收完成；真实Provider另须逐次费用授权，自动组织员工/后台自主推进/业务自动验收不在此批准切片内。Electron0.12.119/shared0.2.32。没有push/merge/安装，生产员工/配置及installed0.12.109/main0.12.113未改变。详细契约见`owner-planning-controlled-start.md`。

### 2026-10-09 AO-05首片：暂停执行授权准备收束

用户要求“开始AO-05”，完整增量方案获批准后实施[暂停执行准备](owner-execution-preparation.md)。冻结confirmed计划revision/version、所选步骤依赖闭包、明确不同Executor/Reviewer、工作区/渠道/模型/Runtime、实际能力与有界Skill资源摘要、明确none或bound的规划载体provenance、显式知识来源元数据及拟议预算/次数/返工/期限。复用paused Pilot policy与同库追加式准备历史，typed四IPC/生产preload/Jotai/计划审阅内入口已接；历史只读，输入/晚到/冲突保护不缩水。状态始终pending_task_links，0业务Task/grant/command/execution/request/模型调用；不记AO-05整体完成。

独立审查三轮及Native三轮均wait all收敛，原报告和203项旧产物摘要保留。外层事务P1、只冻结SKILL.md/漏binding provenance两个P2，以及追加发现的SSH私钥basename P2和raw BEGIN/SAVEPOINT事务状态缺口均有真RED→GREEN回归。两个save均前置拒绝未提交事务；Native读取驱动真实inTransaction，sql.js在内存探测且active不export；JSON故障保留未应用证据，残余用途拒绝legacy发行/预算/启动/请求。Skill脚本/规则变更与Owner绑定变更使旧preview/current失效，私钥与symlink/超限资源不读取、不保存。最终独立复审未确认剩余可复现P0/P1/P2；并不认证任意SQL写权限攻击者。

本轮新增后台31项/126断言、Jotai16项/77断言、新UI5项/54断言；旧两个browser选择器冲突已通过明确修订字段名和具名fieldset/section修复，未改旧测试或删除内容。全量逐文件**565文件失败0**、全包typecheck、lint2012、docs生成/检查、diff及完整build（renderer/preload/resources/两原生helper）通过。

最终Native runId **a7eebe6b-4416-4d14-853c-7fceefd72096**，实际Electron39.8.10/ABI140、better-sqlite3 WAL、完整生产preload/真实四IPC/source React/Jotai UI，**36项**通过；确认/准备/保存/重开/old DB加表、purpose丢失、资料/配置漂移、JSON/DB故障、两种raw事务、私钥/symlink/大小限制、none/bound来源与360px均覆盖。父独立核对218个源码SHA无差异。证据在会话`owner-execution-preparation-native-validation/revision-20261009-1008/`；TEMP清理、生产工作区名单不变、0联网/模型HTTP/执行账本。Goal/Plan与人员为隔离人工fixture，宿主为harness，不是完整production main导航、安装包、真实Provider/active发行/费用/远端终止或断电/多进程验收。

Electron0.12.120/shared0.2.33，仅本地研发；没有push/merge/安装，生产员工/配置、installed0.12.109和main0.12.113未改变。下一步另审AO-06暂停权威任务及exact step关联，随后补所有执行/资料/请求来源门禁并重新审批AO-05真实许可发行。历史W09/W10/R02/R03/R04/G4及AO-G0～G3不因首片自动通过。

### 2026-10-09 AO-06首片：暂停权威任务与精确步骤关联收束

用户10:18要求继续AO-06并批准材料化命令契约。复用同paa.db权威Task/dep/activity，追加materialization/step-link及negative session-purpose，不新增授权/预算账本、不改Pilot JSON、不发TaskChange/外部同步。项目目标每step新顶层paused Task；单任务仅一步复用普通尚未执行target，preview显示人员/workspace/status/研发范围与清旧成员键，保内容/日期/priority。原AO05 whole目标hash自然stale，history/source不改，结果paused_materialized_needs_revalidation。

普通dispatch/IfIdle清队列前、enqueue/claim/Worker/Workflow/headless session/worktree/Runner、controlled费用确认、development范围/返工/direct交付、状态group裸迁移/草稿/subTask/依赖/cascade及四Runtime输入/最终请求均补negative-only purpose。部分marker/link/header/preparation/session/execution关联损坏不能退legacy，空session占位不圈无关队列，全部session execution而非LIMIT1。旧issuer不消费Owner关联；实际Task范围/资料/预算许可仍待新版来源门禁。

独立首次4P1/3P2、续轮空session误圈/原AO05丢失旧SourceGate降级、共享受限session的direct交付问题，均保存真实RED→GREEN后复审收束至已审范围无剩余可复现P0/P1/P2。内部builder仅本次staging单次scope，committed link不能复活取消/补造缺Task或edge。原报告和探针保留。最终材料化20/68、用途变更11/33、四IPC3/25、direct delivery9/34；Runtime/启动/Jotai/UI各片报告另列，不合计为真实Run。

最终全量逐文件575失败0，全包typecheck、lint2027、docs、diff与完整build含renderer/preload/resources/两原生helper通过。一次完整复跑曾在未改微信AES-CBC末块篡改单测随机失败，原日志保留`/tmp/ao06-tests-f03-full-unrelated-crypto-failure.log`；原文件单跑及下一完整575复跑通过，未修改无关加密模块，不宣称其随机断言已修复。

最终Native **438e18d3-fcfb-4a6d-bd6d-e2b1427324fc**：Electron39.8.10/ABI140/native WAL、生产preload/四IPC/source React/Jotai，45checks、8截图、342精确源码SHA父核对无差异，sourceSHA `cae4ea5f65e670d9eefb6856230befc6556b826f045563cc22bbf352ad1168dd`。0业务启动/SDK/ModelHTTP/费用request/实际grant/TaskChange/外发，TEMP清理、生产目录计数不变、旧203文件与36/44轮报告原件保留。曾生成的9条反向fixture账本最终8条实体（1因残余probe删除）均未启动，其中1completed是人工模拟终态，不是Run或业务成果。限定sourcePanel，不宣称完整生产main导航、真实Provider、硬金额封顶、断电/多进程或打包安装验收。

早期Runtime子测试首版Claude RED未前置SDK tripwire，触及SDK query入口，无Provider/费用回执，不能回溯保证当次zeroNetwork或费用为零；该次不计严格离线证据。后续RED/全部最终测试和Native均执行前装tripwire/内存transport，初始异常日志保留。没有批准真实Provider验收。Electron0.12.121/shared0.2.34仅本地，未push/merge/安装/生产修改；下一步新版Task/link来源与实际许可、资料/每请求门禁须另审，历史AO-G0～G3/G4及停止未知费用门禁不自动关闭。

### 2026-10-09 AO-06第二片：材料化后重新验证（v2准备来源）

用户"继续"后两项只读研究收敛并获批`plan/ao06-revalidation.md`。新表`project_owner_execution_revalidations`（additive）+新模块：v2来源实时重放v1 build+权威Task/dep/marker/link精确核验，冻结真实任务事实与上游双三元组（materialization+原AO05）；planFingerprint/contextFingerprint须等于v1冻结值，budget/expiresAt原样携带不顺延，过期拒绝预览。`PilotPolicy`新增可选`ownerExecutionRevalidation`引用（含materialization反查），v1引用逐字节保留；v2存在时v1重存前置拒绝。v2行绝不入旧表。

不误current闭环：v2存在→v1 view短路非current→v1材料化入口联动关闭；材料化view恒needs_revalidation+分支(b)核验v2引用/行/originalPreparation，悬空显式stale；v2 get current须重建hash全等+引用精确+上游反查。view含unapplied（DB提交但policy未一致应用，重放显式拒绝与v1同构）与悬空stale。证据谓词纳入v2表；发行确认指纹纳入v2引用；deleteProject保护v2表。所有旧SourceGate/负向谓词语义一行未改，v2不引入新任务身份，不误封无关任务。

独立审查2P1（v1重存丢v2引用、幂等重放未核policy应用）+5P2全部整改并复核收束（复核记录`S/ao06-revalidation-security-review-followup-verification.md`），无新repro问题；一个无效unapplied测试被审查指出后重写为真实部分失败路径（回退JSON→unapplied+重放拒绝+证据保留）。最终后台10test38assert、UI/IPC/preload 17test、旧回归（材料化/pilot/file-failure等）全过；全量579隔离文件0失败、typecheck/lint(2035)/docs/build通过。Electron0.12.122/shared0.2.35仅本地。

v2 current仍非执行许可：发行/派工/资料工具/预算purpose/claim/Runner全关。实际许可发行、资料fence、逐请求Owner来源门禁、AO-06白名单调度与依赖推进、singleTask多step拆分/supersedes、真实Provider均需另审。Native验收见后续条目。

### 2026-10-09 AO-06第二片Native验收与UI修复收束

Native两轮：首轮 **6ca90c0a-a809-4c20-a0bb-886ab6d2da4a** 12/12（含singleTask单步、v1替代blocker、悬空fail-closed、SourceGate仍拒、tripwire全零、8截图），报告发现F1（产品面板缺changeReason输入，按钮恒禁用，harness经真实editOwnerRevalidationAtom桥驱动）/F2（历史仅挂载时加载）/F3（v1替代文案在折叠诊断内）。父随后修复F1/F2：面板新增"重验证修订原因（必填）"textarea（editOwnerRevalidationAtom接线，编辑废preview换requestId）与保存后自动重读v2历史；F3留待后续。委派通道超时后由父执行既有rerun.ts完成最终delta run **5ccf97ba-471e-4b7d-aaeb-4bb39c494e99**：12/12重跑通过、tripwire全零（network空/sdk/model/businessRuns/childProcesses=0）、346个源文件SHA与当前树逐一核对0差异（sourceSHA a21fcccc…f36e8绑定；旧run 3617e8d5…4a51保留）。注意：delta run复用旧harness，其boundary文本仍列F1/F2为未修复（复制时点旧文案），以本条目与代码为准；纯产品textarea点击链未单独脚本化（panel/atoms单元测试覆盖接线语义），记为边界。materialization/revalidation行数与TEMP清理、生产目录不变由evidence记录。

独立审查2P1+5P2整改后复核收束（`S/ao06-revalidation-security-review-followup-verification.md`）。最终：后台10test38assert、IPC3、atoms10、panel4，全量579隔离文件0失败、typecheck/lint(2035)/docs/build通过；Electron0.12.122/shared0.2.35。v2 current仍非执行许可；实际许可发行、资料fence、逐请求来源门禁、AO-06白名单调度/依赖推进、singleTask多step拆分/supersedes、真实Provider均需另审。未push/merge/install/生产修改。

### 2026-10-09 AO-06第三片：执行侧门禁能力（休眠）收束

用户"先推送再继续"：17提交已推送origin（6808fda9..2b8a6f16），随后两项执行侧门禁研究收敛并获批`plan/ao06-execution-gates.md`。交付休眠能力：资料工具fence（purpose感知谓词`assertToolAllowedForSessionPurpose`替换orchestrator canUseTool首行/ai-sdk tool.execute+canUseTool/pi-agent-adapter canUseTool包装；权威链session→execution→marker→材料化→v2 current→policy引用→gate准入行；三层交集+准入内容快照指纹+读审计行无正文；MCP资源恒拒；Plan模式不旁路）；`admitOwnerExecutionGateSession`仅供未来claim链+测试（外层事务拒/幂等/换execution拒）；逐请求Owner分支进`reservePilotRequest`事务（SELECT补purpose列、白名单式controlled_task早退/unknown抛/owner走全链，7旧guard先行不可达）；purpose列additive迁移（pilot_runtime_grants/pilot_commands默认controlled_task+owner_source×2，reservations经join派生）；R1防御（pilotGrantMatchesPolicy拒仅v2畸形policy）；gates对重依赖懒加载（无Owner证据会话依赖图零影响）。无任何生产gate创建路径，不发行不派工不调用模型。

独立审查3P1（reserve分支死代码、Read schema documentId错配+错误DB查询、Pi fence缺失）全部整改并复核收束（`S/ao06-execution-gates-security-review-followup-verification.md`）：documentId→索引库getDocument解析真实source、purpose白名单fail-closed、pi canUseTool双断言；Pi `beforeToolCall`工具入口硬拒保留（fence今天在Pi不可达，激活前置条件已写入docs）。P2处置：CHECK/redirect+boundary参数集/性能评估/快照排序稳定性登记为激活前置；gate行revalidation绑定补逐次核验；F-bundle-require（先存的打包形态createRequire失效，'project'资料scope生产解析为空，fence方向fail-closed）与F-readmission（漂移后无重准入恢复，fail-closed）记入docs。

最终gates 12test23assert、旧回归逐文件全过；全量580隔离文件0失败、typecheck/lint(2037)/docs/build通过。Native **b4f9defe-96d3-4ebd-b8a1-595b9a2eac81** 18/18：Electron39.8.10/ABI140/native WAL/production preload/真实UI，349源SHA与最终树一致（5ee7dfa6…ab9c2），tripwire全零、账本归零、gate行仅TEMP产物、360px截图、rerun脚本；早期中间态run目录诚实保留。Electron0.12.123/shared0.2.36仅本地，未push/merge/install。

未来发行片（另审另批）才实现：新命令账本与boundary idle扩展、独立启动/claim豁免收敛、runner/回执、owner逐请求fetch工厂、stop/恢复对称扫描、四确认序列、Pi beforeToolCall切换与激活前置清单。真实费用/远端停止/断电多进程/完整导航/安装仍未验证。

### 2026-10-09 AO-06第四片Stage A：Owner执行授权账本与发行确认收束

用户17:09"推送并且开始未来发行片"：推送21c5bab7至origin后，聚焦研究获批并实施[发行Stage A](owner-execution-grant.md)。独立新表`project_owner_execution_grants`（purpose单值CHECK、状态机active/paused可达+needs_reconcile枚举预留、上游双三元组+policy revision冻结引用、budget原样复制不顺延、partial active唯一索引）+撤权决策表；发行指纹以v2 integrityHash为根+sourceHash+budget+绑定身份（无时间戳/无命令摘要，grant冻结"谁可以在什么预算边界内消费"非"跑哪条命令"）。发行四前置（v2 current/idle/期限/员工启用）+confirm live policy CAS+active幂等input_hash+三重指纹全等+partial UNIQUE兜底；撤权两阶段CAS+决策行+paused无复活+撤权后重验证恢复（发行→撤权→重验证→再发行循环，研究确定性grantId契约作废、改随机后缀，已登记Stage B决策点）。boundary idle扩第5路（active/needs_reconcile阻断新发行与新重验证preview）；证据谓词第7路（grants任意state兜底）。policy JSON零写入；旧七处AO05 guard/16入口一行不改；pilot账本无owner purpose行。

独立审查2P1（confirm缺live policy CAS——探针伪造live+5落行被实证、第7路缺失——此前编辑断言中断未落盘）整改后复核收束（S/ao06-issuance-security-review-followup.md）。发行模块11test34assert、UI/IPC 24test（三层RED→GREEN）；全量584隔离文件0失败、typecheck/lint(2045)/docs/build通过。Native **run e950bbbc** 16/16：Electron39.8.10/native WAL/production preload/六IPC/撤权循环/并发双confirm UNIQUE兜底/五族病态删除第7路兜底/重开持久，357源SHA绑定、tripwire全零、TEMP清理、生产目录不变。已知记录F-expiry-order（fail-closed可接受）。

Stage A授权行无消费路径：0命令/0执行/0会话/0请求/0 Provider/0派工。Stage B（另审另批）：命令表+reserve/queue/claim/handoff/逐请求/结算/stop/恢复/豁免收敛/Pi切换。Electron0.12.124/shared0.2.37仅本地（推送等用户指示）；main0.12.113与installed0.12.109未变；真实费用/远端停止/断电多进程未验证。

### 2026-10-09 AO-06第四片Stage B：Owner命令执行链实现收束

用户18:38"继续"后聚焦研究获批并实施[Stage B](owner-execution-grant.md)。命令表DDL镜像pilot_commands+owner化三处（source_version锚materialization.revision/source_hash复合锚[taskSpecHash+linkIntegrityHash+依赖边]/ack_fingerprint NOT NULL）；第3确认per-command ack两阶段无库态RPC（镜像acknowledgeModelCosts，ackFingerprint进reserve事务全等重算不可预签）；reserve/queue同事务（先命令行后execution+owner_command_id回写）；单点豁免函数`readVerifiableOwnerCommandLink`（R7三处同步：hasOwnerBusinessExecutionEvidence首行/createAgentExecution条件化+ownerCommandId全等校验/preserve自动收敛）；claim单事务双CAS+attempts行；独立start不经tryStartExecution+heartbeat显式`if(execution.ownerCommandId) continue`（R3）；逐请求五步工厂redirect:'error'+pilot休眠分支移除（gates保留改接owner command context）；结算五类证据+unknown四不变量+超预留双needs_reconcile+跨链重放键；stop escalation同事务撤权+open拒非unknown+无自动消解；恢复对称扫描`owner_command_id IS NOT NULL`三态start boundary（R5）；boundary idle追加commands+escalations两路+证据谓词第8路；Pi/AI SDK出口切换与五键参数比对集留待真实Provider接入时接线（Stage B激活前置）。

六表DDL+agent_executions owner_command_id列+grant_decisions重建（CHECK扩展'reconcile'，数据保留）；批量集成测试6test24assert（ack→reserve/queue→豁免收敛→claim/handoff/回执→settle五类+双needs_reconcile→stop/unknown保全→恢复扫描→legacy不误封）；全量585隔离文件0失败、typecheck/lint(2051)/docs/build通过。已知缺陷：needs_reconcile枚举不可达assert由Stage B枚举首次写路径补齐；taskDependency序列化字段、ai-sdk-runtime-core ownerBudget透传、grant_decisions重建迁移RB-4为三处留待实现前再核的细节。Electron0.12.125/shared0.2.38仅本地。

**Native与独立审查**：首次 harness 矩阵3–6、8失败已作为调试历史保留；后续由父Agent使用隔离fixture补跑完整矩阵，结果见下方追补。首轮独立审查委派未收敛，随后两轮只读复审完成；不能将早期失败状态当作最终状态，也不能把模块测试等同生产Runtime接线。

真实Provider/费用/请求ID/远端停止/断电多进程仍不在范围。基线提交Electron0.12.125/shared0.2.38；后续安全修复提升Electron patch至0.12.126，当前提交/分支状态见下方追补。

### 2026-10-09 AO-06 Stage B 安全追补与最终验证（生产执行仍阻塞）

截至23:36 GMT+8，HEAD `3dfe5ce4`，远端基线`21c5bab7`，分支`feat/ai-project-owner` ahead 4；未推送/合并/安装。本次台账更新后有两份文档改动尚未提交。安全修复提交：`b8c55f49`、`3dfe5ce4`。Electron版本0.12.126。两轮独立只读复审：第一轮发现Owner heartbeat进入普通生命周期、逐请求预算不累计、启动回执绑定/员工配置复核不足及生产dispatcher缺失；已修复前述安全问题。第二轮确认主要修复有效，并指出handoff session绑定、receipt时间顺序两个P2；父Agent已修复并新增测试，最后两项未由子Agent再复审。父Agent另补齐漏调better-sqlite3事务回调的问题。

修复包括：Owner命令在普通`tryStartExecution` fail-closed；heartbeat走unknown恢复；request reserve在事务内累计预算并在fake fetch前拒超；claim重验员工配置快照；handoff与receipt按command/execution/attempt/project/session及时间序列核对。Stage B专项9 tests/35 assertions通过；全量585隔离测试文件0失败，typecheck、Biome lint（2051 files）、docs:check与完整build通过。

Native最终证据：Electron39.8.10/ABI140，8/8矩阵通过，359个源码SHA全匹配；网络/SDK/Model/业务Run tripwire为0，临时配置清理且生产配置目录计数不变。证据目录：`owner-stage-b-native-validation/run-2026-10-09T15-30-10-795Z-31b48e2f-e71b-49b8-82bd-a69d5f45b983/`。更完整复审记录见会话工作台`ao06-stageb-security-review-followup.md`与`ao06-stageb-completion.md`。

**当时未关闭阻塞（截至2026-10-09 23:36 GMT+8）：** `reserveAndQueueOwnerCommand`、`claimOwnerCommandStart`、`createOwnerRequestFetch`、`settleOwnerCommandUsage`及Owner stop API尚无生产dispatcher调用方。该状态由下一条2026-10-10 Native dispatcher追补更新；真实Provider、真实费用、Provider请求ID、远端停止证明及断电/多进程保证仍未验证且不在授权范围。

### 2026-10-10 AO-06 Stage B Native dispatcher追补（fake-only）

用户要求继续推进后，补做实际Electron原生运行验证。验证夹具在会话工作台独立目录`owner-stage-b-native-validation/dispatcher-harness-20261010-0719/`维护，不改产品源码；在实际Electron 39.8.10 / ABI 140、native better-sqlite3 WAL中，通过真实生产`project-owner-execution-dispatcher`与`startOwnerCommandExecution`创建会话并交接到headless runner，再经真实`controlled-provider-boundary`及Owner逐请求出口发送到内存fake transport。缺少独立启动确认被拒；确认后单次fake响应含usage，命令与请求均结算。严格价格证据匹配真实审核过的GLM模型名，但凭据、transport、响应均为fixture；无真实Provider、无真实费用。

最终Native runId **96d8caa0-668a-4a13-b88e-8c4b0a5efe25**，9项检查通过，新增矩阵直接覆盖dispatcher→原生会话/headless→fake最终请求出口→usage结算。bundle source manifest含`project-owner-execution-dispatcher.ts`；源码在构建前后哈希一致。tripwire网络/SDK/模型/业务Run/子进程均为0；临时配置已删除，生产`~/.gravitas/agent-workspaces`和`~/.proma/agent-workspaces`目录计数前后不变。证据目录：`owner-stage-b-native-validation/run-2026-10-09T23-22-44-428Z-7047b828-3273-42d4-98d2-690d9577a3ce/`。专项目标测试15/15（68断言）、IPC 3/3（26断言）及全包typecheck通过；IPC测试有Electron mock缺少`Menu.buildFromTemplate`的bootstrap警告，目标断言仍通过；`git diff --check`通过。

本Native验证仍为headless，无真实React命令面板点击/生产导航、实际SDK或Provider。Stage B不据此宣布全部验收：需独立安全复审覆盖新dispatcher与各失败边界；真实费用/请求ID/远端停止、安装包、断电及多进程保证未验证，且不得将fake usage结算称为真实费用验收。

### 2026-10-10 AO-06 Stage B 并发复审整改与复验

修复后独立只读复审发现：**重复并发dispatch的claim竞争失败可能把另一调用已启动的Owner执行恢复成stale/unknown并暂停授权**。`agent-employee-service.ts`现仅在本调用明确claim成功、随后gate admission失败时执行恢复；claim竞争失败不再恢复其他调用的running执行，普通错误写入也仅针对仍queued的当前Owner执行。新增并发双dispatch fake Runner测试，断言只启动一次、另一请求不误撤权，Stage B专项17/17（78断言）通过。

复验使用Electron39.8.10/ABI140、native better-sqlite3 WAL及fake-only dispatcher harness：runId **117ffb89-f8da-4943-af5d-fbe8723d04c2**，9项通过；含并发修复后真实生产dispatcher/headless启动、双确认拒绝/确认、fake transport usage结算与reviewer角色启动。网络、SDK、模型、业务Run、子进程tripwire均为0；临时配置清理、生产工作区计数不变。证据目录：`owner-stage-b-native-validation/run-2026-10-09T23-44-29-349Z-887d7b95-4b96-4007-80bf-a3cd1b09a8ee/`。此run绑定修复后源码SHA；先前run的哈希不覆盖该修复。

复验门禁：全量585隔离测试文件0失败、Biome lint 2053文件通过、全workspace typecheck、`docs:check`、`git diff --check`及`bun run build`通过。Native仍不覆盖React真实点击流与生产导航；独立审查指出IPC中的`acknowledgeExecution`是renderer传入的布尔值，面板二次确认能防普通误触，但不是抵御失陷renderer/XSS的安全边界。若未来把renderer妥协纳入威胁模型，需将确认提升到受信任主进程用户手势机制。当前未发现Renderer可指定员工/execution/预算字段。真实Provider/费用/请求ID/远端停止、安装包、断电与多进程仍未验证；不得以fake usage或Native harness宣称这些边界通过。

### 2026-10-10 AO-06 Stage B UI fake-only Native验收

在真实Electron Renderer挂载产品`ProjectOwnerExecutionCommandPanel`，使用生产preload、真实Owner IPC与native better-sqlite3 WAL；以React DOM控件事件执行任务选择、预览、费用勾选/排队、再单独勾选并点击“本次执行”。排队后runner和请求均为0；第二次确认后只启动一次，经fake Runner→真实受控请求出口→fake HTTP usage结算，UI显示`settled / completed`，command/request均结算4微美元（fixture核算，不是真实费用）。只触网tripwire为0，SDK/模型/业务Run/子进程为0；临时配置删除，生产工作区目录计数不变。Native结果runId **9310e86e-67bb-489a-ab83-128627b5dc52**，4项通过，bundle版本Electron0.12.128；源码SHA与bundle及截图见`owner-stage-b-native-validation/ui-harness-20261010/runs/9310e86e-67bb-489a-ab83-128627b5dc52/`。

验收期间发现并修复一个真实IPC缺陷：成功dispatch handler将Promise作为`value`包进同步`{ok:true}`，Electron IPC无法clone Promise，虽然主进程已启动，Renderer报错且无法正常刷新。`project-owner-execution-ipc.ts`的统一结果封装现await同步或异步operation并把异常规范化为可序列化错误；IPC专项3/3通过。Electron版本升为0.12.128。当前Native UI是实际React组件、生产preload/IPC，但由DOM控件事件驱动，未用物理鼠标/键盘，也未覆盖完整产品主窗口导航；真实Provider、真实费用、Provider请求ID、远端停止、打包安装、断电及跨进程保证仍未验证。

### 2026-10-10 AO-06 Autonomous Scheduling fake-only Native验收（增量，不代表AO-G*通过）

实现并接入默认关闭的`manual`/`autonomous` grant模式；历史grant仍为manual，模式进入grant审批指纹。自主grant确认摘要在主进程原生dialog服务路径生成；Scheduler仅在主进程内部消费自主命令，Renderer dispatch IPC明确拒绝autonomous命令。事件调度只监听Task权威更新、已提交项目链变更与命令结算，应用完成SQLite恢复后做一次启动扫描；project维度single-flight，命令键按grant/Task/link/role/source revision确定，SQLite唯一约束兜底。仅在current冻结来源、授权active、员工/Runtime/工作区/渠道/模型有效、预算未耗尽、无权威blockers时安排；单Task串行Executor→Reviewer，Reviewer成功不自动完成Task，依赖只在权威Task完成/handoff接受后解锁。任何执行/费用/停止未知均保留`needs_reconcile`和占额，不自动重试。

BDD专项覆盖Renderer人工ack/dispatch不能消费autonomous命令、主进程fake Scheduler单次派发、unknown后不重试、依赖阻塞直至`updateTask`权威完成。测试期间发现并修复命令/启动侧对Task依赖的冻结比对仅覆盖入边、与重验证快照收集的关联边集合不一致；现按同一权威边集合比较。定向Stage B/IPCs通过；`bun run typecheck`通过。

Native runId **c4fcf846-c9fe-42c7-ac4d-3a62033a5698**，Electron39.8.10/ABI140/native SQLite3.53.4 WAL，真实生产preload、实际React `ProjectOwnerExecutionCommandPanel`和主进程Scheduler事件生命周期；fake Runner+fake final transport两次调用，Executor/Reviewer各一条command与execution均settled/completed、fixture费用各4微美元，Task仍paused，调度状态waiting，网络/SDK/model/business Run/child-process tripwire为0；临时配置清理且生产工作区目录计数不变。Native三项检查与source/bundle SHA、运行回执见`owner-stage-b-native-validation/autonomous-harness-20261011/runs/c4fcf846-c9fe-42c7-ac4d-3a62033a5698/`。该Harness通过依赖注入的fake dialog adapter核验主进程授权摘要，不是OS原生dialog点击；用户物理确认、完整生产导航、依赖续派Native、真实Provider/费用、远端停止、安装包及断电/多进程未验证。此片不代表业务Task完成或产品Owner闭环，AO-G0～G3仍未通过。

### 2026-10-10 AO-06 自主授权IPC与依赖续派 fake-only Native复验

Native runId **97382472-6dfa-43f8-8f3f-4a89b6e117ad**（Electron39.8.10/ABI140/native SQLite3.53.4 WAL）通过生产preload在Renderer触发grant preview/confirm IPC，主进程grant handler经fake `dialog.showMessageBox` adapter先取消再确认（取消后grant行为0），随后生成autonomous grant。Harness构造两个冻结依赖Task：前置Task的Executor/Reviewer各结算后，下游Task仍无命令；销毁Renderer窗口后，通过权威`updateTask`完成前置Task，主进程Scheduler仍续派下游Executor/Reviewer；额外发出两个重复wake后账本仍仅4条命令/4次fake runner与transport调用。最终前置Task completed、下游Task仍paused，角色完成不冒充业务验收；fake usage累计16微美元（fixture计算，不是真实费用）。网络/SDK/model/business Run/child-process tripwire均为0；临时配置清理，生产工作区计数不变，Harness未改产品文件。证据目录`owner-stage-b-native-validation/autonomous-dependency-harness-20261010/runs/97382472-6dfa-43f8-8f3f-4a89b6e117ad/`；227个源码SHA均与当前树匹配（result sourceSHA `b0201a150efecdb97d69b307fa423ea0c99316be7740db668f99cfbb36b89e2c`）。确认使用fake dialog adapter，不是OS原生对话框或物理点击；无真实Provider、费用、远端停止、完整产品导航、安装包及断电/跨进程保证。此结果补足依赖释放后的Native续派证据，但不代表AO-06完整产品闭环或AO-G0～G3通过。

### 2026-10-11 AO-A06 固定构建验收与过期 unknown 账本归档

用户说明没有Provider账单后，未将旧unknown费用清零或释放占额；按获批计划，仅对两份已过期隔离run新增可审计的Owner grant `archived`终态。Run `d6378f68-b9b7-4c9d-a7e8-ac97dc0c1de3` 与 `e810032d-db91-42c9-9982-42e76ccbc61c` 的grant均为archived，每条关联command仍为 `needs_reconcile`、reserved `166667` 微美元、`actual_cost_micros=null`；无request reservation/start receipt，执行记录仍failed。每份数据库均经一致性备份及归档原语处理，前后integrity均为`ok`，全库核对未见非目标表数据变化；回执见各run目录 `ledger-archive-result.json`，原始验收回执与fixture manifest保持未改。Fake-only harness记录不等于Provider账单，实际费用仍unknown。

此归档维护片的代码版本为Electron0.12.131/shared0.2.40；全量586个测试文件失败0，typecheck、lint、docs:check、完整build通过。代码尚未commit，未push/merge/install。之前AO-A06修复提交`e2ecbbcb`及其Fake-only固定构建验收run `f90108c5-e0eb-4e7d-88fa-ad15e747ee41` 状态不变；本次归档不代表真实Provider/费用验收或AO-G0～G3通过。

### 2026-10-11 AO-02～AO-05 当前证据梳理（offline-only）

先前同步worktree核验基线为HEAD `b0558c30c300793927d473d99b7f29d96150b50c`、merge-base `e2ec78f2481497986aeba27be69960c38465fbd7`。本轮继续在独立`feat/owner-a02-a05-context-role`切片（HEAD `c56c182b6c6bc405b3948b52102ea20679a786ab`，无commit）实现并核验逐roleKey员工映射；此前AO-02源码矩阵仍为历史核验快照，新增映射证据见下文及[能力核验](capability-audit.md)。

`project-owner-execution-preparation.test.ts`新增BDD：两个项目的workspace、员工与知识源隔离，当前项目读取只返回显式项目绑定项，且无任务、grant、command、execution或request写入。定向执行 `bun test apps/electron/src/main/lib/project-owner-execution-preparation.test.ts` 结果28项通过、101断言通过（含新增用例），测试配置位于临时`PROMA_TEST_CONFIG_DIR`并由afterAll清理。该证据只覆盖候选范围隔离；AO-A04默认推荐/继承和冲突询问仍未实现/验收，因此AO-02、AO-03/04未整体关闭。

AO-05仍是进行中：暂停准备、AO-06准确Task/step关联、Stage A/B/Scheduler及两个过期unknown grant归档均有隔离实现/测试证据；本轮未触发生产grant、派发、Provider或真实目标数据库写入。两个归档command的费用unknown、166667微美元reservation及actual null不变；fake usage不是Provider账单。真实费用、Provider回执、预算硬封顶、远端停止、用户完整产品验收仍阻塞，AO-A05/AO-G0～G3不得标记通过。此前全量`bun run test`为637个测试文件失败0、全量`bun run typecheck`通过、`bun run lint`检查2143个文件无错误、`bun run docs:check`、`git diff --check`与完整`bun run build`通过；这是此前同步/归档验证，不等同本角色切片的全量门禁。

### 2026-10-11 AO-02 逐roleKey员工映射（Fake/隔离行为）

实现新增员工`roleTemplateId`稳定元数据与旧库nullable迁移；计划执行准备现在要求精确覆盖所有所选roleKey的员工绑定，server拒绝新准备缺映射/重复映射；唯一精确模板ID仅推荐，旧员工不按可编辑`role`文本推断。唯一当前项目workspace可推荐。映射贯穿每步paused Task assignee、v2重验证执行员工配置快照、grant审批指纹/展示、command ack员工与roleKey、command/AgentExecution实际agentId，以及Dispatcher/start前重验。修改员工配置或岗位模板身份后，来源变stale，不能沿用旧preview/grant command。

定向测试137项通过：准备29、材料化20、重验证11、grant issue 17、执行gates 12、Stage B 24、员工迁移2、Jotai准备输入18、员工模板表单4。测试均隔离临时配置；Stage B只使用loopback/Fake Provider与测试usage，不是真实Provider账单/费用。全workspace`bun run typecheck`通过；`bun run lint`检查2147个文件无错误；`bun run docs:check`与`git diff --check`通过。全量测试、完整build待本切片收尾；生产授权、真实Provider/费用、AO-A06物理原生确认与用户端到端仍未验证。原工作树`feat/ai-project-owner`保留既有WIP；本切片只在独立worktree，未commit/push/merge/install。

## 2026-10-11 Owner fetch前拒绝的人工对账实现增量（隔离验证）

为已存在的Owner真实运行在AI SDK本地模型构造阶段、Provider `fetch`前被价格协议检查拒绝，新增严格对账路径：主进程持久化类型化预发送拒绝证据；允许的候选先做只读指纹预览，Renderer要求用户核对Provider控制台无请求/用量并显式确认；确认在SQLite事务内重验账本，追加独立不可变本地审计、释放该命令预留并置command `released`/actual cost 0、保留usage回执字段null、将旧grant置`paused`。历史Zhipu拒绝只按受限规则显示。未知请求、request reservation非零、未解决停止升级、账本变化均拒绝；不发送Provider请求、不自动重试、不恢复旧grant。

验证：`project-owner-execution-stage-b.test.ts` 28/28（142断言）、`project-owner-execution-ipc.test.ts` 3/3（36断言）、对账UI 2/2（8断言）、全workspace typecheck通过。IPC测试虽有Electron mock缺少`Menu.buildFromTemplate`的启动降级日志，目标断言均通过。真实BigModel/Zhipu命令`302e37b9-635c-4afb-9503-001bbf3d2dc3`未在本轮产品UI确认；真实账本仍为`needs_reconcile`、reserved 500000微美元、actual cost null。完整全量测试/lint/docs/build尚待本切片门禁，AO-G0～G3及生产零费用证明均未通过。

本切片最终门禁（2026-10-11）：全量`bun run test`为640个隔离测试文件失败0；全workspace typecheck通过；Biome检查2150个文件通过；`docs:check`、`git diff --check`和完整`bun run build`通过。首次docs:check发现生成摘要过期，运行既有`bun run docs:generate`更新`docs/generated/repository-facts.md`后通过。Build输出renderer大chunk建议但成功。代码与当前AO-02～05、过期grant归档WIP仍未提交；未推送/合并/安装。真实Owner command尚未由用户在产品UI完成对账确认，Provider出网关闭；账本保持needs_reconcile/reservation 500000/actual null。

### 2026-10-11 对账拒绝根因与Runtime unknown标记修复

用户在隔离Owner运行界面看到“Owner命令或授权不符合发送前失败对账条件”。只读检查该run数据库定位：command/grant均为`needs_reconcile`，预留500000微美元、actual null；逐请求账本为0、未解决停止升级为0；execution error精确匹配已知发送前拒绝。额外`usage_evidence`/`usage_record_key`只是Runtime终态unknown标记（`Runtime终态缺少完整逐请求用量结算`），不是Provider usage回执。初版对账条件要求两字段必须为NULL，误拒了此合法旧状态。

修复：只认可与当前execution/session/channel/model完全绑定的标准unknown标记及精确record key；混合、损坏或不匹配标记仍fail-closed。确认时先将原标记及record key哈希写入不可变对账审计，再清除command上旧unknown字段；预览说明该标记不是逐请求Provider用量。逐请求reservation仍须为0、终态错误仍须精确、用户仍须亲自核对Provider控制台并勾选。没有自动确认、重试或恢复grant。

验证：Stage B 30/30（150断言）、IPC 3/3（36断言）、UI 2/2（9断言）、typecheck、Biome 2150文件、docs:check、diff check、main/preload build通过。当前隔离run DB在此修复前仍为needs_reconcile/500000微美元reserved/actual null；还未由用户重新确认。没有真实Provider出网。

### 2026-10-12 00:02 GMT+8：用户确认发送前拒绝对账（隔离run本地账本）

用户在更新后的Owner界面点击确认。只读复核 `ao06-zhipu-live/runs/b8cb14a3-4376-483f-89f9-c6062848ecec/config/projects/paa.db`：目标command状态`released`、grant `paused`；命令历史字段仍保留reserved=`500000`微美元，actual=`0`；按授权占额口径，该grant有效run reservations与committed cost均为0。command上的Runtime unknown字段已清空，但不可变审计保留其evidence与record key的SHA-256；审计为`legacy_operator_attested`、reason `legacy_zhipu_protocol_mapping_before_fetch`、request reservation count 0、`provider_console_checked_no_usage=1`、actor `local-user`。没有Provider签名回执；“智谱无请求/用量”为用户核对声明，Agent未独立访问账单。此次仅更新该isolated run数据库，不触及`~/.gravitas`全局项目库；无重试或新Provider请求，外网闸门保持关闭。

### 2026-10-12 N1 Owner规划产品流增量（全量门禁通过）

在 `feat/owner-a02-a05-context-role` 的 `a444822e` 之后新增用户侧N1引导：Runtime面板依据显式Goal/Binding/Plan/Run状态展示下一步；必要澄清可逐题输入，推荐选项仅作提示。答案经过校验后只以带问题标签的约束行写进当前项目或单任务Goal的Jotai未保存草案；缺目标、目标冲突、未完整回答、单条超长或约束条数将超上限时拒绝。应用不调用Goal保存、规划准备、费用授权或执行入口；用户检查/编辑并手工保存新Goal版本后，旧准备失效，需重新准备并再次逐次确认费用。

定向回归：六个规划流程/澄清/Runtime/Goal/Plan/受控链测试文件共36项、197断言通过。新增项目与任务Goal隔离覆盖；受控fake-transport链通过澄清→人工保存新Goal→重新准备→拒绝未确认费用（请求仍为1）→显式确认后唯一第二次fake请求。传输为隔离fake，目标`example.invalid`，不是真实Provider调用/账单。本增量门禁：全量`bun run test` 643个隔离测试文件失败0；全workspace typecheck通过；Biome 2155文件无错误；`docs:check`、`git diff --check`和完整`bun run build`通过。docs:check首次因repository-facts过期失败，执行`bun run docs:generate`后复验通过；renderer大chunk warning存在但构建退出成功。无真实Provider出网，未改旧unknown账本，未提交/推送/合并/安装；AO-03/04及AO-G0～G3不因此整体完成。

### 2026-10-12 AO-02来源收敛切片审查修复

独立只读审查未发现carrier自动继承、来源回退、跨项目越界或静默冲突绕过；指出旧`carrierFingerprint`对整个员工对象做哈希，会将任务统计/耗时等运行态字段变化误作配置漂移。现为新Owner绑定增加可选的配置指纹，剔除任务计数、耗时、失败计数与更新时间；旧绑定仍按原指纹严格核验，不做静默迁移。执行准备构建来源时与Owner规划准备共用当前绑定核验函数。另一个“source新增字段导致旧v1准备stale”的审查疑虑，经与当前HEAD比对，该source字段在本切片前已存在，不属于本次变更。

修复后定向测试4个核心文件共68项/291断言通过（Runtime binding、execution preparation、Jotai state、Panel），其中新增运行统计变化不误报用例。全workspace typecheck通过，Biome全仓2155文件检查通过；最终全量`bun run test`为643个隔离测试文件失败0，`docs:check`、`git diff --check`与完整`bun run build`通过。build有renderer大chunk warning；docs事实摘要已同步。Electron/shared patch版本递增至0.13.6/0.2.53。变更尚未提交、push、merge或安装。无真实Provider请求或账本写入；AO-02整体、AO-03/04产品验收和AO-G0～G3仍未完成。

### 2026-10-12 AO-02～04 工程侧收尾（本地未提交）

本轮完成的工程切片：AO-02来源字段契约表已补入[能力核验](capability-audit.md)，明确项目/任务Goal、元信息、规划carrier、工作区、roleKey/roleTemplateId、channel/model/runtime、知识来源和指纹漂移的来源、推荐与冲突规则；代表性测试补跨项目执行工作区候选隔离及Carrier运行统计变化不误报漂移。仍未实现通用多源自动合并：唯一显式项目workspace/稳定岗位匹配只能作预填推荐；channel/model/runtime不得回退全局默认或最近使用值。

AO-03/04的隔离代表样例：非代码“新产品市场定位”fake-only流程覆盖Goal约束、必要受众澄清、答复人工保存新版本、旧准备失效、再次准备以及拒绝第二次未确认费用请求后，形成含依赖、成果、验收标准与风险的`proposed`计划。单任务代码样例覆盖精确task Goal与项目Goal隔离、Task主体版本绑定、提案状态以及业务Task不变。两条测试均由固定响应和`example.invalid`最终transport构成；没有真实Provider调用、账单或模型质量证明。代码规划器没有收到仓库正文，计划将实际文件定位明确列为待源码核验，因此AO-A02的“Owner自动定位真实代码”仍为能力阻塞，不记通过。

最终工程门禁：`bun run test` **643个隔离测试文件失败0**；workspace `bun run typecheck`通过；Biome `bun run lint`检查**2155个文件，无错误**；`bun run docs:generate`后`bun run docs:check`通过；`git diff --check`通过；完整`bun run build`通过（含renderer、main/preload及macOS native helpers）。Renderer仍有大chunk warning，不是构建失败。定向测试：规划受控流15项/142断言，Goal+Plan服务32项/175断言，Planning admission+Run 28项/128断言；AO-02核心准备/Jotai/UI 69项/295断言（含本轮carrier候选文案修复与前序本切片证据）。

独立只读复审已收敛：审查提出carrier可被显式选作执行/评审人员；这符合当前批准的“仅不自动推荐，显式选择由服务端核验”契约，不是强制身份隔离，本轮不扩大到禁止显式选择。另修复唯一模板候选仅为carrier时，提示文本与下拉选项相互矛盾的问题；新增SSR用例覆盖并通过。审查未发现其它P0/P1问题。用户手测指南见会话工作台 `ao02-04-product-test-guide.md`，其中明确载体显式选择语义。代码尚未提交、push、merge或安装；用户仍需在该worktree开发版对临时项目做产品界面验收。建议只走保存/来源显示/准备与拒绝路径，准备会创建暂停承载任务；不得点击真实规划费用确认/执行授权。AO-02～04整体产品验收、固定构建导航与AO-G0～G3仍未通过；真实Provider/账单/费用硬上限/远端停止亦未验证。

### 2026-10-13：AO-07异常覆盖对账

Stage B及技术评审测试对照已证明覆盖预算/次数耗尽、blocked/无效或缺失回执、回执不可覆盖/跨项目身份拒绝、回滚/重开、依赖+返工成功路径，以及来源漂移、返工unknown和停止升级。新增错误返工轮次与Executor错配fake-only反例；Stage B **49/49、265断言**，技术评审解析**4/4、8断言**，新增测试Biome通过。只改测试，没有修改产品运行实现或触碰用户账本；没有Provider请求。过程、证据映射和限制见[AO-07异常覆盖对账](ao07-exception-coverage-audit-20261013.md)。真实进程重启/晚到回调组合、Native全异常矩阵、真实Provider/业务验收及AO-G0～G3仍未通过。

### 2026-10-13：fake-only隔离进程恢复与晚到回调补验

新增Stage B BDD：父Bun测试进程挂起fake headless Executor完成回调并关闭隔离SQLite；独立Bun测试子进程执行应用启动恢复服务并持久化running→stale/unknown；父进程重开后释放旧fake回调。恢复前后均确认command `needs_reconcile`、actual费用unknown、reservation保留、grant paused；晚到回调不写回Execution结果、不产生技术评审或新命令。Stage B **50/50、280断言**，技术评审解析**4/4、8断言**，全workspace typecheck、Biome变更文件检查、docs:check和`git diff --check`通过。

初始普通`bun -e`子进程缺少测试环境Electron mock而失败，切换为隔离Bun测试runner后通过，属于测试启动方法而非产品缺陷。只改测试与证据文档，未改产品运行实现、Provider账本或旧unknown reservation；未读取凭据、未发真实请求。该验证仅是两个Bun测试进程共用隔离SQLite的服务契约，不是Electron GUI崩溃重启、断电、native WAL、多进程并发或真实Runtime保证。AO-07完整异常矩阵、真实Provider/业务验收与AO-G0～G3仍未通过。详见[异常覆盖对账](ao07-exception-coverage-audit-20261013.md)。

### 2026-10-13：重复恢复扫描与重复晚到回调幂等补验

将恢复用例扩展为：独立子进程首次恢复将执行置为`stale/unknown`后，再次扫描同一execution返回空；父进程打开同一隔离SQLite后，对同一挂起fake `onComplete`闭包连续调用两次。两次回调后仍保持stale、无result summary、命令`needs_reconcile`且actual费用unknown、reservation不变、grant paused、无技术评审、command总数1。Stage B **50/50、281断言**；技术评审解析**4/4、8断言**；workspace typecheck、Biome变更文件、docs:check、git diff check均通过。无产品运行代码改动、Provider调用、凭据读取或真实账本变更。证据与边界见[AO-07异常覆盖对账](ao07-exception-coverage-audit-20261013.md)及[验证checkpoint第15节](validation-checkpoint-20261012.md)。该测试证明隔离服务/存储幂等，不是Electron完整崩溃、GUI重启、native WAL或多进程并发证明；AO-07整体、真实业务/Provider及AO-G0～G3仍未通过。

### 2026-10-17 AO-07 与 AO-A11 整合工作树验证

在隔离整合工作树将 `feat/owner-a07-background-review` 的 AO-07 改动合入当前HEAD `4aeacb89`。内容冲突仅涉及版本字段和双边更新的文档；代码自动合并后复核了对应执行准备、执行源码、共享类型和Jotai/UI差异。Stage B 50项/281断言、技术评审4项/8断言通过；全量测试646个隔离测试文件失败0；全workspace typecheck、Biome 2160文件、`docs:check`、`git diff --check`、完整build通过。Build存在既有CJS `import.meta`、Browserslist过期和renderer chunk-size警告，退出码为0。Electron/shared版本递增到0.13.7/0.2.54。

AO-A11进程树修复在此整合树保留为未暂存改动；AO-07代码与文档作为独立整合切片进入本地 `codex/owner-a07-integrated` 分支。没有真实Provider请求、真实账单操作、用户工作区写入或UI验收；AO-07不整体通过，AO-A02固定构建走查依用户决定继续待验收。主开发工作树及其未提交AO-A02/A04改动没有被修改。
