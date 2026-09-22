# Typed Context Compiler 实施台账

> 日期：2026-09-22
> 关联方案：`docs/plans/2026-09-22-typed-context-compiler.md`
> 台账性质：实施控制面；每个工作项必须更新状态、证据和阻塞原因后才能进入下一阶段。
> 状态枚举：`待开始` / `进行中` / `阻塞` / `已完成` / `取消`
> 当前总状态：**M1 已完成；等待开始 M2 Subagent 定向上下文**

## 1. 总体里程碑

| Milestone | 名称 | 目标 | 依赖 | 状态 | 退出证据 |
|---|---|---|---|---|---|
| M0 | 契约与观测基线 | 定义类型、事件 ledger、token/cache/retry 基线，不改执行行为 | 无 | 已完成 | shared tests、ledger/metrics/flag/replay tests、`bun run test` 427 文件通过 |
| M1 | 规则型 Context Projection | 生成确定性、可解释、可回放的上下文视图 | M0 | 已完成 | projector、预算/policy 回归和四类 golden fixtures 通过 |
| M2 | Subagent 定向上下文 | explorer/researcher/code-reviewer 消费 projection，返回 typed result | M1 | 待开始 | 隔离、协议、失败回退和追溯测试 |
| M3 | 评测与对照实验 | 证明成功率、token、重试和证据质量是否改善 | M2 | 待开始 | 5+ cases、每 case 3+ runs、scoreboard |
| M4 | 两层工具能力目录 | 常驻 capability summary，schema 按需加载 | M3 | 待开始 | schema token、权限和工具选择回归 |
| M5 | 可逆 Compaction | 以 projection/view switch 替代不可逆摘要 | M3 | 待开始 | compact boundary、重建和失败不伪造测试 |
| M6 | 可解释成本感知路由 | 把 cache affinity、隐私、能力、重试成本纳入规则路由 | M3、M4、M5 | 待开始 | 路由 reason、privacy allowlist、未知 cache 按 miss |

## 2. 详细工作项

### M0：契约与观测基线

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M0-01 | Shared Context 类型 | `packages/shared/src/context/types.ts`、projection、subtask-result、exports | 无 | 无 `any`；版本字段；JSON 可序列化；shared 不依赖 Electron | `packages/shared/src/context/*`；目标测试和 shared typecheck 通过 | 已完成 |
| M0-02 | Context ledger 存储契约 | ledger/summaries/projections JSONL 格式和 sourceRevision | M0-01 | append-only；重复 source 去重；原文与摘要分离 | `apps/electron/src/main/lib/agent-runtime/context/context-ledger.{ts,test.ts}` | 已完成 |
| M0-03 | Ledger recorder | 从现有 session/tool/artifact 事件生成最小 ContextItem | M0-01、M0-02 | recorder 失败不阻塞 Agent；可关闭；有错误指标 | 转换函数、observer 单测；orchestrator 在显式开关下旁路记录用户输入 | 已完成 |
| M0-04 | 运行指标采集 | provider/model、token estimate、cache capability、duration、retry、failure code | 无 | 不改变调用行为；敏感正文不进入指标 | `context-metrics.{ts,test.ts}`；observer 在 turn start/finish 写入 | 已完成 |
| M0-05 | Replay fixture | 小型探索、工具噪声、文件事实、subtask 事件 fixture | M0-01、M0-02 | 同一 fixture 可生成稳定 ledger/sourceRevision | `fixtures/m0-replay.json` + `context-replay.test.ts` | 已完成 |
| M0-06 | Feature flag 与回退 | workspace/session 级 `typedContextCompiler` 开关 | 无 | 默认关闭；projection/ledger 异常回退 baseline | `context-feature-flag.{ts,test.ts}`；workspace config 和 session meta 接入 | 已完成 |

### M1：规则型 Context Projection

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M1-01 | Projection request 类型落地 | purpose、task、target agent/model、budget、policy | M0-01 | 所有字段有明确默认值与版本 | `context-policy.ts` + projector tests | 已完成 |
| M1-02 | Deterministic projector | required kind、verified evidence、task tag、recency、representation 选择 | M0-02、M1-01 | 同输入 byte-stable；规则可解释 | `context-projector.{ts,test.ts}` | 已完成 |
| M1-03 | Projection renderer | `[FACT]`/`[INFERENCE]`/`[UNVERIFIED]`/`[SUMMARY]` 标记 | M1-02 | summary/full 不无标记重复；输出可审阅 | `context-renderer.ts` + projector tests | 已完成 |
| M1-04 | Budget 与 omission 记录 | token estimate、required item 保留、omittedItemIds | M1-02 | 超预算不丢 required items；省略原因可查 | `context-projector.test.ts` | 已完成 |
| M1-05 | Policy projector | visibility、path allow/deny、tool class、model allowlist | M1-02 | policy 过滤是 fail-closed；无策略绕过 | `context-policy.test.ts` | 已完成 |
| M1-06 | Golden fixtures | full、普通摘要、噪声工具输出、敏感路径四类 projection | M1-03、M1-04、M1-05 | fixture 稳定；变更需显式更新 | `fixtures/m1-projection-golden.json` + golden test | 已完成 |

### M2：Subagent 定向上下文与 typed result

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M2-01 | SubAgentInput 扩展 | projection、resultProtocol、readOnly，保持旧调用兼容 | M1 | 旧调用行为不变；新字段可选 | shared/runtime tests | 待开始 |
| M2-02 | Spawn projection adapter | 在 orchestrator/runtime spawn 边界生成 projection | M1、M2-01 | projection 失败回退 baseline；sourceRevision 关联 | orchestrator tests | 待开始 |
| M2-03 | Read-only 子任务隔离 | 子任务独立 cwd，父工作区不可写 | M2-02 | 写入被拒绝或仅进入隔离目录 | sandbox/workspace tests | 待开始 |
| M2-04 | Typed result parser | claims、artifacts、evidence、confidence、unverified | M0-01、M2-01 | 缺 evidence 的 high claim 自动降级；协议失败为 partial | parser tests | 待开始 |
| M2-05 | Child artifact 持久化 | typed result、原始 session、projection 元数据关联 | M0-02、M2-04 | 可从 result 追溯 child session 和 source items | persistence tests | 待开始 |
| M2-06 | 内置 Agent 试点 | explorer → researcher → code-reviewer 分批接入 | M2-02、M2-04 | 每个 Agent 有明确 requiredKinds 与 result schema | integration tests | 待开始 |
| M2-07 | 父 Agent 消费 typed result | 不自动拼接 child transcript；消费 summary/claims/artifacts | M2-05 | 父 Agent 可引用 evidence；失败状态不伪装完成 | integration tests | 待开始 |

### M3：评测与对照实验

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M3-01 | Benchmark 定义 | `typed-context-compiler` + 5 cases | M2 | case statement/rubric 与被测 Agent 输入隔离 | benchmark files | 待开始 |
| M3-02 | 三组对照 harness | full context / 普通 brief / TCC projection | M3-01 | provider/model/version 固定且可记录 | evaluator run records | 待开始 |
| M3-03 | 质量评分 | success、evidence coverage、false omission/inclusion、human correction | M3-02 | scoreboard 权威保存；不把 skip 记为 pass | scoreboard | 待开始 |
| M3-04 | 成本与稳定性评分 | token、cache、duration、retry、failure | M0-04、M3-02 | provider cache unknown 按 miss；价格来源可追踪 | cost report | 待开始 |
| M3-05 | Gate decision | 决定是否进入 M4/M5 | M3-03、M3-04 | success ≥ baseline 95%；至少一项成本/稳定性改善；evidence ≥90%；false omission ≤5% | signed decision note | 待开始 |

### M4：两层工具能力目录

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M4-01 | Capability descriptor | 工具能力、schemaRef、access、dataClasses、confirmation、parallelSafe | M3-05 | builtin/MCP/workspace tool 可表达 | catalog tests | 待开始 |
| M4-02 | 常驻 summary catalog | 不注入完整 schema，只注入方向性描述 | M4-01 | 未选工具 schema 不进入 prompt | prompt snapshot | 待开始 |
| M4-03 | 按需 schema projection | 选择工具后加载完整 schema | M4-02 | 实际调用仍经 permission service | integration/security tests | 待开始 |
| M4-04 | 工具选择回归 | 对照现有工具选择准确率与 prompt token | M4-03 | 准确率不低于 baseline；token 有可测改善 | benchmark scoreboard | 待开始 |

### M5：可逆 Compaction

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M5-01 | Compact metadata | sourceRevision、policy、保留 item、摘要版本、token estimate | M3-05 | metadata 可持久化、可读取 | compact tests | 待开始 |
| M5-02 | Rebuild view | 从原始 ledger 重建 projection，不删除原始事实 | M5-01 | 重建结果至少等价；可追溯 | replay tests | 待开始 |
| M5-03 | 触发策略 | budget、轮数、retry、熵代理指标 | M5-01 | turn boundary 执行；不做每 turn 全量 scorer | trigger tests | 待开始 |
| M5-04 | Pi 自动压缩接入 | 与现有 compact_boundary 和 `pi/automatic` 审计对齐 | M5-02、M5-03 | 中止/报错/空结果不写成功边界 | Pi regression tests | 待开始 |
| M5-05 | 回退与迁移 | TCC view 失败继续使用旧 compact 路径 | M5-04 | feature flag off 时旧行为不变 | compatibility tests | 待开始 |

### M6：可解释成本感知路由

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M6-01 | Provider capability registry | cache read/write/retention/tool/schema 能力 | M3-05 | 未知字段不假设支持 | registry tests | 待开始 |
| M6-02 | 成本模型 | input/output/cache/retry/latency 参数化 | M6-01 | 价格和 capability 可替换；估算注明来源 | cost model tests | 待开始 |
| M6-03 | Privacy/model policy | 敏感路径、provider allowlist、模型限制 | M1-05、M6-01 | fail-closed；禁止越权路由 | security tests | 待开始 |
| M6-04 | Explainable router | route reason、cache miss fallback、能力不匹配原因 | M6-02、M6-03 | 每次路由可审计；无黑箱默认选择 | router tests | 待开始 |
| M6-05 | 路由评测 | 成本、质量、延迟、重试和隐私回归 | M6-04 | 未通过不自动启用 | routing scoreboard | 待开始 |

## 3. 关键依赖与门禁

```text
M0 → M1 → M2 → M3 ─┬→ M4
                    ├→ M5
                    └→ M6（需 M4/M5 的能力数据）
```

- M0 未完成：不得接入 Agent 执行路径。
- M1 未完成：不得向子 Agent 动态注入 projection。
- M2 未完成：不得启动 TCC benchmark。
- M3 Gate 未通过：不得实现自动 relevance scorer、自动 compaction adoption 或自动 model router。
- M4/M5 未通过：M6 只能做离线成本模型，不能改变线上模型选择。

## 4. 当前风险台账

| 风险 ID | 风险 | 概率 | 影响 | 监测信号 | 缓解 | Owner | 状态 |
|---|---|---:|---:|---|---|---|---|
| R-01 | projection 过滤关键事实 | 中 | 高 | false omission、重复追问、测试失败 | required/evidence 优先；baseline 回退 | Agent | 开放 |
| R-02 | 摘要与原文冲突 | 中 | 高 | 引用错误版本、双版本无标记 | version/source 标记；必要时只给 locator+full | Agent | 开放 |
| R-03 | ledger IO 影响主流程 | 中 | 中 | session 延迟、队列堆积 | async best-effort、大小上限、feature flag | Agent | 开放 |
| R-04 | typed protocol 过度僵化 | 中 | 中 | parser failure、blocked 增多 | 保留 human summary；失败降级 partial | Agent | 开放 |
| R-05 | cache 能力假设错误 | 高 | 中 | 账单与估算偏差 | unknown 按 miss；capability registry | Agent | 开放 |
| R-06 | 子任务越权读写 | 低 | 高 | 安全测试失败、审计越界 | projection policy + permission service 双检查 | Agent | 开放 |
| R-07 | 评测样本偏差 | 中 | 高 | benchmark 改善但线上无改善 | 固定 case + 回归 case + 真实失败采样 | Agent | 开放 |
| R-08 | 范围膨胀 | 高 | 高 | 同时改 router/MCP/compaction | M0-M3 阶段门禁 | Carolwyp/Agent | 开放 |
| R-09 | 自演化错误写回 | 低 | 高 | benchmark score 回退 | 仅冻结 benchmark 严格改善才 adopt，目录快照回滚 | Agent | 开放 |

## 5. 决策台账

| Decision ID | 决策 | 理由 | 影响 | 状态 |
|---|---|---|---|---|
| D-01 | 产品/架构名称采用 Typed Context Compiler | 比 Meta-attention 更稳定，不绑定具体 scorer | 后续文档、代码模块和指标命名统一 | 已建议，待确认 |
| D-02 | 原始 ledger 永不因 projection/compaction 删除 | 保证可回溯、换任务重投影和错误复盘 | 增加存储，需要 retention 策略 | 已建议，待确认 |
| D-03 | 第一落点是 subagent spawn boundary | 任务已知、收益可测、风险小 | M2 优先于全局 compaction | 已建议，待确认 |
| D-04 | 第一版 projector 用确定性规则 | 可解释、可回放、无需 scorer 训练数据 | 自动 relevance scorer 延后至 M3 通过后 | 已建议，待确认 |
| D-05 | child 返回 typed result，不自动 merge transcript | 降低状态合并和幻觉风险 | 需要协议解析和 evidence 模型 | 已建议，待确认 |
| D-06 | 默认 read-only 子任务 | 安全边界清楚，先验证只读协作价值 | 写任务另建显式 artifact/patch 流程 | 已建议，待确认 |
| D-07 | 未知 cache affinity 按 miss 估算 | 不把 provider 行为假设当事实 | 路由可能保守但可解释 | 已建议，待确认 |
| D-08 | 不修改两份 AGENTS.md | 当前未授权维护项目地图和工作区规则 | 方案只引用其约束，不自动写入 | 已生效 |

## 6. 实施记录模板

每次执行一个工作项后填写：

```markdown
### [ID] [日期]
- 状态：待开始 / 进行中 / 阻塞 / 已完成 / 取消
- 实际变更：
- 测试命令：
- 测试结果：
- 证据文件：
- 风险变化：
- 回滚方式：
- 下一步：
```

## 7. 实施记录

### M0-01 / M0-02 / M0-03（2026-09-22）
- 状态：已完成。
- 实际变更：新增 shared context/projection/subtask-result 协议；新增 append-only JSONL ledger，将原文和 summary 分离保存；支持从 tool、session message、artifact 构造最小 ContextItem；新增默认关闭的 `ContextLedgerObserver`，并在 orchestrator 的所有 runtime 分支之前旁路记录工作区会话的用户输入。Ledger I/O 错误只告警，不影响 Agent 流程。
- 测试命令：`bun test packages/shared/src/context/types.test.ts apps/electron/src/main/lib/agent-runtime/context/context-ledger.test.ts apps/electron/src/main/lib/agent-runtime/context/context-observer.test.ts`；`bun run typecheck`；`bun run docs:check`；`bun run test`。
- 测试结果：目标测试 11 pass / 0 fail；全仓 typecheck 通过；docs check 通过；正式隔离测试 `bun run test`：427 文件 / 0 失败。
- 测试隔离结论：裸 `bun test` 会让跨文件 `mock.module`、`globalThis.fetch`、`PROMA_TEST_CONFIG_DIR` 和模块级单例互相污染，出现 39 个假失败；`scripts/run-tests.ts` 已按文件启用独立子进程和独立配置目录，故正式全量门禁必须使用 `bun run test`。方案已据此修订。
- 证据文件：`packages/shared/src/context/`、`apps/electron/src/main/lib/agent-runtime/context/context-{ledger,observer}.{ts,test.ts}`、`apps/electron/src/main/lib/agent-orchestrator.ts`、本台账。
- 风险变化：R-03（ledger IO）仍开放，但 observer 默认关闭且异常隔离，当前不改变模型输入、工具调用、会话 JSONL 或执行结果。
- 回滚方式：删除新增 context 模块与 package export；原始 session JSONL 未改。
- 下一步：开始 M1-01 的 deterministic projection request/defaults 与 projector 设计。

### M0-04 / M0-05 / M0-06（2026-09-22）
- 状态：已完成。
- 实际变更：新增无正文 `metrics.jsonl` 指标契约；显式记录 cache 状态，未知时固定为 `unknown`。开启 TCC 时，Claude、Proma、AI SDK、Pi runtime 均在 turn start/finish 旁路写入 provider/model、输入 token 估算、duration 和通用失败码。新增稳定 replay fixture，sourceRevision 不再依赖随机 item ID。工作区 `config.json` 与 `AgentSessionMeta` 均支持 `typedContextCompiler`；session 显式值优先，缺省 fail-closed。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/context-{ledger,observer,metrics,feature-flag,replay}.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 14 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：431 文件 / 0 失败。
- 证据文件：`context-metrics.{ts,test.ts}`、`context-feature-flag.{ts,test.ts}`、`fixtures/m0-replay.json`、`agent-orchestrator.ts`、`agent-workspace-manager.ts`、`agent-session-manager.ts`。
- 风险变化：R-03 降低。Metric 与 ledger 都是默认关闭、无正文、best-effort 旁路；失败不会阻断 baseline。retry 与 output token 在未被 runtime 提供时保持缺省，不伪造数值。
- 回滚方式：关闭 workspace/session flag 即停止观测；删除 `context/metrics.jsonl` 不影响原始会话 JSONL。
- 下一步：M1-01 deterministic projector。

### M1-01 / M1-02 / M1-03（2026-09-22）
- 状态：已完成。
- 实际变更：新增 request 默认化与 fail-closed policy；deterministic projector 按 required kind、task tag、verified evidence、confidence、更新时间排序，采用 summary/full/locator 单一 representation，预算不足时保留 required item 并记录 omitted IDs。renderer 输出 `[FACT]`、`[INFERENCE]`、`[UNVERIFIED]`、`[SUMMARY]` 标记。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/context-projector.test.ts`；`bun run typecheck`。
- 测试结果：4 pass / 0 fail；全仓 typecheck 通过。
- 证据文件：`context-policy.ts`、`context-projector.ts`、`context-renderer.ts`、`context-projector.test.ts`。
- 风险变化：R-01/R-02 仍开放；当前仅是纯函数编译器，尚未接入 subagent spawn 或主 Agent prompt。
- 回滚方式：删除新增 projector/policy/renderer；M0 ledger 与现有 Agent 执行路径不受影响。
- 下一步：M1-04 budget omission 细化、M1-05 policy 组合回归、M1-06 golden fixtures。

### M1-04 / M1-05 / M1-06（2026-09-22）
- 状态：已完成。
- 实际变更：Projection 契约增加结构化 `omissions`；预算裁剪会保留 required kind，并给每个被省略 item 写入 token 或 policy 原因。path allow/deny 与 model allowlist fail-closed，deny 优先。新增四类 golden fixture：full、summary、tool noise、sensitive path。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/context-{projector,policy,projection-golden}.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 10 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：434 文件 / 0 失败。
- 证据文件：`context-policy.{ts,test.ts}`、`context-projector.{ts,test.ts}`、`fixtures/m1-projection-golden.json`、`context-projection-golden.test.ts`。
- 风险变化：R-01/R-02 降低。省略和 policy 过滤现在均可追溯，但尚未把 projection 注入 Agent/subagent。
- 回滚方式：纯函数模块无运行时调用点，可整体删除，不影响现有 Agent 行为。
- 下一步：M2-01 Spawn 输入扩展。

## 8. 当前下一步

1. 开始 M2-01：扩展 SubAgentInput 的 projection/resultProtocol/readOnly，保持旧调用兼容。
2. 每完成一个 milestone 更新本台账，并在 M3 形成是否继续的门禁结论。
