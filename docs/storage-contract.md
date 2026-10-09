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
