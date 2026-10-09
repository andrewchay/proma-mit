# AO-05：绑定计划的暂停执行授权准备

生效范围：2026-10-09 GMT+8 用户批准的首片。当前本地研发与验收状态以[台账](ledger.md)为准；不是生产执行许可。

## 三类确认互不替代

1. **确认计划内容**：认可当前提案，追加confirmed修订。不会付费或派工。
2. **确认本次规划费用**：既有owner_planning专用费用/范围/TTL确认，仅允许一次受限规划请求，不授予业务执行权限。
3. **保存执行授权准备**：保存明确边界的paused Pilot草案与附属来源历史。状态固定`pending_task_links`，没有active grant、业务Task、command、execution或请求预留。

真正业务授权发行仍未开放；AO-05整体保持进行中。现有Pilot是项目级grant，不能直接用它替代Owner准确计划/步骤范围，避免同项目无关任务被后台派发。

## 冻结边界

- 项目或同项目真实任务主体；当前Goal修订及版本。
- 已确认、非stale计划的**confirmed revision、planVersion、planFingerprint、contextFingerprint**与内容来源。revision和planVersion不是同一个数。
- 所选step key及依赖闭包、成果和标准。step不是Task.id，首片没有task links；目标任务和规划承载任务不自动变成业务任务映射。
- 两名不同、已启用、模式正确的实际Executor/Reviewer，明确共同工作区、渠道、模型、Runtime和权限配置。模板岗位仅建议，不自动创建员工或从carrier继承Executor身份。
- 员工prompt/Skills/活动能力版本、渠道配置、工作区及MCP/Skill原件的opaque摘要。Skill覆盖包内脚本、规则/参考与资源，最多2048条目、32MiB总量、4MiB单文件、16层；symlink、隐藏资源及已识别的密钥/凭据文件名（包括无扩展名SSH私钥）拒绝，超限不伪造完整摘要。摘要不保存原始密钥、Header、MCP secret或完整人员指令；不是签名，也不防拥有任意数据库写权限并重算摘要的攻击者。
- 研发模式另明确DevelopmentTaskScope，并验证本地Git仓库身份/baseline。controlled非代码模式不要求Git，也不接受研发写入范围；不因为准备已保存就具有worktree写入或工具权限。
- 显式选择当前项目正式关联、启用的知识来源与知识库身份及元数据摘要。没有内容hash证据的来源明确`contentHash:null`；不读取任意资料正文或把目录元数据当内容认证。空清单为none，项目后来新增资料不自动扩大冻结范围。
- 拟议微美元额度、次数、返工数与未来期限。微美元是整数，界面不接受指数/小数或不安全整数。它们不是已经预留的余额；Runtime停止能力和审核价格仍有支持边界，不承诺Provider账单或绝对金额硬封顶。

Owner规划carrier只提供provenance：明确none，或绑定revision/carrier ID/历史配置与绑定摘要。手工confirmed计划不要求先付费生成；载体与业务执行/评审分列显示，不自动继承。Owner绑定、配置、目标、计划、所选来源或真实任务事实变化导致旧预览失效，当前准备派生stale，历史不覆盖。

## 权威存储与保存顺序

`project-pilot-policies.json`仍是一项目一份当前paused policy，引用版本化`ownerExecutionPreparation`。同一`paa.db`的`project_owner_execution_preparations`保存追加式source/input/requestId/修订/前序摘要/完整性摘要；它不是另一个grant或费用账本。

1. 只读预览重查当前版本、来源、人员与策略，返回完整事实和摘要。
2. 人明确保存；policy文件锁内重新核验CAS与所有来源。
3. DB事务追加准备证据并提交。
4. 原子替换JSON中的paused policy引用，再回读核对。

**JSON与SQLite不是跨存储原子事务。** 两个保存入口均在任何写入前拒绝未提交外层事务。Native兼容层读取驱动真实inTransaction；sql.js没有公开getter，使用内存BEGIN/ROLLBACK探测，仅明确的嵌套事务错误判active，其他错误拒绝；active时不export，支持识别原始BEGIN/SAVEPOINT而非只看包装层标记。JSON替换失败后准备证据可能已提交，界面显示未一致应用；残余证据仍阻止legacy发行。不能因文件失败删除历史、自动重试、补造授权或声称SQLite回滚会撤销文件。损坏/悬空引用拒绝继续并保留原件；遗留锁只供人工核查，不自动移除。

相同requestId与完整规范化输入幂等；换输入不能复用ID。已应用准备被新修订替代、来源变化或策略未应用时，旧请求不重放。项目级policy唯一，切换另一项目/任务主体要新修订，不显示两份当前授权。

存在active grant、reserved/queued/running/needs_reconcile命令、未结请求或open stop时，不允许替换执行边界。旧费用与停止证据保留，走既有暂停/影响面/对账入口；本片不新增解锁或清零命令。

## 旧入口与兼容

- 原Pilot发行preview和confirm都拒绝Owner pending准备，不能只禁用新UI按钮。
- 普通policy保存不能清除Owner用途退成legacy；即使JSON用途丢失，DB残余准备也阻止发行。
- 直接预算预留、启动核验和请求预留不能消费这种准备；它只收窄能力，绝不授予模型/资料/写入权限。
- legacy无Owner契约的policy/grant保留原指纹与原行为，不迁移补Owner授权。
- Owner来源项目和目标任务暂不支持普通物理删除，不以新归档/清缓存机制擦除证据。

typed IPC/preload提供四个入口：读取当前准备、读取历史、只读预览、保存暂停准备。actor固定为主进程`local-user`，未知输入及客户端active/grant/actor/task-link字段拒绝。Jotai按项目/任务主体隔离，保留输入与冲突诊断，编辑清理旧preview/换requestId，历史只读。

## 验证口径

新增BDD覆盖精确版本、依赖闭包、严格输入/身份、非代码模式、资料撤权与不扩张、旧发行/清purpose旁路、未知占额保护、DB ABORT、JSON替换失败证据保全、幂等/损坏/删除/重开，以及IPC零任务/费用/执行计数。UI和Native各自报告证据，不以SSR或Bun/sql.js冒充实际Electron/WAL。

本片全量565文件失败0、typecheck/lint2012/docs/diff/fullbuild通过；Native run a7eebe6b-4416-4d14-853c-7fceefd72096共36项，父核对218源码SHA无差异。三轮审查整改与原始证据保留，记录见台账。真实Provider、生产主导航、安装包、实际费用/远端终止、断电和多进程均不因暂停准备测试自动通过。

## 后续真实发行条件

AO-06另审暂停的权威业务任务落地与exact step关联；关联变化必须新准备修订并再次预览/确认。随后将准确Owner来源gate贯穿派发、预算、claim、Runner、每次模型请求及资料工具，复用既有grant/command/request/stop/recovery。非代码执行适配、价格支持和资料权限不足继续阻塞，不能放宽研发Git规则或借一次规划费用确认偷跑。
