# Harness Reliability：首批契约与源码审计

> 截至：2026-10-08 21:44 GMT+8 用户授权开始实施后的首批。
> 基线：`6c71b384`；分支：`feat/harness-reliability-upgrade`。
> 本文冻结 **V01共享DTO切片**。V02权威服务、V03完成门禁、工具调度及新策略配置未实现；本文不替代其后续设计评审。
> 代码实现：`packages/shared/src/types/verification.ts`、`packages/shared/src/utils/verification.ts`。
> 下文为首批审计/契约历史快照；第二批已补V02部分新鲜度与回读，当前范围和保留限制见`v02-evidence.md`，不把历史“未实现”当成最新状态。

## 1. H00：身份与证据来源

| 对象 | 权威入口 | 关联方式 | 本升级禁止的推断 |
|---|---|---|---|
| AgentGoal | `goal-runtime/goal-coordinator.ts`、`goal-store.ts` | id + sessionId；runtime为proma/pi/ai-sdk；checkpoint和activeRunId | activeRunId目前只在续跑路径生成，不能假定每次调用都已经有runId |
| 长生命周期Goal | `goal-service.ts`；`packages/shared/src/types/goal.ts` | 独立Goal id、todo、gate、scope、quota | 不用标题/名称与AgentGoal自动合并 |
| 业务Task/Execution | `project-sqlite-store.ts`；`packages/shared/src/types/work-module.ts` | project/task/entity/execution/session明确ID | 不将模型结束自动换成业务验收，不用最近同名任务绑定 |
| Deliverable | `project-chain-service.ts`；`project-chain.ts` | taskId、版本、executionId、responsibilities、冻结decision/DoD | 不复用旧版本人工验收；技术passed不变成accepted/handed_off |
| 研发快照 | `development-snapshot-service.ts` | executionId、workspaceId、baseCommit、contentHash、逐文件hash | Git HEAD不足以代表dirty/untracked；不复制现有内容存储 |
| 研发验证 | `development-validation-service.ts` | taskId、executionId、snapshotContentHash、白名单command、实际exit/timeout | outputTail只用于诊断；旧passed不能静默变成V01新鲜可信回执 |
| 确认应用 | `development-apply-service.ts` | accepted delivery、snapshot、原仓库revision和逐文件hash | 不能用新验证DTO绕过local-user验收或prepare/confirm |

### 1.1 已证实的复用点与缺口（源码层）

- 快照服务覆盖相对基线的已提交、暂存、未暂存及允许的未跟踪文件；拒绝范围外/受保护/二进制/符号链接/超限内容，内容先写、清单后写。
- 验证服务只接受任务verificationCommands白名单，运行前后比对快照文件，采集真实退出码，timeout/stale不同于passed。
- **不能直接沿用其新鲜度结论**：`worktreeMatchesSnapshot()` 当前跳过delete条目，仅枚举原快照文件，未证明验证期间新增文件/重新出现的删除文件也被核验；后续V02需完整变化集和范围指纹。
- 验证服务目前退出0即可passed；未采集测试数/criteriaId/verifier配置版本，不能证明非零测试收集与逐条件覆盖。
- `GoalCoordinator`的complete只检查evidence非空；`immediateCounts`为内存Map，应用重启后的持久上限是V04待补内容。
- `GoalStore.save()`先写索引再append事件，不能宣称两者跨写入原子；损坏索引读取回退空数组。受控完成与恢复不能把空视图解释为“没有待执行副作用”。此处未修改旧行为。

## 2. H01：schema与执行路径

| Runtime/边界 | 模型schema路径 | 执行门禁 | 本轮结论 |
|---|---|---|---|
| AI SDK | `ai-sdk-agent-adapter.ts`合并createCoreTools/MCP等 → `ai-sdk-runtime-core.ts#createAISDKTools` → streamText tools | executeRuntimeTool、canUseTool及既有Plan/AskUser/Goal分支 | 全目录接线可定位；待选为首个独立discovery候选，不代表已支持截断先验阻断 |
| Pi | `pi-agent-adapter.ts` → `pi-tool-bridge.ts#createPiToolBridge`；传入customTools | 桥调用权限回调；无回调默认拒绝；GoalCheckpoint/AskUser有专用控制面路径；controlled上下文收紧 | 后续工具目录/调度需要覆盖桥、SDK内建工具与扩展，不能只过滤一个列表 |
| Claude SDK（软下线） | `claude-agent-adapter.ts`交SDK query；MCP/SDK工具为SDK所有 | canUseTool回调，safe语义由应用兜底 | `agent-runtime-retirement.test.ts`固定claude/proma禁止新选用，仍识别历史值；未证明应用可延迟SDK内建schema或阻断截断调用，不恢复此路径 |
| proma | `provider-agnostic-agent-adapter.ts`注册core/MCP/runtimeTools，构建模型schema | executeSingleToolCall和canUseTool；部分控制面串行，其余Promise.all | 仍有源码实现，不等于当前可新建生产Runtime；后续依正式retirement检查，不为本升级恢复 |
| Shared catalog | `context/capability.ts`、`capability-summary.ts`、`capability-schema-projection.ts` | projection只解析schema，不授予执行权 | 已有模块，复用不重做；历史实验结果不作为本升级默认开启依据 |

- `CapabilityDescriptor.parallelSafe`是元数据；未表达路径/资源键，不能单独用于冲突锁。
- 原ProviderAgnostic执行路径的非控制面工具含Write/Bash并行；源码发现仅记录风险，不在首批强行修改retired路径。
- schema预算包括常驻元数据、核心schema与动态schema；计算缓存、schema更新和失效必须同工具身份绑定。
- AskUser/Goal/Plan是已有控制面特例。新的统一策略必须保留其交互流程，不能制造重复提问或旁路业务完成。
- TCC开关仍为`sessionEnabled ?? workspaceEnabled ?? false`；M3-07关闭决定不变。本轮没有新增/修改任何运行feature flag。

## 3. V01：冻结的技术DTO

### 3.1 Subject

`workspaceId + sessionId + runId + agentGoalId`必须全部非空。业务任务存在时`projectId + taskId + executionId`三项同时存在；独立AgentGoal三项全部省略。

- expectedSubject由主进程的权威调用上下文提供，不能从回执/model prompt中回填。
- 顶层subject、artifact.subject和expectedSubject逐字段严格一致，optional身份也不能缺失/多出。
- runId是技术调用身份，不是自动创建第二套Execution；V02需实现/复用主进程可信生成和持久关联。
- 此版本仅服务coding AgentGoal。没有AgentGoal的业务执行不会偷偷生成Goal来适配DTO。

### 3.2 ArtifactRevision

`version=1`、artifactId、subject、baseRevision（40/64位小写hex Git revision）、contentHash、scopeHash（64位小写hex）、capturedAt、evidenceRef。

- artifactId/contentHash以已有冻结快照为来源；scopeHash另从规范化允许范围与配置派生。
- capturedAt不得晚于验证开始或当前时钟。它是捕获时间，不是“当前产物没变”的证明。
- evidenceRef是私有记录定位，不是可任意读取的文件路径或下载授权。
- 不支持Git以外artifact类型；非代码任务需版本化的独立扩展，不猜测兼容。

### 3.3 Receipt

`version=1`、receiptId、subject、criteriaId、verifier（id/version/configHash/kind）、artifact、toolCallId、startedAt/finishedAt、exitCode、result、checksCollected、evidenceRef、source。

- result只接受passed/failed/unknown/skipped，没有accepted或completed。
- source只接受main-process，但只是格式声明，**不是真实性证明**。
- passed须exitCode=0；test类passed必须checksCollected为正安全整数；command允许收集数null。
- failed/unknown/skipped可保留null退出码/收集数；不自动转换为成功。
- 验证器配置必须来自权威scope/用户确认，不能由Agent更换成空命令。configHash绑定配置，不证明配置被授权。
- 时间为不晚于注入now的非负安全整数；捕获≤开始≤结束≤now。
- 未知版本、额外字段、空必需字段、不匹配身份或无效hash失败。没有隐式legacy升级。

### 3.4 Parser语义

`parseVerificationReceipt`与`parseVerificationArtifactRevision`返回 `{ok:true,value}` 或 `{ok:false,errors}`，不写磁盘、不访问网络、不读取用户配置、不修改目标对象。

- JSON独立副本避免输入引用被后续改写；结果并非不可变签名对象。
- parser成功只证明结构和已提供身份/时间的一致性。
- parser不核验当前产物、主进程真实创建来源、command是否被授权、criteria是否满足、日志是否真实或回执是否被重放。
- **任何模型都能伪造格式合法的DTO。** V02必须回读权威运行来源与最新产物，V03只能消费该服务结果。
- 类型导出位于shared/types，纯解析函数导出于shared/utils，顶层shared按既有出口转导出；不引入Node/Electron依赖。

## 4. 首批存储和发布决定

- 首批只加入共享DTO与纯解析器，无持久化、无数据库表、无新配置，无任何Runtime调用方。
- 后续优先引用原`development-snapshot-*`与`development-validation-*`私有记录。不再保存第二份产物内容。
- 新回执映射若需要JSONL，必须先证明运行ID/原证据/criteria配置的权威关系和原子性/恢复策略；本批尚未批准具体新增落点。
- 已有completed/validation passed保持旧格式读取，不补造可信新回执，UI接线后应显示legacy/unverified。
- 完成门禁、修复续跑、策略限制和并发调度仍未接线，本批不改变任何线上状态。

## 5. 未关闭的M0决策

| 问题 | 当前范围内决定 | 后续关闭条件 |
|---|---|---|
| 首个生产Runtime | AI SDK为候选；未接线 | H03先验完整调用/副作用边界证据，再冻结D03 |
| 验证配置所有者 | 沿现有task scope白名单/已批准配置，不允许Agent自改 | V02/V03明确criteria ID/config hash更新与授权入口 |
| 全量变化集与scope hash | 复用快照基础，补前/后完整集合比对 | V02针对新增/删除重现/外部修改/symlink的BDD |
| 回执权威落点 | 只冻结DTO，不新增真相源 | V02存储合同及故障矩阵评审 |
| 新flags/观测 | 首批没有flag和生产埋点 | H03默认off兼容性及独立无正文指标方案 |
| 跨session锁域 | 未决定 | E02/E05明确进程/workspace/session边界 |
| 人工误拒处理 | 不提供绕过技术verified路径 | V03/V05设计override留证且不伪造passed |
| 真实调用/ACP | 未授权、不开启 | 单独预算/用途/版本授权 |

H00/H01源码审计完成；H02只冻结本DTO切片，完整策略/存储仍待补；H03完整观测与无行为基线未完成。不得据此宣称G0或M0全通过。

## 6. 简化与边界审查

本轮没有安装/调用code-simplifier（当前可用Skills无此项），做了人工等价审查：类型与纯utils分离；subject校验复用；无重复catalog/存储/状态；无any、新依赖或运行flags。新增普通JSON对象校验的red/green测试，防止原型继承字段在校验后JSON克隆丢失。解析结构成功仍不授予信任，不以全仓绿灯夸大生产保证。后续V02优先闭合权威来源与完整变化集，再接完成门禁。
