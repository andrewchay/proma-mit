# E03第八批：AI SDK结果消息批次观察接线证据

> 截至2026-10-09 10:23 GMT+8；基线15439d40。承接tool-call-integrity-{contract,evidence}.md。
> E03仍部分：只做AI SDK观察记录，未实现零执行保证、Pi接线或调度消费。

## 落地

- shared判定词表扩展：AI SDK快照映射后的`end_turn`/`tool_use`也计为完整finishReason（快照经core `toDoneStopReason`映射，原`stop`/`tool-calls`不再原样出现）。未知/大小写不符仍不完整。
- `SDKResultMessage`新增可选`toolCallBatchIntegrity`观察字段；runtime-core `runAgentTurn`用新导出`assessStepsToolCallBatchIntegrity(steps)`逐step判定（原因码带`step_N:`前缀）后随结果持久化进JSONL。字段注释与契约一致：仅事实记录，不表示零执行或可撤销。
- 接线只读快照（id/name/finishReason），不改审批、权限、重试或自动续跑路径。`unexecutedMandatory`仍恒false；本runtime无自动续跑分支可拒绝，现有overflow重放已被attemptHadLiveEvents禁止，未新增虚假"拒绝"。

## 验证

- shared新增end_turn/tool_use正反用例后14pass；main新增`ai-sdk-batch-integrity.test.ts`4例（多step编号原因、空名/重复、空快照不伪造不完整、result消息携带观察且不影响既有消息构建）。初次green中发现一个测试标题与断言不符（"空step…unknown"实际断言complete=true），已改为如实描述"无快照不伪造不完整，也不冒充Provider确认"。
- 定向5文件93pass/0fail（含上一批integrity/effects/resources/capability）；全仓549文件3717pass/0fail/27skip；九包typecheck、lint1981文件、docs:check与diff检查通过。
- 回归前后真实workspace目录名36→36一致、新增0。日志私有harness-wiring-*.log位于会话工作台。统计不构成可信测试回执。

## 保留限制

- 观察仅来自快照可见数据；core快照不携带invalid标记，AI SDK层invalid调用仍以错误part呈现，当前分类无法看到invalid原因（保持上批结论：AI SDK不能宣称零执行支持）。截断(`length`)可由快照finishReason观察到。
- 持久化字段没有受保护来源，可被本机写入伪造；不解决V03。无调度/锁消费方读取该字段；Pi路径未接线未核验。
- 无TCC、真实Provider、付费、发布、build/package/native强停；README/AGENTS与原主工作树未动。

## 版本与简化

shared0.2.35→0.2.36、electron0.12.119→0.12.120，facts同步。改动集中于一个纯函数+一个可选字段的接线；无新依赖/flags/并行。可回滚为无字段旧结果消息（老读者忽略未知字段），保留shared词表扩展亦无害。
