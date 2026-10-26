# AI Owner 测试与台账阶段收尾

初版截至：2026-10-12 17:53 GMT+8；18:09补充本轮确定性验证结果。以下第1～3节保留阶段复核历史，已补覆盖以第4节为准，不代表整体产品验收或新一轮全量测试。关联：[剩余工作复核](remaining-work-review-20261012.md) · [权威台账](ledger.md)。

## 1. AO-02～04 用户无费用手测

测试版：`feat/owner-a02-a05-context-role`现有隔离开发版；配置目录为会话工作台`ao02-04-product-test-config`。未使用当前AO-07 worktree替换该测试版。两worktree尚未集成。

| 检查 | 当前结果 | 证据与边界 |
|---|---|---|
| 新建临时非代码项目 | 通过 | 临时非代码项目，ID `16372609-32c3-4d64-a9c0-5c0247f15cef`；隔离SQLite只读核验 |
| 保存项目目标与完成标准 | 通过 | Goal v1→v2→v3→v4历史；最终目标“进行非编程目标测试”、标准“测试通过即完成目标” |
| 独立约束字段保存 | 通过 | Goal v4的constraints=`["不对外发布"]`，与acceptanceCriteria分开 |
| 离开项目、重开后保留 | 用户报告通过 | 用户按检查步骤报告done；数据库已持久化，Agent未独立观察窗口重开动作 |
| 项目与载体共同工作区配置 | 数据配置通过 | controlled AI SDK载体“需求分析师”、项目共同绑定托管“默认工作区”；非代码无Git要求 |
| 无费用准备 | 通过 | 规划link绑定Goal3/binding2/planRevision0；一个paused承载Task，owner_planning目的、最多1请求/4096输出token |
| 新目标不覆盖旧准备 | 数据证据通过 | 当前Goal4，旧link仍Goal3；旧paused Task保留，未自动新建准备或续跑 |
| 旧准备发送前拒绝 | 部分验证 | 当前源码要求goalRevision一致，已有工程回归；未在用户窗口发起旧准备启动，因此本次不记真实UI拒绝通过 |
| 无执行授权副作用 | 本地记录通过 | 17:51项目execution/grant/command和规划admission均0；不是独立Provider账单证明 |
| 真实业务规划/澄清质量 | 未验收 | 未调用真实模型；泛化测试目标只证明操作链，不证明业务提案质量 |
| 配置体验 | 缺口已确认 | 用户需要概览/工作空间来回跳；对话引导暂缓，不以更多注释宣称解决 |

本轮手测可以收束“保存—共同配置—无费用准备—修订保留历史”检查，不再要求用户重复执行同一组步骤。完整AO-02～04、AO-A01～04及AO-G2仍未通过；单任务隔离与业务样例主要有历史工程证据，不冒充当前用户手测。

## 2. AO-05～07 工程证据映射

以下按当前Stage B测试实际内容及此前已执行证据映射；本次仅读取测试清单，不把测试名称当成新增运行通过证明。此前AO-07完整门禁为645隔离文件失败0，详见台账。

| 场景 | 已有证据 | 当前缺项 |
|---|---|---|
| 授权与计划/准备分离 | 准备、材料化、grant、IPC等历史确定性/Native证据 | 统一固定产品构建中的用户授权全过程 |
| 自主与手动出口隔离 | Stage B自主grant拒绝Renderer人工ack/dispatch；普通Runtime拒绝缺Owner上下文 | 真实产品/Provider验收 |
| Executor→Reviewer串行 | Stage B fake链及Native记录 | 真实模型/费用质量 |
| 同轮退回一次、有限返工及复审 | Stage B ordinal链与Native `436fdd95-9cd4-4aa6-ad37-355ea38c25e9` | 两任务依赖+返工组合Native；全故障矩阵 |
| 依赖未解除不续派 | Stage B权威Task未完成阻断、完成后下游；历史两Task Native | AO-07返工场景与依赖组合补验 |
| 非法回执停等 | 严格解析4项、Stage B非法Reviewer输出停等 | blocked、缺回执、晚到/重复回调、跨项目/错ordinal等逐项独立映射与补验 |
| 运行次数耗尽 | Stage B maxRuns=2拒绝返工且不扩张预算 | Scheduler maxRework上限与费用耗尽专项组合测试；不能仅以请求预算耗尽替代 |
| 请求预算及超额 | Stage B请求预留耗尽拒绝、结算超额双needs_reconcile | Reviewer返工时预算不足的端到端专项 |
| unknown/停止状态 | Stage B缺usage、停止升级、后续回调unknown、重复wake不重试 | Reviewer/返工轮的组合故障与真实远端停止证明 |
| 来源漂移、恢复及幂等 | Stage B员工/Task变化拒绝、running恢复、失联扫描、并发dispatch竞争 | 回执持久化重开/外层事务回滚与晚到结果组合验证 |
| 技术评审与业务验收分离 | fake/Native Task保持paused；面板明确边界 | AO-09/10新业务交付版本及旧验收隔离，不由AO-07模型回执替代 |

独立审查“未发现可证明高风险问题”不是上述缺项已通过；fake结算金额也不是Provider账单。

## 3. 下一工程切片

优先补AO-07确定性验证缺项，而不是立即扩大配置UI或从零实现AO-11：

1. 冻结授权maxRework耗尽、Scheduler费用耗尽、blocked/缺回执的停等与不增派。
2. 评审证据重复/不同回执拒绝覆盖、错身份/跨项目拒绝，以及数据库重开/回滚边界。
3. 同一fake链组合“前置任务返工→复审通过→业务Task仍暂停→人工权威完成后只续派下游一次”。
4. 再用隔离Native补组合关键路径，来源hash与构建版本重新冻结；历史Native不能当新代码证据。

优先写BDD，失败后再做最小修复；若发现需要改变授权契约或扩大原批准AO-07范围，先提交计划确认。所有运行保持隔离、fake-only，生产库与旧unknown账本不改，不自动commit/push/merge/install。真实请求仍另行逐次授权。

对话式配置仍暂缓，AO-08交互实施前需与该方向复核复用；安全、来源与运行请求的版本约束不取消。

## 4. 18:09 GMT+8：本轮新增确定性测试结果

当前AO-07 worktree的Stage B新增8个BDD场景，复用隔离fixture。只改测试，不修改产品运行实现、授权契约或用户手测配置。fixture新增可选maxCostMicros，默认保留1000000；费用耗尽测试采用2微美元与4次授权、两次已知fake结算各1微美元，独立证明费用耗尽而不是次数耗尽。

| 新增场景 | 实际验证 |
|---|---|
| maxRework耗尽 | 一次返工后再次changes_requested；重复wake不queue/dispatch，命令保持4条，Task仍paused |
| 剩余次数但费用耗尽 | 仍有2次运行余量，但预算2微美元全部占用已结；不增额度/返工命令 |
| 合法blocked | 保留具体卡点并human_decision，不误作changes_requested/approved |
| Reviewer已结但无回执 | 不从resultSummary补造可信回执；两次wake不重试 |
| 回执身份与幂等 | 同回执重复记录仅一条；不同原文拒绝覆盖，跨项目execution/Executor command拒绝混配 |
| 外层事务回滚 | 回滚后无评审记录、Scheduler缺证据停等；正常重录同回执成功 |
| 两任务依赖+返工 | 前置技术复审approved仍paused且不续派；权威Task完成后下游可排队，重复排队复用同command/execution且总数5 |
| 数据库关闭重开 | 原回执完整读取，Task仍paused、await_business_acceptance；重录无新增记录 |

实际运行结果：Stage B **42/42，226断言**；严格回执解析 **4/4，8断言**；面板状态 **1/1，5断言**；全workspace typecheck通过；变更测试文件Biome通过。首次组合测试断言忽略了重复调用返回`alreadyQueued=true`，修正预期后通过；不属于产品代码缺陷。

日志保存在会话工作台`ao07-test-closeout-20261012/`。本轮没有重跑645文件全量测试、完整build或Native harness，不能把旧构建/Native结果冒充本轮结果。数据库重开为隔离Bun SQLite契约证明，不是Electron跨进程崩溃/断电或native WAL证明。组合测试人为将fixture Task完成以检验依赖，不证明真实业务验收、成果DoD或外部交接。尚待补验：关键组合Native、错返工轮次/来源漂移/unknown停止在返工链中的组合矩阵、真实Provider与用户业务验收；AO-A07与AO-G*仍未整体通过。

## 5. 18:14 GMT+8：两任务依赖＋返工Native组合验证

最终成功run：`91a5371c-df29-436e-9303-fb8cbeef60a8`，证据位于会话工作台`ao07-native-validation/dependency-rework-harness-20261012/runs/<runId>/`，包含冻结harness源文件、bundle/source hashes、`Native-ui-result.json`、`run-receipt.json`、前置依赖阻断/最终面板PNG及最终UI文本。

环境：Electron39.8.10/ABI140，native SQLite WAL，实际React Owner命令面板＋生产preload/IPC；产品包版本Electron0.13.5/shared0.2.52。此次独立harness重新构建并核验源文件和bundle hashes，未导入完整产品main。Runner和最终HTTP transport为fake，原生确认使用fake dialog adapter。

实际通过6项检查：

- 前置Executor(0)→Reviewer(0) changes_requested→Executor(1)→Reviewer(1) approved，4条命令已结。
- 前置Task仍paused，下游零命令，Scheduler等待权威依赖解除；技术通过不冒充业务完成。
- harness显式写入前置fixture Task为completed后，事件触发下游Executor(0)→Reviewer(0) approved；这是依赖条件注入，不是验证真实验收/DoD/交接。
- 共6次fake Runner/transport，每次fixture结算4微美元，账本累计24微美元；重复Scheduler唤醒不增加命令。
- 下游仍paused，最终waiting/await_business_acceptance。实际React面板轮询刷新到6/6、24微美元与“等待人工业务验收”，没有Renderer派发按钮。
- 网络尝试为空；SDK、模型、普通业务Runner和子进程拒绝桩实际计数均0。临时配置已清理，正式workspace目录数量运行前后不变。该边界不是对任意进程联网或生产数据全盘不变的系统级证明。

运行历史保持透明：首个run `3917f0cf-d9f1-494b-a3d2-e3f5db8d0dac`业务断言通过，但截图仍是下游派发前的轮询状态，因此补充最终UI等待断言；run `e540848d-85e6-4a19-bea0-3c73d743ca8b`因harness误用“等待业务验收”而产品实际文案为“等待人工业务验收”失败，原证据保留。修正harness后最终run全部通过，不把失败运行记为通过。

本轮未修改产品运行代码、用户手测版或旧unknown账本，未请求真实Provider、提交/合并/安装。此次补齐关键Native组合成功路径，不覆盖返工链全异常矩阵、跨进程竞态/断电、完整产品导航、物理原生确认、真实业务质量、Provider账单或远端停止；AO-A07/AO-G*整体状态不改为通过。

## 6. 18:16 GMT+8：返工链异常边界和工作树门禁

本轮新增3个Stage B fake-only场景：

1. 上一轮`changes_requested`后执行员工配置指纹漂移，重验证转stale，Scheduler不创建下一返工命令。
2. 返工Executor运行进入unknown，grant/command进入对账，未结费用预留仍在；重复Scheduler唤醒不启动Reviewer或重试。
3. 返工Reviewer存在open stop escalation，unknown终态保留、撤销活动grant、命令保持needs_reconcile；不补造评审证据，不自动恢复。

三项测试初始失败是断言误把状态详情文案/字段假设为固定值；根据实际契约调正断言后通过，**没有因这几项做产品代码修改**。最终Stage B **45/45，250断言**；strict review parser4/4、UI面板1/1；全workspace typecheck通过；Biome变更文件检查通过。

AO-07 worktree完整门禁：`bun run test` **645文件、失败0**；`bun run lint` Biome **2158文件通过**；`bun run build`通过（含 renderer、macOS Computer Use helper、Dynamic Island原生模块及资源复制）；`bun run typecheck`通过；`bun run docs:check`和`git diff --check`通过。Build仍有既存renderer大chunk >500KB警告，不是本轮回归失败。以上证明当前工作树自动化门禁，不证明打包安装、生产服务、Provider或业务验收。

## 7. 真实 Provider验收的前置状态与审批关口

此前AO-06隔离预检记录的用户费用授权是**当时特定run**最多人民币20元/1000次；其首轮计划最多2条Owner命令，基于GLM-5.3-Flash当前本地价格证据计算不超过约¥1.63，并采用每次1 turn/0 SDK retry/0 runtime retry、Owner grant `$1/2 runs`。但该预检运行在2026-10-11，当时隔离配置没有BigModel渠道；Provider egress gate关闭、未成功连接，用户后续在该旧隔离版保存的渠道状态与此AO-07分支并未集成。该历史授权不自动扩展到当前工作树、当前新run或新的请求批次，也不证明本地存有可用凭据。

因此当前没有发出真实Provider请求，也没有读取、复制或显示凭据，没有启动验证费用或账单。本工作树验证仍为fake-only。继续到真实验收前必须重新做**该版本专用隔离包/配置预检**，核对当前渠道存在性（只检查非敏感元数据）、safeStorage、模型与价格快照、请求次数/turn/retry/output token硬约束、请求前授权摘要、单独egress allowlist与关闭闸门状态；确认自动恢复不会重复消费，费用/usage未知严格保留占额。不能使用旧AO-02～04测试窗口或它的密钥代替。

预计需要先获得用户对“本次有限真实Provider验收”的明确确认：拟议起步上限**最多2条模型请求、最多1 turn/条、0自动重试、每条输出≤4096 token、总费用≤¥1.63且Owner grant≤$1/2 runs**；Provider侧最终费用/usage须逐请求可核验，否则停在unknown。该金额估算依据旧预检的标准价和“每条最多1M输入token+4096输出token”极保守算法，只是待复核假设，不是硬封顶或当前价格保证。出网前还需重核当日官方价及配置/路径，实现本机每请求出口硬限制和明确闸门，并再次由用户确认预算与具体发起动作。未经新确认不触发。

即使请求成功，也只证明该场景的真实调用链与回执；真实业务验收还要求人类评价输入目标、澄清与产物质量/真实性、验收标准及交付状态。当前用户临时目标“进行非编程目标测试”并不构成可评价业务成果；未确认合适的业务样例及预期产出前不应对真实Provider请求作业务成功判断。AO-G0～G3保持未通过。

## 8. 2026-10-13 13:09 CST：可选岗位预算与最终自动化门禁

本轮在AO-07未提交worktree实现用户已批准的可选岗位级USD微美元费用上限：共享预算仍为全局硬上限，岗位cap只收紧共享额度；每岗位需冻结稳定roleKey→员工映射；Executor与Reviewer调用费用都归入所属任务岗位；settled按实际费用、unknown按预留额持续占用。旧SQLite授权/命令账本通过默认空数组和可空岗位键兼容；存在岗位cap但活动旧命令没有岗位归属时拒绝继续。准备页可选择是否启用岗位cap，授权预览、命令预览和历史账本显示相应额度/归属。此实现只验证本地账本门禁，不宣称Provider侧硬停止。

回归覆盖岗位映射缺失、cap超共享预算/重复/未知岗位拒绝、授权发行/重开和指纹、共享与岗位额度并行、Reviewer费用归属、unknown岗位预留以及UI说明。岗位额度双场景 **2/2**；准备输入无效场景 **1/1**。unknown场景确认命令保留250,000微美元岗位占用并将grant置为`needs_reconcile`，新命令因授权状态不一致被阻断；这不证明人工对账后如何恢复授权。

最终自动化门禁：`bun run test` **645文件、失败0**；`bun run typecheck`全workspace通过；`bun run lint` Biome **2158文件通过**；`bun run build`通过（renderer、原生helper及资源复制）；`bun run docs:check`和`git diff --check`通过。renderer存在>500KB chunk警告。typecheck第一次发现测试中的非可选字段`delete`写法，改为显式`undefined`后通过；未修改业务代码以绕过检查。工作树仍未提交，本轮没有commit/push/merge/install，没有出网、Provider请求或读取凭据。AO-07全异常矩阵、真实Provider/业务验收及AO-G0～G3仍未通过；失败Run `de89e33f-3fb8-4b0a-af4c-41244b9674d8`及旧unknown账本状态不变。

## 9. 2026-10-13 13:22 GMT+8：同一角色轮次重复消费防护

继续对账AO-07手动命令路径时发现，调用方可用新的幂等键，对同一授权、任务、步骤、角色和返工轮次再次排队，重复消耗额度；此前autonomous调度有自身幂等键，但manual入口缺少角色轮次层级防重。新增fake-only BDD先复现缺陷，再在命令预留事务内增加冲突检查：该tuple已有非`released`命令即拒绝新消费；相同幂等键的原queued重放仍保留既有幂等路径；已明确对账释放的命令不阻止新的、重新确认的操作。拒绝发生在插入新命令/execution之前。新增测试同时验证Executor与Reviewer重用不同幂等键均不能再次消费，账本命令数不增加。

验证：AO-07 Stage B **48/48、263断言**；执行门禁 **12/12**；全workspace typecheck、Biome2158文件、完整build、docs检查与diff检查通过；全仓 **645测试文件、失败0**。Stage B第一次运行仅因一条旧预算结算测试故意重复同一角色轮次而失败；将其第二笔结算改为同授权下另一独立任务后通过，保留原“超额结算→needs_reconcile”覆盖意图。Build继续显示renderer chunk >500KB警告。

这次仍是隔离数据库/fake证据，不证明并发多进程/真实Provider行为；没有出网、真实请求、读取凭据、安装或提交。须由用户接手的事项仍是隔离产品UI手测与真实业务样例/Provider逐次授权；未将其自动化或冒充通过。

## 10. 2026-10-13 13:56 GMT+8：最新 AO-07 独立 arm64 测试包

应用户要求，基于已通过完整build的当前worktree生成独立macOS arm64 ZIP，Gravitas 0.13.5 / Electron 39.8.10，Bundle ID=`com.gravitas.ao07.rolebudget.test20261013`。ZIP：会话工作台`ao07-role-budget-test-20261013/package-correct/Gravitas AO07 Role Budget Test-0.13.5-arm64.zip`，285,540,872 bytes，SHA-256=`db04d268f40e6723aa71928f3d4d5b8a39fda751492bd7e54cd3f6e2acda740c`。独立配置`electron-builder.yml`位于同目录；构建参数显式`--publish never`，输出到全新`package-correct/`。校验Info.plist的Bundle ID/版本、asar中的`dist/main.cjs`、默认Skill资源及启动脚本语法通过。

随包提供`Launch AO07 isolated test.command`与`README-test.md`。启动器通过`PROMA_TEST_CONFIG_DIR`和Electron `--user-data-dir`隔离 Gravitas 配置与Electron数据，首次运行会解压到独立`running/`目录；不写入`~/.gravitas`，不触碰已安装Gravitas/Proma。该配置为空白，手测应不录入凭据且只做“排队、不启动”，不产生Provider请求。应用包未安装、未启动、未公证/签名验证；属于本机测试包，不是发行构建。

第一次从monorepo根调用electron-builder，工具按根package识别入口并生成无效临时目录；未产出可用包。随后从`apps/electron`正确项目目录重跑，在另一个独立输出目录打包并完成上述核验。失败临时目录是本轮新建，不是旧产物。此次只制作未启动测试包，未做用户UI/Provider验收；AO-G0～G3与真实业务质量仍未通过。

## 11. 2026-10-13 14:21 GMT+8：项目概览 React 落地与 v2 测试包

用户启动前一份岗位预算包后发来截图，指出概览仍为旧交互。截图文案与`ProjectOwnerGoalPanel`/`ProjectOwnerRuntimePanel`旧组合一致；根因是静态 HTML 原型已评审，但 React 替换尚未实施，而此前打包只覆盖 AO-07 岗位预算变更。我此前没有说明包的界面范围，造成误导。用户明确批准将已认可原型落实到 React 并重打包。

新增`ProjectOwnerHome.tsx`并接入`ProjectPilotOverview`：首屏显示目标摘要、流程阶段、下一步、Owner配置与最近调用摘要；目标编辑、配置/准备规划、计划审阅/执行准备按需展开。目标表单支持从首页独立呈现，Task Owner 旧调用默认仍包括规划面板。安全边界保持：没有自动生成/重试、Provider 调用或授权扩张；当前未知费用与过期来源明确显示。预算说明已同步为共享总额全局硬上限、可选岗位 cap 只收紧、Reviewer 费用按被评任务岗位归属、USD 微美元和unknown占额语义。静态原型和会话方案也同步了岗位 cap 定义。

新增`ProjectOwnerHome.test.tsx`覆盖首屏层级、信息解释及门禁入口。验证：新首页3/3，原目标面板3/3、Owner Runtime 1/1、计划面板4/4；全仓646测试文件失败0；workspace typecheck通过；Biome 2160个文件通过；完整`bun run build`通过（Renderer仍报告既有>500KB chunk警告）；`docs:generate`、`docs:check`、`git diff --check`通过。

v2 ZIP：会话工作台`ao07-owner-home-test-20261013/package/Gravitas AO07 Owner Home Test-0.13.5-arm64.zip`，285,545,535 bytes，SHA-256=`2db8506d01e4fa16a5a10f300f1cbe0ee0eb5f254bbd2b8dfbdceb05b051edc0`。独立Bundle ID=`com.gravitas.ao07.ownerhome.test20261013`；Info.plist、ASAR主入口、默认Skill资源校验通过；从ASAR提取的ProjectView chunk确认含新版主页标题。启动器`Launch AO07 Owner Home v2.command`为Gravitas配置和Electron user-data设置独立目录。旧测试包及其用户数据保持未改，v2未安装/未启动/未发布/未公证；没有录入或读取凭据，没有Provider调用。v2仍需用户实际UI手测，未宣称AO-G或业务验收完成。

### 包准备与操作事件更正（2026-10-12 18:16 GMT+8）

当前AO-07分支的`bun run dist:mac-dev-zip`完成，产物`apps/electron/out/Gravitas-0.13.5-arm64-mac.zip`（SHA-256 `d4cea0584c66e8dfab7c68f178f25c812521806fd550eea3660721a03bf5c680`），未安装。`codesign`检查显示app bundle为adhoc签名、TeamIdentifier缺失；不能假定该包具备可用于真实凭据的SafeStorage。尝试直接从包内`Contents/MacOS/Gravitas`运行SafeStorage探针时，macOS实际唤醒了既有`/Applications/Proma.app`实例，未生成探针结果。不得将本次当作隔离应用启动或SafeStorage验证；不得重复该启动方式。

操作窗口日志观察到飞书Bot连接、通讯录同步拉取3条并本地合并3条，随后钉钉因缺少凭据而跳过。未观察到飞书消息发送，也未发Provider请求。既有主进程起始时间为10月10日；无法仅从这条日志确认本次激活触发的具体写入边界，故如实列为意外外部只读同步/本地合并风险；没有擅自关闭用户长期运行的应用或回滚其数据。用户已被告知。真实验证暂停，待用户确认后再用严格隔离方式验证应用启动、签名与凭据存储。

### 22:51 GMT+8：独立验收App与隔离配置启动

经用户重申继续后，使用唯一`com.gravitas.ao07.acceptance` Bundle ID构建并启动未安装AO-07验收App（Electron39.8.10/ABI140，Electron package0.13.5/shared0.2.52）；未触碰`/Applications/Proma.app`。隔离配置目录`ao07-live-acceptance-config`为新建空配置，只存在手动指向`127.0.0.1:9`的全局代理黑洞；生成的渠道仅有disabled且无credential的默认DeepSeek。Chromium代理和HTTP(S)_PROXY均设为黑洞，端口9无监听；运行时无外部socket，只有本地brief callback listener `*:8765`。启动日志明确飞书/钉钉未找到Bot凭据，跳过同步；没有任何真实Provider请求。

独立probe-only app.asar、唯一`com.gravitas.ao07.safestorageprobe` Bundle ID、相同macOS Electron39.8.10/ABI140验证`safeStorageAvailable=true`且非敏感哨兵字符串加解密往返成功。该能力测试未读取/生成任何用户凭据。probe所用App包经唯一Bundle ID及main入口替换，成功运行后没有触及现有安装实例。

当前AO-07真实业务/Provider验收尚需用户在隔离窗口自行通过UI录入渠道凭据（不在聊天/终端传送），并提供可判定产物质量的真实业务目标与验收标准。保存前不发请求；存档后只核对非敏感渠道元数据、credential字段存在性/安全存储能力及配置指纹。其后重新核对当前官方价格、请求输入/输出硬限制和本机egress闸门；任何单次真实调用前单独确认调用类型与费用上限。当前版本的真实运行金额授权仍为零，AO-G0～G3未通过。

## 12. 2026-10-13 15:41 GMT+8：v3 确认窗可读性用户反馈

用户反馈：“没有难懂的地方了。”此为对近期简化后的规划预检确认窗可读性的正向反馈；不扩展为整包所有功能均完成手测或Provider/业务验收。v3隔离测试包不因此启动或授权真实模型请求；既有失败Run及其unknown费用/usage/停止状态保持不变。

## 13. 2026-10-13：AO-07 异常覆盖对账与错误轮次反例

新增报告：[AO-07 异常验收证据对账](ao07-exception-coverage-audit-20261013.md)。对照Stage B、技术评审解析与Native成功路径，已确认已有隔离覆盖包括预算/次数耗尽、blocked/无效/缺失回执、重复/覆盖及跨项目身份拒绝、事务回滚、存储重开、依赖+返工成功路径、来源漂移、返工unknown与停止升级。补查发现Reviewer命令轮次与Executor不一致缺少独立反例；仅在`project-owner-execution-stage-b.test.ts`新增fake-only测试，确认服务拒绝记录且不生成评审证据，未修改产品运行代码。

验证：Stage B **49/49、265断言**；严格技术评审解析 **4/4、8断言**；新增测试文件Biome通过。新增测试首轮有一条无关Scheduler状态原因断言失败，移除该断言后重跑通过；属于测试预期过宽，不是产品实现缺陷。测试为隔离配置及本机fake loopback，没有Provider出网、凭据读取或账本写入。

尚未覆盖实际Electron进程崩溃/重启后晚到回调组合、Native全异常矩阵、真实Provider账单/usage/request ID/远端停止及业务质量；AO-07整体和AO-G0～G3仍未通过。旧失败Run及unknown费用、usage和停止状态保持不变。

## 14. 2026-10-13：隔离进程恢复后晚到回调补验

在`project-owner-execution-stage-b.test.ts`新增fake-only组合测试：父Bun测试进程派发并挂起fake headless Executor回调，关闭隔离SQLite；独立Bun测试子进程注册完整Electron mock，调用应用启动所用的`recoverInterruptedOwnerRuntimeExecutions`服务并关闭数据库；父进程重开同一隔离数据库，再释放原Runtime的fake完成回调。子进程确认该Execution变为`stale`、command为`needs_reconcile`且`actual_cost_micros=null`、unknown usage标记保留、command reservation仍大于0、grant为`paused`。晚到回调后Execution仍stale、无结果摘要/技术评审、grant与command占额未变、命令总数仍为1，因此未续派。

验证：Stage B **50/50、280断言**；技术评审解析**4/4、8断言**；全workspace `bun run typecheck`通过；Biome变更测试文件、`docs:check`和`git diff --check`通过。首次以普通`bun -e`启动恢复逻辑时，因缺少测试运行器Electron mock而无法加载依赖；改为临时隔离Bun测试文件并注册项目完整Electron mock后通过。该失败属于测试启动方式，不是产品缺陷。未修改产品运行实现、用户配置或旧unknown账本；fake-only，无真实Provider请求或凭据读取。

这是两个Bun测试进程共享隔离SQLite的服务/存储边界证据，不是Electron完整GUI进程崩溃重启、断电、native WAL、多进程并发或真实Runtime停止保证。真实Provider账单、usage、request ID、远端停止、业务质量和AO-G0～G3仍未通过；未知reservation继续保持不变。详见[AO-07异常覆盖对账](ao07-exception-coverage-audit-20261013.md)。

## 15. 2026-10-13：重复恢复扫描与重复晚到回调幂等补验

扩展上述隔离进程用例：子进程在第一次恢复将running执行记为stale/unknown后，再次对同一execution调用恢复扫描，第二次结果为空；父进程恢复SQLite后将同一fake `onComplete`完成回调连续触发两次。最终execution仍为stale且没有result summary，command继续`needs_reconcile`、actual费用为空、reservation不变，grant保持paused，评审证据为空，命令数仍为1。测试没有创建Provider请求或Reviewer续派。仅测试代码和证据文档变化，没有产品运行代码修正。

验证：Stage B **50/50、281断言**；技术评审解析**4/4、8断言**；全workspace typecheck、Biome变更测试文件、`docs:check`、`git diff --check`通过。该结果是隔离SQLite下重复恢复/回调状态幂等的确定性证据，不替代Electron完整崩溃/GUI重启、native WAL、断电、多进程并发、真实Runtime或Provider验收。旧unknown reservation与真实验收阻塞保持不变。
