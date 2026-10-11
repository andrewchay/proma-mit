# V02第三批：Goal调用身份接线证据

> 截至2026-10-08 23:25 GMT+8。基线70908394，分支feat/harness-reliability-upgrade。
> 状态：**V02仍部分完成**；没有V01回执生成或V03逐条件完成门禁。
> 本批子契约见goal-run-contract.md。

## 实现

- `GoalCoordinator.captureRun(sessionId)`在实际调用准入后，为当前Goal生成UUID并返回冻结闭包。复用既有activeRunId和Goal JSON/JSONL；不新增另一套Run库。
- 闭包固定goalId/runId，检查点回调不再按session查找“最新Goal”。暂停、取消、新Goal、新run、旧finally、重复提交与结束后的回调均不能重写当前Goal。
- 接收检查点后持久可选`checkpointRunId`并消费activeRunId，标记真实主进程回调的关联，而不是证据真实性。
- 新run清空旧checkpoint投影；JSONL历史保留。无本轮检查点时转waiting，不重放旧continue。
- `AgentOrchestrator`在抢占后签发，在AI SDK/Pi query options中传入同一固定callback；排队、compact-only及抢占前预检不签发。headless和内部队列使用同一边界。
- 新增仅内存槽位token，补充客户端generation，防相同startedAt的旧finally/回调误命中新run。stop接受后旧callback拒绝；不宣称进程已经停止。
- finally先按真实所有权完成Goal对账，再驱动队列。存在用户排队时不插入自动续跑；无新run时仍清理旧权限请求，有新run时旧finally不清理其请求。
- `agent-service.ts`删除无身份的session级检查点/结束接线。自动continuation不再预造run UUID，runner迟到失败/false必须回读版本，不能写回旧快照覆盖已完成或新签发run。

## red / green

1. Coordinator迁移API并加入8个新身份用例后：1 pass、12 fail（captureRun尚不存在；包含迁移旧4例）。实现后13 pass。
2. 修复测试fixture工作区重名后，真实Orchestrator接线red：1 pass、4 fail（未签发/传递闭包）；不是将fixture错误当需求证据。实现后通过。
3. 后续增加迟到runner失败/false、排队continue优先、停止后权限清理用例，并回归相同startedAt下旧finally不清新请求。
4. 最终5个定向文件76 pass、0 fail：Coordinator15，Orchestrator Goal7，既有队列6，研发验证22，V01 parser26。
5. 全仓最终543文件、3612 pass、0 fail、27 skip。九包typecheck、全仓lint1971文件、docs:check、diff检查通过。
6. 全仓回归前后真实workspace目录清单36→36且完全一致，新增0；不读取真实文件内容。测试自己设置临时配置并还原原值，临时目录清理。

日志保留在会话工作台：harness-v02-goal-red.log、harness-v02-goal-green.log、harness-v02-goal-wiring-red.log、harness-v02-goal-wiring.log、harness-v02-goal-targeted.log、harness-v02-goal-full-tests.log、harness-v02-goal-typecheck.log。没有真实Provider或打包验收。

## 可信测试采集：已确认阻塞

`scripts/run-tests.ts`只记录各子进程退出和控制台输出，没有受保护的结构化收集协议。已有研发验证也是命令退出证据。stdout里的PASS、控制台计数、由可写验证进程输出的JUnit/JSON都不能自行变成可信test回执。

缺失的不是一个parser，而是固定的verifier/criteria配置、输出来源与保护边界。本批不新造假的checksCollected，也不填假的toolCallId。因此V03不能接普通命令passed或fresh记录来自动完成；测试类要求仍需可信非零收集，缺失时不能通过。

下一切片应先选择并落实受保护的主进程内建验证器或可信受控测试入口；普通任意命令保留退出证据，不自动升格。来源保护可能依赖后续effects/隔离能力，必须明确支持平台和威胁边界，不能靠增加字符串source或签名字段冒充隔离。

## 保留限制与兼容

- UUID代表本机已准入尝试，不代表Provider请求ID、SDK/toolCallId、实际执行成功或费用。抢占后兼容性/预算预检仍可能失败。
- 尚未冻结实际workspace/channel/resolved model等完整InvocationContext；不能只用Goal配置拼V01完整subject。研发task/execution与AgentGoal的完整映射仍待落实。
- Goal索引与JSONL追加不是原子事务，私有存储仍依赖本机信任。没有解决损坏恢复、运行中重启、持久次数/成本限额或定时唤醒保证。
- `checkpointRunId`只记录回调关联，不使模型evidence可信。旧complete规则保留，收到complete后再停止不会自动撤销已接收状态；不能称为“验证后完成”。
- 新run无检查点时不静默重试，转waiting；这是有意的安全收紧。只有本轮有效continue且可继续时自动调度。
- 老Goal无新字段仍可加载；未将历史completed改为verified，未修改业务验收、交付/交接或决策规则。
- TCC、ACP、新verification默认启用、真实Provider、付费/外部操作均不在本批范围。

## 简化与回滚

统一闭包负责所有runtime身份校验，复用一个字段和已有存储；内部token只管理槽位，不是另一套持久身份源。没有新依赖/any/flag或UI/IPC。无可用code-simplifier Skill，已人工审查共享路径、边界分层与冗余别名。

shared 0.2.31→0.2.32、electron 0.12.114→0.12.115，生成事实同步。README/AGENTS未修改，原工作树/并行资料不碰。回滚时保留Goal日志及新字段，老版本可忽略checkpointRunId；回滚会恢复旧跨run误更新风险，不是安全等价回滚。
