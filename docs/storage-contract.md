# 本地存储合同

配置根目录由 app-identity.ts / getConfigDir() 决定，当前为 ~/.gravitas。PROMA_TEST_CONFIG_DIR 仅用于隔离测试。原有数据路径保持兼容，不在此次修复中迁移或删除用户数据。

| 数据 | 权威性与实现 | 备份/恢复边界 |
|---|---|---|
| 配置、会话消息、Workflow、Approval、Memory | JSON 配置 / JSONL 日志是权威记录 | 应用退出后备份整个配置根；恢复后重新打开，不能只备份索引 |
| 项目、营销 | 已有 sql.js 业务数据库是权威记录 | export 后临时文件写入、文件 fsync、原子 rename、非 Windows 父目录 fsync；失败向调用者抛出，不能仅记录日志并返回成功 |
| Campaign、KOL | 既有 SQLite 业务数据，Electron 使用 node:sqlite；Bun 测试使用 bun:sqlite | WAL 与主文件须一致。先关闭应用再备份整个根目录，不应在运行中仅拷贝单个 sqlite 文件 |
| Owner 目标草案 | 项目 paa.db 的 project_owner_revisions 保存项目/单任务的追加式草案历史；不是并行任务、执行或授权账本 | 随项目数据库整体备份/恢复；不单独拷贝一张表。删除主体后规划历史保留，正常服务拒绝对失效主体读写。当前重开/加表/回滚证据仅为 sql.js 临时配置测试，尚未原生驱动/断电/多进程并发验收 |
| Owner计划版本 | 同一paa.db的project_owner_plan_revisions保存计划附属历史；目标/计划修订独立并双校验，内容确认不是授权 | 随完整项目数据库备份/恢复，不单独恢复计划/目标表。删除主体仍保留历史，失效主体拒绝操作；损坏历史/来源拒绝且保留原件。sql.js隔离重开/回滚/旧库加表通过，原生及跨进程/断电验收按[验证记录](plans/2026-10-07-ai-project-owner/plan-version-verification.md)分别记录 |
| Context Store | 可重建检索索引，不替代会话 JSONL 或审批后的 Memory | context-store/<workspace-slug>/context-store.db；独立全局索引 __global__；重开回归保证已索引内容可读 |
| 研发快照／验证／应用记录 | 项目 SQLite（development_apply_operations）记录应用操作状态；快照内容与验证日志保存在会话私有目录（agent-workspaces/<slug>/<sessionId>/development-*） | 备份须同时覆盖项目数据库与被引用的会话目录；操作记录指向的快照缺失时应用/Review 会明确阻塞，不伪造成功 |

新配置优先采用文件；已存在的 SQLite 是兼容性约束，不代表授权另建一套权威数据。业务数据库不能当成可随意删除的缓存。Context Store 当前没有用户可操作的一键全量重建流程；发生损坏时保留原件，从权威会话记录重建，不能声称清缓存即恢复所有数据。

### Owner 完整文本成果与准确评审（2026-10-19）

新非代码执行来源显式冻结 `textDeliveryVersion=1`。员工完整最终回复保存在 `projects/owner-deliveries/<projectId的SHA256>/<executionId的SHA256>.json`，包含准确项目/授权/命令/执行/会话/任务/步骤、计划修订、返工轮次、消息身份、完整正文、UTF-8字节数与本地摘要。正文目前上限64KiB，超过上限明确失败，不截断为可评审成果。文件路径由可信身份生成，不接受模型指定路径，也不发送本机路径给模型或Renderer。

正文文件是成果内容权威记录；`paa.db` 中命令的新增nullable `text_delivery_hash` 是其执行身份与正文版本锚，非空后不可改写；Reviewer 排队时冻结相同摘要。恢复/备份必须在应用退出后同时覆盖完整业务数据库与 `owner-deliveries`，不能只恢复其中一个、重算摘要追认替换内容或从截断的执行摘要重建成果。旧行保持NULL，旧来源没有该版本时仍按旧评审契约读取，不迁移补造历史正文。

写入使用私有目录/文件权限、排他创建、拒绝符号链接，先文件fsync，POSIX再同步目录；Windows未保证目录fsync。文件先落盘、执行终态及摘要随后同SQLite事务提交，并非跨存储原子事务。中途失败留下的文件保留但不视为已完成成果；仅身份、完成终态与账本摘要全部匹配才可使用。文件缺失、损坏、版本不符或费用未核验时拒绝新评审/返工续跑，不自动补写或重试；原费用/占额证据保留。历史评审仍可读取，但成果不可核验时明确标识，不作为继续执行依据。本地SHA用于一致性检测，不是抵御任意本机数据库写权限的签名。

Reviewer v2绑定准确正文摘要，逐标准的“满足”必须包含正文中的准确引用；引用存在只证明对应片段被指出，不证明语义质量、外部事实或业务验收。该阶段不代表Owner已读取完整正文或已实现自主质量验收。隔离故障用例与重开证据不等于断电、Windows真机或生产业务质量验收。

0.13.45/shared0.2.76补Owner完整读取：新管理请求的conversation.deliveryReview.version=1冻结准确成果及同版本逐项评审；快照随原planning source_snapshot存于同paa.db，属于管理请求的资料证据，不是第二套成果权威或缺文件时自动恢复/重发的许可。准备、同请求重放、发送与回执处理按冻结版本重读当前文件/账本；正文变化使旧来源失效。旧快照缺该字段仍以原摘要协议重建，不自动添加正文或改写提示。完整成果及检查的JSON目前限140000字符，超过则保留原成果、明确不可核验，不截断为通过依据；有全文的对话快照限240000字符，总资料仍沿用280000限制。

新管理委托fullDeliveryReviewEnabled纳入scopeHash和确认预览，明确完整正文与逐项检查将发送Owner模型；旧委托缺字段不升级。占额和最终发送门禁分别复核此能力，管理调用预算与请求上限不增加。读取能力仅供分析/沟通，不授予业务验收、返工或续派权限。实际自动质量动作仍需后续契约与证据。

### Owner质量决定及子任务实际动作（2026-10-19，0.13.46/shared0.2.77）

新非代码业务来源可显式冻结`qualityManagementVersion=1`，要求完整文本契约，随准备、重验证、来源摘要和最终业务确认冻结。管理委托另以`qualityDecisionEnabled`纳入scopeHash/预览/占额和最终准入；旧业务来源、旧管理委托与旧提示缺字段时不升级。只有准确Reviewer成果可开启管理上下文qualityDecisionVersion=1，附当时剩余返工/请求/费用边界，Owner必须提出逐项质量决定或必要问题，不能只回复等待。决定随原不可覆盖Run outcome及可信原文回执保存，尚不构成动作已完成。

同`paa.db`新增`project_owner_quality_actions`，按Owner执行唯一，Reviewer命令索引关联，接受/返工的有效动作对同一Reviewer命令至多一份，保存Owner管理身份、Run回执、业务授权/Task、正文摘要、返工轮次、原决定及实际accepted/rework_authorized/escalated/blocked结果；UPDATE/DELETE由触发器拒绝。它是业务任务的动作证据，不替代权威Task。实际动作前重验当前双授权、来源/方案/配置、正文/评审结算、Task与依赖；接受仍调用原Task完成服务并保留DoD/交接约束，不能伪造人工认可或绕过已有完成门禁。Task更新、动作证据、带Owner actor的活动及管理对话投影在同一外层事务；执行子步用SAVEPOINT防止错误被捕获后留下半个Task。返工决定不直接发送模型请求，Scheduler及命令服务再次核对已保存Owner决定与有效业务许可后续派。

备份恢复须包含同一业务数据库全部Owner/Task/授权/回执/动作表、配置与完整成果文件。动作重放按准确Owner执行幂等；已验收成果缺失不能继续解锁后继。每个blocked动作仍是不可变停等结果，不自动重放旧请求或释放未知预算。新版本在动作内记录权威门槛指纹，覆盖Reviewer/Task/依赖/业务grant与重验证/策略/额度/Owner主体及当前管理委托身份与质量权限；后台只在指纹变化、当前任务仍等待、原业务授权和管理质量委托都有效、Reviewer成本与正文可核验、无更新或未知在途命令时追加一次恢复观察。新Owner运行的决定冻结前一动作身份与新指纹，执行时重新比对事实并重验双许可；结果以新Owner执行ID追加，旧blocked记录保留，同一Reviewer仍至多一份有效验收/返工动作。撤销、过期、配置/方案漂移、未知费用或权限不足不会自动恢复。早期没有conditionFingerprint的旧动作只读兼容，不自动猜测基线或重放，需等新业务Reviewer事实或重新授权产生新来源。隔离BDD覆盖任务来源短暂变化导致阻断、恢复后追加Owner判断并保留旧动作；新恢复链尚无原生WAL强杀/真实断电、固定产品包或真实模型质量证明。

新版质量管理委托下，后继Owner命令会将同一授权范围内每个上游依赖的准确成果冻结进命令提示。上游Task须保持准确步骤关联并处于完成态；最新Owner质量动作须为accepted，独立Reviewer须approved且绑定同一成果，文本正文、费用与执行轮次须可核验。完整成果总上下文上限64KiB；越界、缺失、版本漂移、未验收或依赖不在范围内均拒绝派发，不回退为摘要。成果内容作为不可信数据标注，不执行其中指令；写入提示时将JSON中的`<`和`>`转义，避免正文伪造提示分隔符，解析后保留原文。上游成果摘要哈希纳入命令确认指纹；预览/确认/排队与启动时都会重新核验，任一变化均拒绝本次命令。启动重验当前预算时还要确认可用额度仍覆盖已排队命令的冻结预留，额度缩减时停止启动。旧版未启用`qualityManagementVersion`的授权保持原行为。

原子 rename 防止读到半写文件；替换后的目录 fsync 如果失败也会抛错，但此时目标已替换，不能宣称旧版本仍在；Windows 未做目录 fsync。同步不等于跨平台断电恢复保证。Windows、文件系统异常和断电恢复仍需要专门故障注入验收。不得把本轮临时目录写失败测试描述为已通过真实断电试验。

Memory 保持 candidate → Approval → 用户批准 → Memory，索引写入不会绕过审批。配置审计采用同步追加：低频写入完成后才返回，IO 错误向上传播，避免 fire-and-forget 在退出或测试清理后继续写入。

### 非代码任务准备与启动确认（2026-10-08）

项目SQLite新增`controlled_task_preparations`：请求幂等、任务对应、确认/范围指纹、有效期、唯一execution关联和本地请求准入时间；任务新增不可普通编辑的`controlled_preparation_id`。与现有任务/执行一起一致备份，不单独恢复该辅助表。缺标记或回执不补造授权；运行中崩溃不自动重放。新controlled数据不能无一致恢复方案交旧0.12.104执行。细节与边界见[非代码项目入口](plans/2026-10-07-ai-project-owner/noncode-project-entry.md)。

### Owner规划载体绑定与暂停来源关联（2026-10-08）

`project_owner_runtime_revisions`保存项目Owner职责与现有受控载体绑定的连续版本；`project_owner_planning_links`保存Goal/Plan/context/绑定版本与权威paused承载任务的来源关联，属于同`paa.db`附属权威数据，不是Context Store索引或新grant。`controlled_task_preparations.owner_planning_link_id`提供第二份目的定位证据，两者需与任务/配置/Goal/Plan一起一致备份恢复。任一证据存在不得降级为普通Agent，损坏/来源变化fail-closed，不自动重建或重发。只有配置指纹，不持久化渠道凭据或发送文件正文；JSON来源/版本记录不代表签名、费用授权或业务完成。当前A阶段拒绝规划任务启动，实际Runtime与未知费用恢复待B/C实现和D验收。

Owner规划B（2026-10-09）追加`project_owner_planning_links.source_snapshot`保存当次受审数据投影（不含文件/密钥/角色全文）及`project_owner_planning_admissions`保存唯一link/execution/session单发送占位、实际request hash和冻结快照。它们是paa.db权威恢复集的一部分；占位不能靠重建索引/删除行释放来重发，可能已发送保持unknown，停止或解析失败不等于远端未收费。旧A缺snapshot只能在来源仍当前且未关联执行的显式重复准备事务中补齐，不补造历史发送资料或Run。费用/最终Run未接通不能把admission当结算；Owner专用nullable用量证据不同于SDK兼容默认0。

### Owner规划Run与停止/隔离证据（2026-10-09）

C阶段在同paa.db新增`project_owner_planning_run_receipts`、`project_owner_planning_run_outcomes`、`project_owner_planning_stop_requests`和`project_owner_planning_callback_evidence`。原文/nullable用量/Runtime报告费用或unknown先保全，再事务处理生成；回执不可覆盖，停止意图持久化，坏来源server callback隔离记录不作为生成或结清证明。generated计划指向原始Run回执，不能单独恢复或删除这些表、Goal/Plan/配置/link/preparation/admission/任务/execution任一子集。关联Owner准备或Run的项目、承载任务和目标业务任务暂不支持物理删除，应暂停并保留证据；没有隐式清缓存或归档入口。未知发送与费用不因停止、回滚、重开而变零或释放占位。原生迁移/重开/receipt先提交及生成事务ABORT验收见[Owner规划C](plans/2026-10-07-ai-project-owner/owner-planning-runs.md)；不是断电或多进程验收。生产模型启动禁令仍保留，完整受控调用恢复待D验证。

Owner D为`project_owner_planning_admissions`追加nullable `integrity_hash`，新发送占位对link/execution/session/request hash/冻结source JSON/时间全部列保存本地SHA，Run接收先验证格式与该摘要。旧表仅ALTER新增列，旧行保持NULL，禁止迁移补造发送证明；没有该证据的回调仍先隔离保留原文，但不升级完整Run/费用、不生成或补发。此SHA是本地损坏检测，不是签名，也不认证拥有任意数据库写权限的攻击者。历史不可覆盖receipt仍保全当时已捕获证据，不因后续占位丢失推断新的发送许可。

### Owner业务执行授权准备（2026-10-09）

`project_owner_execution_preparations`在同paa.db保存追加式准备来源/请求/修订/摘要，`project-pilot-policies.json`只引用当前准备且始终paused。两者与Goal/Plan、人员/工作区配置和既有Pilot账本一起一致备份；不能单独恢复一张表或把来源准备当grant/余额。task links尚空、状态pending_task_links；没有模型/业务任务/授权/请求副作用。

保存顺序为policy锁内DB证据先提交、JSON原子替换引用、回读。不是跨存储原子事务，文件失败可能留下未应用证据，应保留并阻止legacy发行，不自动删除/重发/补授权；摘要仅检测本地损坏，不是认证。Owner准备关联项目/目标任务暂不支持普通物理删除。未知预算/请求或停止未决先走原暂停/对账，不在保存准备时清零。详细范围、兼容与验收边界见[暂停执行准备](plans/2026-10-07-ai-project-owner/owner-execution-preparation.md)。

历史A/C段落描述当时的常量启动禁令；D之后已由准确Owner来源/费用/停止/单发送门禁替代（见[受控启动](plans/2026-10-07-ai-project-owner/owner-planning-controlled-start.md)），不能将旧禁令重新恢复或外推为业务执行授权。

### Owner暂停Task与步骤关联（2026-10-09）

AO06以同paa.db追加`project_owner_task_materializations`与`project_owner_task_step_links`，业务任务仍只存权威`tasks`，依赖仍只存`task_dependencies`。`tasks.owner_step_link_id`与indexed link/history任一残余均限制能力，不是grant。`project_owner_business_session_restrictions`保留已观察Task/execution/session/project的负向用途；queued的空session占位不是共享会话，不据此圈其他任务。

材料化只在policy快照锁内同SQLite事务首次INSERT paused+专用marker/关联/依赖/活动，不写Pilot JSON、不发普通TaskChange。内部builder只在本次未提交staging的同步单次作用域可用，已提交链接不可复活取消目标或补造损坏Task。外层raw BEGIN/SAVEPOINT拒绝；DB ABORT整体回滚。单任务只允许一步复用普通未执行目标，显式人员/工作区/范围patch保内容并清旧成员身份；原AO05 whole目标hash自然stale，原件不改，结果仍需重新验证。

这些表/列与原AO05准备、Goal/Plan、Task/dependency、人员资料配置和Pilot账本一起一致备份。header/link/marker/原来源丢失、坏payload、已观察限制残余均不得降legacy或换request重建；普通物理删除/改范围/依赖、旧费用确认/派发、所有Runtime发送均负向拒绝，暂停/取消/保全仍可用。没有active许可、模型资料工具fence、断电/多进程或真实Provider验收。见[暂停Task材料化](plans/2026-10-07-ai-project-owner/owner-task-materialization.md)。


### Owner重验证v2来源（2026-10-09）

AO06第二片在同paa.db追加`project_owner_execution_revalidations`（additive）。`project-pilot-policies.json`的PilotPolicy可含可选`ownerExecutionRevalidation`引用（含materialization反查三元组），`ownerExecutionPreparation`逐字节保留；v2存在时v1重存前置拒绝。v2来源实时重放v1构建+权威Task/dep/marker/link精确核验，budget/expiresAt从v1原样携带不顺延。这些表与原AO05准备、材料化、Goal/Plan、Task/dep、人员资料配置和Pilot账本一起一致备份；v2行绝不入旧表，unapplied/partial失败证据保留不补写。v2 current是"已按真实任务重新冻结"，不是授权：旧SourceGate（含发行指纹纳入v2引用）在v2残余下全部拒绝，资料工具/预算purpose/claim/Runner仍关。详见[重验证](plans/2026-10-07-ai-project-owner/owner-execution-revalidation.md)。


### Owner执行侧门禁休眠能力（2026-10-09）

AO06第三片additive：`pilot_runtime_grants`/`pilot_commands`加`purpose`（默认controlled_task）/`owner_source_id`/`owner_source_integrity_hash`；新表`project_owner_execution_gate_sessions`（含准入内容快照hash与provider_admitted_at）与`project_owner_execution_knowledge_reads`（出处级审计，无正文）。这些表与Pilot账本、Owner准备/材料化/重验证和任务数据一起一致备份。purpose=owner_business_execution的行本片无创建路径；gate行仅测试TEMP或admit函数测试产生，激活前置条件（Pi beforeToolCall切换/CHECK/redirect与参数比对集/性能评估）见[执行侧门禁](plans/2026-10-07-ai-project-owner/owner-execution-gates.md)。


### Owner执行授权账本（2026-10-09 Stage A）

AO06第四片additive：`project_owner_execution_grants`（purpose单值owner_business_execution、状态机active/paused、needs_reconcile枚举预留、上游双三元组+policy revision冻结引用、budget原样复制）与`project_owner_execution_grant_decisions`（撤权决策行）。授权行是静态许可记录：与Pilot账本、Owner准备/材料化/重验证、Task/dep和人员配置一起一致备份；撤权只改state不删行，paused无复活路径，同项目至多一行active（partial UNIQUE索引）。**Stage A结束时账本行无任何消费路径**——首次消费（reserve/claim/逐请求）属Stage B另行审批；真实费用/远端停止/断电多进程仍未验证。详见[发行Stage A](plans/2026-10-07-ai-project-owner/owner-execution-grant.md)。


### Owner命令执行链（2026-10-09 Stage B）

AO06第四片Stage B additive：`project_owner_execution_commands`（六态CHECK、幂等键UNIQUE(grant_id,idempotency_key)、source三件套锚v2冻结、ack_fingerprint）、`project_owner_execution_stop_escalations`、`project_owner_execution_start_attempts`（不可变trigger）、`project_owner_execution_start_receipts`（不可变trigger）、`project_owner_execution_command_links`（锚v2 revision）、`project_owner_execution_request_reservations`；`agent_executions`加`owner_command_id`列；`project_owner_execution_grant_decisions`重建（CHECK扩展reconcile，数据保留）。豁免收敛：agent_executions.owner_command_id→commands表三活态→execution_id全等才豁免，缺失/损坏/终态一律不豁免；restriction残余不灭；先命令行后execution。pilot_runtime_usage_receipts与价格证据注册表复用。Stage B Native核心矩阵用fake账本验证；最终8/8矩阵通过，359个源码SHA匹配，网络/SDK/Model/业务Run tripwire为0；没有真实Provider、费用或Provider请求ID。安全修复已加入Owner普通start fail-closed、heartbeat unknown恢复、逐请求累计预算、claim快照复核、handoff session与receipt时间绑定。**截至2026-10-09 23:36 GMT+8，生产Runtime dispatcher与Pi/AI SDK handoff仍未接线，Owner命令API没有生产调用方；普通tryStart/heartbeat路径fail-closed，因此不能据此称生产消费链已联通或Stage B端到端验收完成。** 当前HEAD `3dfe5ce4`、ahead 4、未推送；全量测试、typecheck/lint/docs/build通过。真实Runtime启动、Provider费用/请求ID与远端停止另审另批。详见[Stage B](plans/2026-10-07-ai-project-owner/owner-execution-grant.md) Stage B节及该计划台账末尾追补。
