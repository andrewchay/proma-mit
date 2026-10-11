# E03第六批：调用批次完整性判定证据

> 截至2026-10-09 10:14 GMT+8；基线b3a6ca40。见tool-call-integrity-contract.md。
> E03整体仍部分：纯shared判定，未接线AI SDK/Pi，未接入审批或调度。

## SDK能力核验（ai@7.0.31）

- `streamText`在同一stream内执行工具，execute回调先于整批结果可见；宿主没有"截断则零执行mutation"的先验gate，`prepareStep`/`activeTools`只影响请求侧。E03的"不完整批次零执行"只能在支持该语义的协议上声明；AI SDK路径当前不能宣称支持，只能事后分类+拒绝继续自动续跑。
- `StepResult.toolCalls`可含invalid的dynamic调用（invalid标记+error），finishReason含length/error/content-filter/other。识别截断/无效调用可行，但已执行效果不可撤销。

## 落地

shared context/tool-call-integrity.ts：ObservedToolCall（toolCallId/toolName/invalid/dynamic）与version1 ToolCallBatchIntegrity（complete/reasons稳定码/unexecutedMandatory恒false）。finishReason缺失、未知字符串或大小写不符按unknown→不完整；length/error/content-filter/other不完整；tool-calls/stop完整。malformed（非record/继承/getter/额外字段/dynamic类型错误）记malformed_tool_call。重复/空id、空/空白toolName、invalid调用各自独立原因码。原因码不含参数/输出正文；返回值是普通对象，不是回执、权限或撤销声明。

## 验证

- red：模块缺失，加载失败（0pass/1fail/1error），未把行为用例虚报为全红。
- 初次green有一处自引用断言`expect(batch).not.toBe(batch)`为无效fixture断言失败；改为等值重算断言后13pass。另有dynamic类型字面量需显式unknown断言的fixture类型错误。过程错误如实记录。
- 最终13例；定向9文件89pass/0fail（含effects/resources/capability回归）。全仓548文件3712pass/0fail/27skip；九包typecheck、lint1980文件、docs:check与diff检查通过。
- 回归前后真实workspace目录名清单36→36完全一致、新增0；未读取真实配置文件内容。本批纯函数测试不写配置；日志私有harness-integrity-*.log位于会话工作台。

## 保留限制

- 不接线生产：AI SDK/Pi调用点未消费该判定，没有改变现有执行/重试/审批路径。判定基于宿主可见数据，不能认证Provider行为或防止流式部分执行；"已执行不可撤销"仍是事实。
- Pi tool-call批次语义未核验，本批不声明Pi支持。unexecutedMandatory保留未用；零执行保证、错误释放锁、重试策略、调度接线均未实现。
- 不解决V03受保护verifier/可信非零测试收集；V02仍部分。无TCC、真实Provider、付费、发布、build/package/native强停；README/AGENTS与原主工作树未动。

## 版本与简化

shared0.2.34→0.2.35、electron0.12.118→0.12.119（facts同步；electron版本随facts/工作区一致性统一递增，未改其代码）。无新依赖、无并行、无生产caller；判定模块可独立回滚，不影响现有执行路径。无code-simplifier Skill，已人工审查原因码稳定性与普通数据检查。
