# AO-G1 确定性验收追踪矩阵

日期：2026-10-17。按 Ledger 的 AO-A01～12 样例逐项映射当前工作树中的确定性BDD/隔离集成测试。测试文件在最近完整 `bun run test` 中执行（656个隔离文件、失败0；Provider/生产基础设施E2E依配置skip）；workspace typecheck通过。矩阵只说明当前可重复的代码行为，不把fake、schema、回执、模型自述或本地SQLite证据升级成真实产品/用户/Provider验收。

## AO-A01～12 映射

| 样例 | 确定性要求 | 当前测试证据 | 确定性覆盖结论 | 未由该证据证明/仍缺 |
|---|---|---|---|---|
| AO-A01 非代码目标到可评审计划 | 可只给目标；保存、规划、确认计划不要求代码仓库，且不产生任务/授权/执行 | `project-owner-planning.test.ts`非代码目标与结构化提案；`project-owner-goal-service.test.ts`目标隔离/版本；`project-owner-plan-service.test.ts`保存/确认零任务授权；`project-owner-planning-run.test.ts`澄清、proposal和终态；`project-owner-planning-provider.test.ts`协议payload | 规划与无授权边界有BDD | 非代码业务执行适配器、用户端到端和真实模型质量未验收 |
| AO-A02 单任务代码定位 | 显式源码授权、限定绑定工作区、证据行/摘要绑定，伪造/漂移/无命中不能形成失据计划 | `project-owner-code-locator.test.ts`凭据遮盖、符号链接/目录/容量边界；`project-owner-planning.test.ts`要求引用当次命中；`project-owner-planning-protocol.test.ts`验证引用；`project-owner-plan-service.test.ts`来源漂移；Renderer `ProjectOwnerGoalPanel.test.tsx`显式勾选说明 | 可重复的本地检索与来源契约覆盖 | 用户要求的固定构建走查待验收；真实任务修改/测试、真实Provider账单未做 |
| AO-A03 澄清与答复 | 缺信息时提出问题；旧/不完整/冲突答复不污染草案或触发重复请求；完整答复保存后受控续备 | `project-owner-planning-run.test.ts`needs_clarification与晚到结果；Renderer `project-owner-clarification-answers.test.ts`完整性/版本冲突/目标主体；`project-owner-clarification-continuation.test.ts`重复调用只建一次暂停准备且无模型请求 | 条件、版本和副作用边界有BDD | 是否“必要且不重复问”的模型判断质量和代表性用户交互未验收 |
| AO-A04 来源/岗位/配置推荐 | 只从当前项目显式来源推荐；映射、覆盖确认及漂移阻断 | `project-owner-execution-preparation.test.ts`跨项目候选隔离、roleKey覆盖、项目绑定与人工覆盖确认，并验证渠道/模型停用员工不进入候选；Renderer `ProjectOwnerExecutionPreparationPanel.test.tsx`显示无有效员工时的修复解释及roleKey/Reviewer配置冲突；`project-owner-tool-recommendations.test.ts`覆盖逐步骤词面候选/理由/无匹配；准备服务BDD覆盖候选冻结、重读及Skill漂移stale；`project-owner-runtime-binding.test.ts`载体配置指纹；`project-owner-execution-revalidation.test.ts`来源重验证；`project-owner-planning-protocol.test.ts`校验冲突问题至少两个冻结来源精确引用及无效来源拒绝；`project-owner-planning-run.test.ts`验证来源引用进入Run outcome；Renderer `ProjectOwnerRuntimePanel.test.tsx`展示来源引用且不替用户排序 | 来源/岗位/配置隔离与覆盖、推荐冻结/漂移、冲突引用校验/持久视图/用户可见解释均有确定性覆盖 | 词面匹配不证明语义适配或真实效果；引用校验不证明模型能发现所有实际冲突；没有一般来源优先级/自动合并；候选质量和用户验收仍缺 |
| AO-A05 计划、执行、费用授权分离 | 目标/计划确认不产生grant；暂停准备不派发；新执行需授权/预算/来源重验 | `project-owner-plan-service.test.ts`确认计划仍零任务/授权；`project-owner-execution-preparation.test.ts`零grant/command/request及旧入口拒绝；`project-owner-task-materialization.test.ts`准确任务/依赖且零Run/许可；`project-owner-execution-revalidation.test.ts`冻结v2；`project-owner-execution-grant-issue.test.ts`与Stage B覆盖签发/消费边界 | 主要确定性授权边界有覆盖 | 无真实费用/provider账单或产品授权验收；来源继承冲突仍见AO-A04 |
| AO-A06 任务材料化与自动推进 | 每个step准确建Task/link/依赖；确认后按依赖续派，不重复、不绕过旧入口 | `project-owner-task-materialization.test.ts`CAS/准确link/依赖/幂等；`project-owner-autonomous-approval.test.ts`取消不落授权/显式确认；`project-owner-execution-stage-b.test.ts`冻结角色、依赖blocker、串行执行/Reviewer/返工/重复唤醒 | fake-only服务、Renderer关闭后的主进程调度与隔离Native run有证据（Ledger run `97382472-6dfa-43f8-8f3f-4a89b6e117ad`） | 完整产品导航、物理原生确认点击和真实Provider验收未做 |
| AO-A07 技术评审与有限返工 | Reviewer逐标准、严格结构化；仅有效缺陷开启限次返工；技术通过不代表业务验收 | `project-owner-technical-review.test.ts`严格schema/未验证项拒绝approved；`project-owner-execution-stage-b.test.ts`返工轮次/预算/次数/未知失败矩阵 | 结构化评审、返工限额与Task验收隔离有BDD；Native run `91a5371c-df29-436e-9303-fb8cbeef60a8`覆盖两任务依赖与返工 | 真实交付质量、独立评审、用户验收未做 |
| AO-A08 Ask/答复/续跑 | 答复来源与Goal/Plan修订匹配；旧、重复或不完整答复不续跑 | `project-owner-planning-run.test.ts`澄清终态/重复/晚到回执；Renderer `project-owner-clarification-answers.test.ts`草案CAS；`project-owner-clarification-continuation.test.ts`仅保存后无费续备一次；planning source BDD验证冻结指纹 | 来源重验及受控续备有确定性覆盖 | 完整产品交互与用户对问题质量的验收、真实模型费用未做 |
| AO-A09 交付审阅与验收分离 | 只显示精确绑定的冻结标准、执行结果与结构化技术意见；不得将自述伪装为验证或业务验收 | Stage B“Owner命令与已冻结步骤”用例；Renderer `ProjectOwnerExecutionCommandPanel.test.tsx`只读材料分区及反馈；`ProjectOwnerPlanPanel.test.tsx`计划来源/版本 | 列表投影和视图文本边界有BDD | 未证明回报真实性、代码实际修改或验证结果；真实交付与用户业务验收未做 |
| AO-A10 修改意见与敏感动作审批 | 反馈精确绑定命令；差异说明授权影响；写回/外发逐次审批；拒绝无副作用且可审计 | `project-owner-delivery-feedback.test.ts`草案命令绑定；`project-owner-plan-service.test.ts`交付证据、逐criterion assessment持久化；`agent-permission-service.test.ts`拒绝白名单/逐次审批；`ai-sdk-runtime-core.test.ts`外发拒绝零调用/精确允许一次；Stage B审批账本/恢复；`ProjectOwnerExecutionCommandPanel.test.tsx`回看审批；`PermissionBanner.test.tsx`静态呈现；`PermissionBanner.browser.test.ts`Chromium连续拒绝/单次允许和队列出队 | 反馈到新计划、动作审批/审计、横幅组件呈现及模拟preload的真实浏览器交互、拒绝执行均有确定性BDD；native WAL强杀矩阵见AO-A12 | Chromium浏览器测试的IPC为替身，不证明Electron主进程审批回执/账本与真实动作端到端；固定包用户点击、真实外部接收方/写回和用户验收未做 |
| AO-A11 失败解释与收口 | unknown保留预算、不自动重试；只读建议与失败状态匹配 | Stage B `project-owner-execution-stage-b.test.ts`：`Reviewer已完成但输出非法`、`派发一次后状态未知`、`终态缺少usage`、`Runtime停止未证实`、`返工次数耗尽`、`费用耗尽`、`返工Executor未知`、`Reviewer存在未解决停止升级`；另覆盖Runtime unknown标记不完整、请求账本/停止升级阻止发送前释放、晚到回调与重扫幂等。Renderer `project-owner-recovery-guidance.test.ts`覆盖10种调度状态、费用/停止核对要点、授权级别unknown、`nextAction=none`及不可派发授权状态优先级；`development-validation-service.test.ts`覆盖研发验证进程树超时 | 已覆盖关键终态和续派阻断矩阵：运行未知、停止未知、请求/费用对账、非法Reviewer、预算/返工耗尽、晚回调、来源漂移；建议分别提示核验命令/逐请求预留/Provider用量/停止升级，未知时保留占额且无自动重试 | 只覆盖代码路径和隔离账本；真实远端停止/费用仍未证明。研发验证进程树测试不等价Owner停止；用户/固定构建验收另属G2/G3 |
| AO-A12 撤权/重启/重复/跨项目 | 旧执行不得复活或重放；unknown占额不释放；重复事件幂等；跨项目回执拒绝；项目/单任务Goal或计划出现新版本后旧授权不得续派 | Stage B覆盖撤权、claim竞争、重复唤醒、跨项目身份、恢复与晚回调；`project-owner-native-recovery.test.ts`在Node及Electron run-as-node/better-sqlite3下测试WAL崩溃与恢复事务前后强杀；项目Goal、task-scoped Goal及计划版本漂移阻断；旧revision自主Grant与人工单命令费用预览拒绝；撤权/停止升级→独立进程unknown恢复→pending审批失效→旧Runtime回调晚到；撤权后项目Goal及单任务Goal分别完成新准备→追加材料化→新v2重验证→新Grant链，断言新Task ID、旧Task/link/preparation/revalidation证据保留；当前定向复跑Stage B 59项/390断言 | 已证明旧Grant不续派且需先撤权/清空未决边界；两个主体粒度的新指纹计划均开启追加批次，新Task保持paused，旧Task映射及旧v2记录不变，随后需独立重验证/新Grant | 固定arm64包已覆盖待审批窗口强杀及重启后审批失效恢复；完整产品导航、独立迟到回调与恢复GUI同场、固定UI用户验收仍属AO-G2产品验收；真实Provider、账单和远端停止仍属AO-G3验收，不计入此确定性映射 |

## G1 判定

完整矩阵现逐项映射AO-A01～12适用的确定性约束；AO-A04来源冲突引用协议、AO-A10审批横幅浏览器交互、AO-A11运行故障与恢复终态、AO-A12撤权后新计划追加链均有对应BDD，当前656个隔离测试文件失败0，workspace typecheck通过。Provider/生产设施测试按环境配置skip，不计作通过。AO-A01/02/03/06/07/08/09/10/11/12中的真实模型判断、产品操作、业务结果、真实费用/停止部分属于G2/G3验收，不是确定性代码矩阵的替代品。按G1定义（适用确定性项有映射、全量既有门禁通过且不将unsupported证据冒充成功），**AO-G1确定性门禁通过**；这不代表AO-01～12整体完成，也不关闭AO-G0/G2/G3。固定构建用户验收与真实Provider分别保留在AO-G2/G3。

## 全量门禁证据

- `bun run test`：656个隔离测试文件，失败0；Provider/生产基础设施E2E按配置skip（2026-10-17 Ledger对应记录）。
- `bun run typecheck`：全workspace通过（本轮 AO-A11 修订后重跑）。
- `bun run lint`：Biome检查2181个文件通过（本轮）。
- 完整`bun run build`：Electron main/preload/renderer与原生辅助模块成功（本轮）；存在已知CJS `import.meta`、Browserslist数据过期及renderer大chunk警告。
- `bun run docs:check`、`git diff --check`通过（同记录及本轮文档更新后复验）。
- 完整Electron构建最近一次通过记录见AO-A10 2026-10-17“审批记录只读回看及最终门禁”；新增原生恢复与本矩阵仅改测试/文档，未重跑构建。

### 2026-10-17 AO-A12 Stage B 断言数复核

当时`project-owner-execution-stage-b.test.ts`定向复跑结果为58项通过、0失败、384断言；随后因新增撤权后项目/单任务Goal追加Task覆盖，当前独立复跑为59项/390断言。新增集成断言覆盖Owner命令运行态→AgentPermissionService发出待审批请求→实际IPC使用的权限响应helper逐次allow/deny→Owner动作审计SQLite状态及Renderer/session两路resolution事件，并核对拒绝时执行计数为0、允许时恰为1；矩阵沿用58/384作为权限集成BDD的历史基线；现行总数以59/390为准。Ledger较早的374及369断言记录保留为对应历史快照，不覆盖本次复跑结果。


### AO-A12 固定包重启恢复补充

2026-10-17以arm64固定包进行待审批Write卡片出现→测试进程强杀→同一profile重启走查。重启后窗口可用且无待审批卡片/renderer异常；SQLite审批为`invalidated/runtime_recovered`，execution=`stale`、grant=`paused`、command=`needs_reconcile`，费用未知且reservation保留；数据库完整性通过、合成文件未创建。此证据增强“恢复UI”列，但不证明独立Runtime迟到回调与恢复UI同时发生，也不替代真实产品用户验收。


### AO-A10/A12 Renderer待处理请求恢复

固定包首次Renderer reload复现待审批Owner动作卡片丢失；代码确认渲染监听器漏调已存在的`getPendingRequests()`。修复为订阅优先、快照合并、requestId去重及解决事件竞态过滤。修复后arm64固定包窗口reload恢复原审批，拒绝后主进程SQLite闭环完成且无文件副作用；完整656文件测试、typecheck、2181文件Biome、build与package smoke通过（详见Ledger当日条目）。这验证AO-A10实际Electron主进程审批与Renderer重载恢复的合成集成，不替代真实Provider/账单或用户验收。
