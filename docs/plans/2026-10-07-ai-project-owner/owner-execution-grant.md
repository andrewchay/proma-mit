# AO-06第四片Stage A：Owner执行授权账本与发行确认

Stage A授权发行契约（2026-10-09 18:35 GMT+8，Electron0.12.124/shared0.2.37）保留以下历史口径：当时发行行没有消费者。Stage B与2026-10-10自主调度增量见文末；原始阶段边界和证据不改写。

## 数据（研究§2/§9钉死）

新表`project_owner_execution_grants`：purpose CHECK单值`owner_business_execution`；state CHECK三值（Stage A可达{active,paused}；needs_reconcile仅枚举预留、全库无写路径）；上游双三元组（revalidation+materialization）+policy revision冻结引用列；executor/reviewer/workspace/channel/model/runtime；budget四字段（expiresAt原样复制不顺延）；approval_fingerprint+source_hash+request_id+input_hash+issued_at；partial UNIQUE index同项目至多一个active。新表`project_owner_execution_grant_decisions`：最小撤权决策行（actor恒local-user、impact零值快照）。迁移additive；既有pilot/owner数据零变化。

## 发行与撤权

- 指纹`hashOwnerGrantApproval`复用`ownerExecutionHash`：v2 integrityHash为根+sourceHash冗余+budget四字段+绑定身份（executor/reviewer/workspace/channel/model/runtime）+policyRevision；**不含时间戳、不含命令计划摘要**（grant指纹冻结"谁可以在什么预算边界内消费"，不是"跑哪条命令"）。grantId=owner-grant-${fingerprint.slice(0,32)}-${randomUUID.slice(0,8)}。
- 研究契约偏差（父裁决）：research原提案为确定性grantId+UNIQUE(project,revalidation,fingerprint)三元组。为支持"发行→撤权→重验证→再发行"合法循环（撤权paused后同源可再发新行），改为随机后缀+partial active唯一索引；三元组UNIQUE去除。该循环要求已写入Stage B决策点。
- 发行四前置：v2 current且record与expectedRevalidationRevision一致（1-based）；boundary idle（扩展后）；expiresAt未过期不顺延；executor/reviewer=v2冻结员工且当前启用+assertLocalActorEnabled。preview无状态双revision CAS；confirm拒外层事务→withPolicyLock内DB事务→**live policy revision CAS**→active幂等分支（input_hash校验）→idle重检→指纹三重全等（重算=confirmedFingerprint=preview）→requestId幂等→INSERT+partial UNIQUE兜底。
- 撤权两阶段：preview影响面（Stage A恒零）→confirm指纹CAS+`state='active'`条件UPDATE+决策行。只改state不删行；paused无复活（同指纹二次confirm拒）；撤权后boundary idle解除→重验证恢复→再发行新行。

## 门禁扩展

- `assertOwnerExecutionBoundaryIdle`追加1路disjunct：owner grants active/needs_reconcile→拒。active阻断新发行与v2重验证preview（fail-closed：发行后冻结源不得被改写）；paused不阻断。
- `hasOwnerExecutionPreparationEvidence`七路（新增第7路grants表任意state计入）——v2被病态删除后旧issuer仍拒。
- 七处旧AO05 guard/16入口guard/policy引用层函数零改动；pilot账本永不承载owner purpose行；policy JSON零写入（发行confirm不写policy）。

## typed API/UI

六通道（get/list/previewIssue/confirmIssue/previewRevoke/confirmRevoke）+preload六方法+Jotai atoms+`ProjectOwnerExecutionGrantPanel`挂准备面板同层。文案硬约束：发行≠派工启动、确认后无单次费用同意（第3确认在启动时另有）、active期间重验证被阻断属预期。

## 验证与已知记录

- 发行模块11test34assert（发行/撤权循环/幂等/CAS含伪造live+5/外层事务/needs_reconcile不可达/第7路病态删除兜底/重开持久）；UI/IPC 24test（三层各RED→GREEN）；全量584隔离文件0失败、typecheck/lint(2045)/docs/build通过。
- 独立审查2P1（confirm缺live policy CAS、第7路缺失）整改后复核收束（S/ao06-issuance-security-review-followup.md）。
- Native **run e950bbbc-2e2e-4f8d-9447-ace6be29b136** 16/16：Electron39.8.10/ABI140/native WAL/production preload/六IPC/UI，357源SHA绑定、tripwire全零、并发双confirm partial UNIQUE兜底、重开持久、TEMP清理、生产目录不变。已知记录F-expiry-order（时钟前移下v2先于grant显式过期分支、fail-closed方向可接受）。
- Stage B（另审另批）后已实现：命令表+reserve/queue/claim/handoff/逐请求/结算/stop/恢复/豁免收敛（R3R5R7R8）/idle的commands与escalation两路/占额派生；2026-10-10自主调度实现详见下节。真实费用/Provider请求ID/远端停止/断电多进程/完整导航/安装仍不在范围。

## 2026-10-10 自主调度模式增量（实现切片，AO-G*仍未通过）

- Grant新增默认`manual`的`dispatchMode`；旧记录迁移为manual，`autonomous`进入审批指纹。UI区分逐命令人工确认与自主授权；自主模式须由主进程重新计算摘要并走Electron原生dialog服务，取消/无可见窗口拒绝创建active grant。该信任边界只抵御Renderer单独失陷，不抵御主进程/应用被篡改或本地有权限数据库修改。
- 主进程Scheduler只消费active autonomous grant。人工IPC ack/dispatch入口均拒绝消费自主命令；Scheduler内部以确定性grant/task/link/role/source revision幂等键调用既有费用预留/command/dispatcher/settlement链。应用启动在既有Owner recovery之后执行一次reconcile；Task权威更新、已提交项目链修订、用量结算触发事件唤醒，Renderer mount不是派发源。
- Scheduler重验current revalidation、材料化Task/link集合、员工/Runtime绑定、policy revision、grant期限、预算/次数与`listTaskBlockers()`。每Task固定Executor→Reviewer串行；成功不自动完成业务Task、不自动返工/重试；只在权威Task完成或handoff接受后推进依赖。unknown/stop未核验保留`needs_reconcile`与占额，不创建新命令。
- fake-only BDD覆盖manual/autonomous隔离、unknown不重试、依赖在权威Task完成前阻塞；实际Electron/ABI140/native SQLite WAL/生产preload/React命令面板的Native run **c4fcf846-c9fe-42c7-ac4d-3a62033a5698**覆盖一次授权范围内Executor与Reviewer顺序运行、fake transport usage结算与waiting UI。证据：`owner-stage-b-native-validation/autonomous-harness-20261011/runs/c4fcf846-c9fe-42c7-ac4d-3a62033a5698/`。该Harness使用fake dialog adapter而非实际OS原生点击，且单Task无依赖；依赖Native续派随后由下条run补验。
- Native run **19617a5e-b709-4e0c-83f1-9e75e2a8f298**通过生产preload调用grant preview/confirm IPC，并以fake dialog adapter响应主进程确认；前置Task Executor/Reviewer结算后下游仍为0命令，权威`updateTask`完成前置Task后只续派下游Executor/Reviewer各一次，重复wake不增派。共4条settled命令、4次fake Runner/transport请求、fixture usage合计16微美元；tripwire全零、227个源文件SHA均匹配当前树、TEMP清理且生产工作区计数未变。证据：`owner-stage-b-native-validation/autonomous-dependency-harness-20261010/runs/19617a5e-b709-4e0c-83f1-9e75e2a8f298/`。fake dialog adapter不是OS原生对话框或物理点击；真实依赖语义测试通过，但非真实Provider/费用，也不证明完整主窗口导航与用户闭环。
- 生产Provider、真实费用、实际账单硬上限、Provider请求ID、远端停止、物理原生对话框点击、断电/跨进程/安装包仍未验证。AO-G0～G3与AO-A06完整闭环不因本增量通过。

## 2026-10-11 过期 unknown grant 归档增量

- Owner grant 增加不可复活的 `archived` 状态；旧SQLite表通过事务性重建扩展 `state` CHECK，保留既有grant字段与三个grant索引。Scheduler 将 archived 识别为终态，不恢复、不派发；未结算 command 的 `needs_reconcile` blocker 仍然阻止新授权，归档不释放其占额。
- 过期归档服务只接受已过期 `needs_reconcile` grant，拒绝排队/运行命令、未结算请求预留与未解决停止升级；预览指纹绑定当前账本、runId与本地 harness receipt SHA-256。确认在同一事务内 CAS 改grant state并追加 `grant_decisions(action='reconcile')`，审计标注 `local_fake_only_harness_receipt_not_provider_bill`；不同证据重放拒绝。
- 本次仅作用于两份隔离run：`d6378f68-b9b7-4c9d-a7e8-ac97dc0c1de3` 与 `e810032d-db91-42c9-9982-42e76ccbc61c`。每份command仍为 `needs_reconcile`，reserved=`166667` 微美元，`actual_cost_micros=null`；没有request reservation或start receipt，原execution保持failed。每份数据库均有一致性备份、归档前后SHA、receipt/manifest SHA与integrity核验；两次全库比较未发现非目标表行变化，`PRAGMA integrity_check` 均为 `ok`。详细回执分别在隔离run目录的 `ledger-archive-result.json`，原始 `acceptance-result.json` 与fixture manifest未修改。
- Fake-only回执记录Fake调用0、外网拦截0、真实Provider调用0、actual charges 0；这不是Provider账单，unknown费用仍未知，不能据此清零。
- 归档回归包含旧schema迁移/索引保留、unknown占额保留、运行/过期/停止升级拒绝及证据绑定幂等；完整586个隔离测试文件、typecheck、lint、docs:check与build通过。此维护增量不改变AO-G0～G3状态，也不证明真实Provider费用、远端停止或Owner闭环。

## 2026-10-11 Owner fetch前拒绝的人工对账路径（未完成真实账本确认）

- `project_owner_execution_preflight_rejections`只记录被识别的、发生在Provider `fetch` 前的价格协议拒绝；记录绑定项目、command、execution、grant、渠道/模型、确定性错误指纹与创建时间，且受request reservation数为0等前置条件约束。既有历史Zhipu价格协议拒绝只在严格限定的候选条件下提供只读预览，不被伪装成新运行证据。
- `project_owner_execution_preflight_reconciliations`单独保存不可变的本地人工声明审计。预览指纹绑定拒绝证据、当前command/grant/request/stop账本和用户确认声明；确认在同一SQLite事务内重验候选、条件更新command为`released`并记`actual_cost_micros=0`、保留usage证据字段为null、释放该命令的费用/次数占额、暂停旧grant并追加审计。幂等重放会重新校验已释放command、0实际费用、usage字段null、grant暂停、request reservation仍为0及无未解决停止升级；账本漂移即拒绝。
- typed IPC与Preload只暴露列表、只读预览和人工确认。Renderer必须明确勾选已核对Provider控制台无请求/用量；审计行标注为本地用户声明，不是Provider回执。该流程不自动重试Provider、不恢复旧grant，也不处理未知请求、已创建request reservation或未解决停止升级。
- Stage B 28项、IPC 3项、对账UI 2项定向测试通过；全workspace typecheck通过。IPC测试仍输出既有Electron mock缺少`Menu.buildFromTemplate`的启动降级日志，目标断言通过。当前实现仅在隔离数据库验证；真实命令 `302e37b9-635c-4afb-9503-001bbf3d2dc3`仍为`needs_reconcile`、reserved=`500000`微美元、actual cost=null，未在本轮产品UI确认，亦未改真实账本。全量测试/lint/docs/build门禁结果待本切片收束后追加；不得据此宣称Provider账单或真实零费用已验证。

最终门禁（2026-10-11）：全量`bun run test` 640个隔离测试文件失败0；全workspace typecheck通过；Biome检查2150个文件通过；`docs:check`、`git diff --check`与完整`bun run build`通过。首次`docs:check`因`docs/generated/repository-facts.md`派生摘要过期失败，使用项目既有`bun run docs:generate`重生成后复验通过。Build有既存的renderer大chunk提示但成功退出。真实Provider命令与数据库仍未确认/修改；该对账路径尚未在真实账本做用户确认。

### 2026-10-11 对账兼容修复：严格识别Runtime unknown标记

首次打开运行 `b8cb14a3-4376-483f-89f9-c6062848ecec` 的对账预览时被拒，原因不是Provider请求账本或停止升级，而是该旧终态另有`source=unknown`的Runtime结算标记与对应`unknown:<execution>:<session>::`记录键；对账服务错误地把所有非空usage字段都当成Provider用量并拒绝。修复仅接受字段集合、execution/session/channel/model、固定reason和record key全匹配的这类Runtime unknown标记；畸形或不匹配仍拒绝。确认时将原标记/record key的SHA-256写入不可变本地对账审计，再清除命令上的unknown字段；不把它改造成Provider回执。预览会明确提示“Runtime终态unknown标记（不是Provider逐请求用量）”。

该运行只读核验结果：command/grant仍`needs_reconcile`、reserved=`500000`微美元、actual cost null；逐请求reservation 0、未解决stop escalation 0；失败原因仍是已知fetch前价格协议拒绝。用户核对控制台前没有释放占额或确认账本。

回归：Stage B 30/30（150断言，含规范/畸形Runtime unknown标记）、IPC 3/3（36断言）、对账UI 2/2（9断言）、全workspace typecheck、Biome 2150文件、docs:check、diff check及main/preload构建通过。仅隔离运行账本迁移/操作；没有Provider请求。

### 2026-10-12 00:02 GMT+8：用户完成fetch前拒绝对账确认

用户在修复后的隔离UI点击确认。隔离run数据库回读为command `released`、grant `paused`、实际费用记录0；command的历史reserved字段仍为500000微美元，但有效授权占额/次数聚合为0。原Runtime unknown标记已清空，独立不可变对账审计保存其哈希，并标注`legacy_operator_attested`、reason `legacy_zhipu_protocol_mapping_before_fetch`、零请求预留、Provider控制台核对为用户声明。此记录不是Provider账单或独立零费用证明；没有新Provider请求/重试，旧grant不恢复。此数据库属于AO-06 run `b8cb14a3-4376-483f-89f9-c6062848ecec`的隔离config，不是`~/.gravitas`全局数据库。
