# V02第四批：已准备请求上下文的接线证据

> 截至2026-10-09 07:35 GMT+8；基线72793fb5。子契约见invocation-context-contract.md。
> V02仍部分完成，V03仍阻塞。不将请求元数据当Provider确认或测试回执。

## 实现

- 复用早期captureRun闭包，新加仅主进程可调用的onPrepared。异步初始化后不按session重新查找另一Goal。
- 新shared AgentGoalPreparedRequest/InvocationContext与可选Goal.invocationContext。workspace/cwd/runtime/channel/provider/requestedModelId取自已解析、实际构造的query参数；Goal/session/run与时间由闭包填入。
- AI SDK/proma与Pi均在adapter.query前准备。Pi记录resolvedModelId（含会话回退），不使用原始缺失输入来猜模型。workspace必须来自已解析对象，未知保持缺失。
- nonce、状态及capture时Goal配置必须仍一致。配置明确指定workspace/channel/model时必须相等，runtime必须相等；未知模型不能匹配已配置模型。未指定字段不新增固定配置。
- 准备单次消费、保存独立值副本；未准备不得提交检查点。准备后Goal配置或保存的context变化，检查点拒绝；有效continue之后发生变化，结束对账转waiting而非自动续跑。
- 新run清空旧context投影，历史JSONL保留。投影白名单不包含API Key、prompt、headers或输出，不能由额外字段替换sourcePhase。
- actual query前再次同步校验内部槽位所有权，关闭await准备间隙停止后的迟到启动窗口。该校验也保护无Goal/compact分支，不改变其Goal签发规则；不证明已经运行的进程被杀死。

## 行为与工程证据

1. 13个新Coordinator请求用例先red：0 pass/13 fail（缺准备API或未准备仍接受）。实现后13 pass，再补全部六类配置漂移、敏感额外字段与continue后漂移，最终25 pass。
2. 接线red为2 pass/10 fail，覆盖已有nonce用例因缺准备失败、新参数投影和跨环境用例。不将fixture问题当通过：初次green错误地期待sendMessage返回，实际拒绝会抛错；改为assert rejects后通过。
3. 额外竞争回归：移除两个query前同步所有权检查，在离线adapter中12 pass/2 fail；恢复后14 pass。两失败正是AI SDK/Pi准备后停止仍进入query，未调用真实Provider。
4. 最终四个定向文件60 pass/0 fail：Coordinator15、Invocation Context25、真实Orchestrator离线接线14、既有队列6。
5. 最终全仓544文件3644 pass/0 fail/27 skip；九包typecheck、lint1972文件、docs:check、diff检查通过。初次typecheck发现ProviderType漏导入与queryOptions.cwd可选类型问题，已修正；不隐去过程失败。
6. 完整回归前后真实workspace目录名清单36→36、完全一致、新增0；未读取真实配置文件内容。测试临时配置清理并还原环境。

私有日志：harness-context-red.log、harness-context-green.log、harness-context-wiring-red.log、harness-context-late-query-red.log、harness-context-targeted.log、harness-context-full-tests.log、harness-context-typecheck.log，位于本会话工作台。工程回归不替代14-case整体、G0–G4、真实Provider或生产验收。

## 保留限制

- sourcePhase固定prepared-request：可能query未发出、失败或Provider另行路由。没有Provider确认模型/请求ID、费用、SDK/toolCallId或外部回执。
- 只冻结Goal配置与本次请求元数据，不检测运行期间workspace根路径、channel端点/凭据等独立配置的全部变更；撤权与effects治理仍待后续落实。
- 不解决task/execution映射、criteria/verifier配置、可信非零测试收集或私有证据来源保护。不能拿这份context拼一张假的V01完整回执。
- Goal存储索引/JSONL非原子，仍依赖本机私有文件信任。保存记录与闭包比对只是完整性检查，不是签名认证。
- 旧Goal可加载；旧complete规则和业务验收不变。收到complete之后不自动撤销；仍可能存在“模型声明完成”，不能标作verified。
- 运行在不同环境的现有Goal会拒绝，应停止旧Goal并按新配置创建；不会静默替换其授权配置。
- 没有TCC/ACP、真实Provider、付费、外部发布或新verification默认开启。没有build/package/native强停验收。

## 简化、版本与回滚

共享同一readCurrent配置检查和槽位所有权函数，复用已有Goal存储。仅新增小型请求DTO与一次准备回调，不建新Run库、工具、UI/IPC、依赖或flags。无code-simplifier Skill，已人工审查配置对比与两runtime路径重复性。

shared 0.2.32→0.2.33、electron 0.12.115→0.12.116，生成事实同步。未改README/AGENTS或原主工作树。回滚可保留新optional字段与JSONL，老版忽略；但会恢复跨环境和迟到query风险，不是安全等价回滚。
