# Typed Context Compiler 实施台账

> 日期：2026-09-22
> 关联方案：`docs/plans/2026-09-22-typed-context-compiler.md`
> 台账性质：实施控制面；每个工作项必须更新状态、证据和阻塞原因后才能进入下一阶段。
> 状态枚举：`待开始` / `进行中` / `阻塞` / `已完成` / `取消`
> 当前总状态：**M0–M6 工程项全部完成并验收；TCC 运行与生产接入保持关闭；剩余阻塞项均为需单独授权的真实运行验证。**

## 1. 总体里程碑

| Milestone | 名称 | 目标 | 依赖 | 状态 | 退出证据 |
|---|---|---|---|---|---|
| M0 | 契约与观测基线 | 定义类型、事件 ledger、token/cache/retry 基线，不改执行行为 | 无 | 已完成 | shared tests、ledger/metrics/flag/replay tests、`bun run test` 427 文件通过 |
| M1 | 规则型 Context Projection | 生成确定性、可解释、可回放的上下文视图 | M0 | 已完成 | projector、预算/policy 回归和四类 golden fixtures 通过 |
| M2 | Subagent 定向上下文 | explorer/researcher/code-reviewer 消费 projection，返回 typed result | M1 | 已完成 | feature-gated projection、只读隔离、typed result 与私有 artifact 回溯已完成 |
| M3 | 评测与对照实验 | 证明成功率、token、重试和证据质量是否改善 | M2 | 已完成（冻结门禁通过，仅获 opt-in 试点资格） | 首轮 synthetic 短样本未通过（input −14.3%）；代表性长上下文真实 spawn 评测 90 次后 input −84.4%、success 0.80 == baseline、evidence 0.96，门禁通过；但 output +109.8%、时长 ×2.7、协议失败率 30%，默认仍关闭 |
| M4 | 两层工具能力目录 | 常驻 capability summary，schema 按需加载 | M3 | 进行中 | M4-01–03 已完成；M4-04 离线 token 回归已完成，真实模型选择准确率回归被 provider 实验关闭决定阻塞 |
| M5 | 可逆 Compaction | 以 projection/view switch 替代不可逆摘要 | M3 | 已完成（模块与测试落地；生产接入保持关闭） | metadata 持久化往返、ledger 重建 byte-stable、触发阈值、边界守卫（中止/报错/空结果不伪造成功）、回退链路测试全绿 |
| M6 | 可解释成本感知路由 | 把 cache affinity、隐私、能力、重试成本纳入规则路由 | M3、M4、M5 | 已完成（离线；线上模型选择未改变） | provider 能力登记、参数化成本模型（unknown cache 按 miss）、fail-closed policy、可解释 router、离线路由评测报告全绿 |

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
| M2-01 | SubAgentInput 扩展 | projection、resultProtocol、readOnly，保持旧调用兼容 | M1 | 旧调用行为不变；新字段可选 | `subagent-context-options.{ts,test.ts}` | 已完成 |
| M2-02 | Spawn projection adapter | 在 orchestrator/runtime spawn 边界生成 projection | M1、M2-01 | projection 失败回退 baseline；sourceRevision 关联 | `subagent-projection-adapter.test.ts` | 已完成 |
| M2-03 | Read-only 子任务隔离 | 子任务独立 cwd，父工作区不可写 | M2-02 | 写入被拒绝或仅进入隔离目录 | `subagent-readonly-workspace.test.ts`、Runtime safe-mode tests | 已完成 |
| M2-04 | Typed result parser | claims、artifacts、evidence、confidence、unverified | M0-01、M2-01 | 缺 evidence 的 high claim 自动降级；协议失败为 partial | `subtask-result-parser.test.ts` | 已完成 |
| M2-05 | Child artifact 持久化 | typed result、原始 session、projection 元数据关联 | M0-02、M2-04 | 可从 result 追溯 child session 和 source items | `subtask-artifact-store.test.ts` | 已完成 |
| M2-06 | 内置 Agent 试点 | explorer → researcher → code-reviewer 分批接入 | M2-02、M2-04 | 每个 Agent 有明确 requiredKinds 与 result schema | `builtin-subagent-context-policy.test.ts` | 已完成 |
| M2-07 | 父 Agent 消费 typed result | 不自动拼接 child transcript；消费 summary/claims/artifacts | M2-05 | 父 Agent 可引用 evidence；失败状态不伪装完成 | `subtask-result-parser.test.ts` | 已完成 |
| M2-08 | spawn 决策链集成验收 | flag → 内置 policy → projection → 只读隔离 → typed handoff → 私有产物 | M2-01…M2-07 | 真实 ledger/projector/parser/artifact store 贯通；flag 默认关闭；fail-closed 回退不半隔离 | `subagent-spawn-plan.ts`、`tcc-m2-integration.test.ts` | 已完成 |

### M3：评测与对照实验

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M3-01 | Benchmark 定义 | `typed-context-compiler` + 10 fixed cases | M2 | case statement/rubric 与被测 Agent 输入隔离 | `fixtures/m3-typed-context-compiler-benchmark.json` | 已完成 |
| M3-02 | 三组对照 harness | full context / 普通 brief / TCC projection | M3-01 | provider/model/version 固定且可记录 | `tcc-experiment.ts`、`tcc-experiment-runner.ts` | 已完成 |
| M3-03 | 质量评分 | success、evidence coverage、false omission/inclusion、human correction | M3-02 | scoreboard 权威保存；不把 skip 记为 pass | `tcc-experiment.ts`、`tcc-m3-glm-scoreboard.json`（私有） | 已完成 |
| M3-04 | 成本与稳定性评分 | token、cache、duration、retry、failure | M0-04、M3-02 | provider cache unknown 按 miss；价格来源可追踪 | `tcc-experiment.ts`、`tcc-m3-glm-scoreboard.json`（私有） | 已完成 |
| M3-05 | Gate decision | 决定是否进入 M4/M5 | M3-03、M3-04 | success ≥ baseline 95%；至少一项成本/稳定性改善；evidence ≥90%；false omission ≤5% | workspace-private scoreboard | 已完成（代表性评测通过）：TCC 24/30 成功（= baseline 0.80）、evidence 96%、input −84.4%、私密项 0 泄漏；代价为 output +109.8%、时长 ×2.7 |
| M3-06 | 实验关闭决定 | 停止继续实验，TCC 永久保持关闭 | M3-05 | 不再发起真实 provider 调用；默认路径无 TCC | 本文件「M3-07 关闭决定」 | 已完成（用户决定） |

### M4：两层工具能力目录

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M4-01 | Capability descriptor | 工具能力、schemaRef、access、dataClasses、confirmation、parallelSafe | M3-05 | builtin/MCP/workspace tool 可表达 | catalog tests | 已完成 |
| M4-02 | 常驻 summary catalog | 不注入完整 schema，只注入方向性描述 | M4-01 | 未选工具 schema 不进入 prompt | `capability-summary.test.ts` golden snapshot | 已完成 |
| M4-03 | 按需 schema projection | 选择工具后加载完整 schema | M4-02 | 实际调用仍经 permission service | `capability-schema-projection.integration.test.ts`（safe 拒写/auto 需审批） | 已完成 |
| M4-04 | 工具选择回归 | 对照现有工具选择准确率与 prompt token | M4-03 | 准确率不低于 baseline；token 有可测改善 | `capability-token-benchmark.test.ts`（离线） | 部分完成（阻塞）：token 回归已过；准确率回归需真实模型调用，与「不做 provider 实验」冲突，需单独授权 |

### M5：可逆 Compaction

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M5-01 | Compact metadata | sourceRevision、policy、保留 item、摘要版本、token estimate | M3-05 | metadata 可持久化、可读取 | `compaction-metadata.test.ts` | 已完成 |
| M5-02 | Rebuild view | 从原始 ledger 重建 projection，不删除原始事实 | M5-01 | 重建结果至少等价；可追溯 | `compaction-rebuild.test.ts` | 已完成 |
| M5-03 | 触发策略 | budget、轮数、retry、熵代理指标 | M5-01 | turn boundary 执行；不做每 turn 全量 scorer | `compaction-trigger.test.ts` | 已完成 |
| M5-04 | Pi 自动压缩接入 | 与现有 compact_boundary 和 `pi/automatic` 审计对齐 | M5-02、M5-03 | 中止/报错/空结果不写成功边界 | `compaction-boundary-policy.test.ts`；生产 Pi 路径未改动 | 已完成（契约与测试固化） |
| M5-05 | 回退与迁移 | TCC view 失败继续使用旧 compact 路径 | M5-04 | feature flag off 时旧行为不变 | `compaction-fallback.test.ts` | 已完成 |

### M6：可解释成本感知路由

| ID | 工作项 | 产出/范围 | 依赖 | 验收标准 | 证据位置 | 状态 |
|---|---|---|---|---|---|---|
| M6-01 | Provider capability registry | cache read/write/retention/tool/schema 能力 | M3-05 | 未知字段不假设支持 | `provider-cost-capability.test.ts` | 已完成 |
| M6-02 | 成本模型 | input/output/cache/retry/latency 参数化 | M6-01 | 价格和 capability 可替换；估算注明来源 | `cost-model.test.ts` | 已完成 |
| M6-03 | Privacy/model policy | 敏感路径、provider allowlist、模型限制 | M1-05、M6-01 | fail-closed；禁止越权路由 | `routing-policy.test.ts` | 已完成 |
| M6-04 | Explainable router | route reason、cache miss fallback、能力不匹配原因 | M6-02、M6-03 | 每次路由可审计；无黑箱默认选择 | `explainable-router.test.ts` | 已完成 |
| M6-05 | 路由评测 | 成本、质量、延迟、重试和隐私回归 | M6-04 | 未通过不自动启用 | `routing-benchmark.test.ts`（离线） | 已完成（离线）；真实流量质量/延迟回归需单独授权 |

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
- M3 已通过冻结门禁，但用户决定关闭 TCC 运行与后续真实实验：M4–M6 可继续作为独立工程里程碑实施，但不得静默开启 TCC、恢复 provider 实验或改变线上默认行为。

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
| D-01 | 产品/架构名称采用 Typed Context Compiler | 比 Meta-attention 更稳定，不绑定具体 scorer | 后续文档、代码模块和指标命名统一 | 已生效（M0–M3 实施采用） |
| D-02 | 原始 ledger 永不因 projection/compaction 删除 | 保证可回溯、换任务重投影和错误复盘 | 增加存储，需要 retention 策略 | 已生效（M5-02 重建测试固化不可变性） |
| D-03 | 第一落点是 subagent spawn boundary | 任务已知、收益可测、风险小 | M2 优先于全局 compaction | 已生效（M2-02/M2-08 落地） |
| D-04 | 第一版 projector 用确定性规则 | 可解释、可回放、无需 scorer 训练数据 | 自动 relevance scorer 延后至 M3 通过后 | 已生效（M1 落地；M3 后仍不启用自动 scorer） |
| D-05 | child 返回 typed result，不自动 merge transcript | 降低状态合并和幻觉风险 | 需要协议解析和 evidence 模型 | 已生效（M2-04/02-07 落地） |
| D-06 | 默认 read-only 子任务 | 安全边界清楚，先验证只读协作价值 | 写任务另建显式 artifact/patch 流程 | 已生效（M2-03/M2-08 落地） |
| D-07 | 未知 cache affinity 按 miss 估算 | 不把 provider 行为假设当事实 | 路由可能保守但可解释 | 已生效（M6-01/02 落地） |
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

### M2-01（2026-09-22）
- 状态：已完成。
- 实际变更：扩展 `SubAgentInput.context` 为可选 `SubAgentContextOptions`，包含 `projection`、`resultProtocol` 与 `readOnly`。默认解析器维持旧调用的 plain-text/non-TCC 行为；显式 projection 则默认 typed-v1 与 readOnly。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subagent-context-options.test.ts`；`bun run typecheck`。
- 测试结果：3 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：435 文件 / 0 失败。
- 证据文件：`agent-runtime/types.ts`、`context/subagent-context-options.{ts,test.ts}`。
- 风险变化：无运行时调用点，因此不改变现有 Agent 或权限行为。
- 回滚方式：移除可选字段和纯函数即可恢复先前契约。
- 下一步：M2-02 在 provider-agnostic spawn 边界消费显式 projection，并保证失败回退 baseline。

### M2-02（2026-09-22）
- 状态：已完成。
- 实际变更：新增纯函数 spawn projection adapter；只有 workspace/session feature flag 与 `SubAgentInput.context.projection` 同时开启时，才从父 session 的私有 ledger 编译 projection，向 child prompt 注入 `[FACT]` 等已渲染 block、`projectionId` 与 `sourceRevision`。request 的 session、purpose、task 和 target agent 都由父边界覆写，拒绝调用方借此读取其他 session。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subagent-projection-adapter.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 4 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：436 文件 / 0 失败。
- 证据文件：`context/subagent-projection-adapter.{ts,test.ts}`、`agent-orchestrator.ts`。
- 风险变化：M2 projection 默认关闭；缺少 workspace 或读取/编译异常返回空 suffix 并使用原 prompt，保持 baseline。
- 回滚方式：移除 orchestrator 的 adapter 调用；adapter 本身无写入和无持久化副作用。
- 下一步：M2-03 read-only child cwd 与写入隔离。

### M2-03（2026-09-22）
- 状态：已完成。
- 实际变更：仅当 TCC projection 成功且 context options 要求 read-only 时，spawn 边界为子任务创建私有 session cwd，忽略调用方提供的 cwd；同时强制子 Runtime 使用 `safe` 权限模式，因此 Runtime 会在调用前拒绝 Bash、Write、Edit 和非安全 MCP 等副作用工具。投影未启用或失败时继续使用原始 cwd 和父权限，不改变既有委派或评测沙箱行为。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subagent-readonly-workspace.test.ts apps/electron/src/main/lib/agent-runtime/context/subagent-projection-adapter.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 6 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：437 文件 / 0 失败。
- 证据文件：`context/subagent-readonly-workspace.{ts,test.ts}`、`agent-orchestrator.ts`、`agent-runtime/ai-sdk-runtime-core.test.ts`。
- 风险变化：此隔离是 Runtime 工具边界，不声称提供内核级沙箱；safe 模式拒绝 Bash，文件工具又受 cwd path resolver 约束，避免以相对/绝对路径写回父工作区。
- 回滚方式：移除只读 cwd 选择和 safe-mode 覆写即可回到 M2-02 的 baseline 行为。
- 下一步：M2-04 解析 typed `SubtaskResult`，在 evidence 缺失时下调高置信 claim。

### M2-04（2026-09-22）
- 状态：已完成。
- 实际变更：新增 typed-v1 结果解析器与协议提示。解析器总是由父 taskId 覆写 child 自报 ID；合格 evidence-backed claim 原样保留；无 evidence 的 high claim 自动降级为 medium、置为未验证并写入 `unverified`；JSON 缺失、格式错误或必填协议字段无效时生成 `partial` 结果，不抛出并不采纳 claims/artifacts。成功 projection 的 typed-v1 spawn 会收到末尾 JSON 代码块协议提示。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subtask-result-parser.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 4 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：438 文件 / 0 失败。
- 证据文件：`context/subtask-result-parser.{ts,test.ts}`、`agent-orchestrator.ts`。
- 风险变化：此阶段仅准备和解析协议，尚不持久化或替换父 Agent 的文本消费；协议失败保留为显式 partial，而不是声明任务完成。
- 回滚方式：移除 typed-v1 prompt suffix 和纯解析器即可恢复 M2-03 的原始文本返回。
- 下一步：M2-05 持久化 child typed result、原始 child session 和 projection 元数据。

### M2-05（2026-09-22）
- 状态：已完成。
- 实际变更：成功 projection 的 typed-v1 子任务结束后，best-effort 追加原始 SDK messages 到 child session JSONL，并在工作区私有 `context/subtasks/` 写入 append-safe child artifact。记录保留 raw response、解析后的 `SubtaskResult`、child/parent session ID、原任务、projection ID/source revision 及 selected source item IDs。存储失败只记录日志，保持原始文本返回和 Agent 执行行为不变。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subtask-artifact-store.test.ts apps/electron/src/main/lib/agent-runtime/context/subtask-result-parser.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 6 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：439 文件 / 0 失败。
- 证据文件：`context/subtask-artifact-store.{ts,test.ts}`、`context/subtask-result-parser.ts`、`agent-orchestrator.ts`。
- 风险变化：子任务产物只在显式 projection + typed-v1 时写入工作区私有目录；原始 transcript 不自动拼接回父 Agent。持久化是旁路，失败不升级为执行失败。
- 回滚方式：移除 spawn 完成后的 best-effort 保存块与 artifact store，即可恢复 M2-04 行为。
- 下一步：M2-06 将 explorer、researcher、code-reviewer 分批显式接入 projection policy 与 result schema。

### M2-06（2026-09-22）
- 状态：已完成。
- 实际变更：新增内置 Agent TCC policy resolver。feature flag 开启且调用方未显式传 context 时，仅 explorer、researcher、code-reviewer 获得各自明确的 requiredKinds、token 预算与 fail-closed evidence/visibility policy，并统一采用 typed-v1 与 read-only。调用方显式 context 优先；开关关闭、非试点内置 Agent 与自定义 Agent 均保留 plain-text baseline。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/builtin-subagent-context-policy.test.ts apps/electron/src/main/lib/agent-runtime/context/subagent-projection-adapter.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 7 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：440 文件 / 0 失败。
- 证据文件：`context/builtin-subagent-context-policy.{ts,test.ts}`、`agent-orchestrator.ts`。
- 风险变化：默认 feature flag 仍为关闭；试点策略不会覆盖调用方显式 projection 或 plain-text 要求，且对其他 Agent 没有运行时改变。
- 回滚方式：移除 policy resolver 的调用即可让所有未显式 context 的内置 Agent 回到 baseline。
- 下一步：M2-07 让父 Agent 仅消费 typed result 的 summary/claims/artifacts，禁止自动拼接 child transcript。

### M3-01 / M3-02 / M3-03 / M3-04（2026-09-22）
- 状态：已完成；benchmark、真实 delegate 与两轮真实评测均已产出，最终结果见 M3-06/M3-07 与代表性评测决定文档。
- 实际变更：冻结 10 个覆盖探索、噪声、敏感路径、证据、预算、模型 policy、只读隔离和 typed handoff 的固定 case；每 case 必须有 full-context、brief、TCC projection 三组各至少 3 次运行。新增可审计的 scorecard 汇总，记录 provider/model/implementation version、token、cache、duration、retry、selected items 与 claim evidence；unknown cache 不扣减 input tokens。缺 run、skip、缺 runtime identity、evidence coverage 不足、false omission 超限或无成本/稳定性改善时 fail-closed。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/tcc-experiment.test.ts`；`bun run typecheck`。
- 测试结果：目标测试 4 pass / 0 fail；全仓 typecheck、docs check 通过；全量隔离测试 `bun run test`：441 文件 / 0 失败。
- 证据文件：`context/tcc-experiment.{ts,test.ts}`、`context/fixtures/m3-typed-context-compiler-benchmark.json`。
- 风险变化：R-07 保持开放。当前是离线 gate/harness，不能将构造测试数据视为真实 provider benchmark 成绩；TCC 默认仍关闭。
- 回滚方式：删除 M3 experiment 模块和 fixture，不影响 M0-M2 运行时路径。
- 下一步：M3 已收束，不再发起 TCC provider 实验；进入 M4-01。

### M3-06 真实 spawn 评测修正（2026-09-22）
- 状态：已完成；真实矩阵已通过正式路径完成，后续不再发起 TCC provider 实验。
- 实际变更：
  1. 首次真实评测走的是仓库外临时脚本，协议提示与 typed-v1 parser 不同源，导致大量返回被判为协议失败，白耗授权调用额度。现已改为仓库内正式入口 `scripts/run-tcc-spawn-eval.ts` + `tcc-spawn-eval-harness.ts`，并强制三重保护：离线 preflight（协议同源、必需项在内、私密项不泄漏、token 节省 ≥ 20%）、授权调用数不小于矩阵规模、逐次落盘可续跑。
  2. TCC 组不再直接调用 projector，而是经 `prepareSubAgentProjectionFromItems()` 走与生产完全相同的 spawn 边界。
  3. 发现并修复真实缺陷：`ProviderAgnosticAgentAdapter` 始终注入 `createCoreTools()`，因此 `runtimeTools: []` 并不能让评测看不到工具；模型改为发起 `tool_use`，在 `maxTurns: 1` 下一轮内拿不到结论。新增 `disableTools` 选项（默认关闭，行为不变），评测显式启用。
  4. 修复 token 计量：只累加 `input_tokens` 会把 14k 上下文虚报为 15 token（其余走 cache_read），现按 `input_tokens + cache_read + cache_creation` 计入。
  5. `extractJsonObject` 增加「最后一个配平顶层对象」回退，兼容模型在 JSON 前后附加解释文字；协议字段校验不放松。
- 测试命令：`bun run typecheck`；`bun run test`；`bun run --filter '@gravitas/electron' build:tcc-eval`。
- 测试结果：全量隔离测试 446 文件 / 0 失败；typecheck 通过；在真实 Electron 运行时验证了 preflight 与授权护栏（未通过时在发起任何模型调用前退出）。
- 真实调用消耗：修正前临时脚本 90 次（第一次授权，已消耗）；修正后首次尝试 19 次（因上述工具缺陷作废）；诊断探针 9 次。合计在第二次授权内已用 28/90。
- 结论：首轮 M3 因 synthetic 短样本不推广的结论已被 M3-07 取代。代表性评测（真正走生产 spawn 边界）中冻结门禁输出 `passed: true`（无 reason），因此 TCC 获得 **opt-in 试点资格，默认仍关闭**。代价与边界：output token +109.8%、时长 ×2.7、整体协议失败率 30%（full 基线自身也有 20%）、评测因 `disableTools` 不覆盖带读工具的子 Agent 端到端行为。详见 `docs/plans/2026-09-22-typed-context-compiler-m3-representative-decision.md`。
- 结论：代表性评测已由正式路径完成并记录在本 ledger 与决定文档中；M3-07 已明确 TCC 运行与实验关闭。M4–M6 仍按本 ledger 作为独立工程里程碑推进，但不得恢复 TCC provider 实验或线上默认路径。
- 回滚方式：删除 `tcc-spawn-eval-harness.ts`、`tcc-spawn-real-delegate.ts`、`scripts/run-tcc-spawn-eval.ts` 及其测试，并移除 `disableTools` 选项，即可移除这套评测入口。

### M3-07 关闭决定（2026-09-22）
- 状态：已完成，由用户决定。
- 决定：**TCC 关闭，不再做实验。** 不再为 TCC 发起任何真实 provider 调用；不再新增评测样本、探针或对照运行。
- 代码状态：默认路径已无 TCC。feature flag 默认 false（`sessionEnabled ?? workspaceEnabled ?? false`），内置 Agent 仅在 flag 开启时才获得 projection，非试点 Agent 永远保持 plain-text baseline。M2-08 验收测试已固定这些事实，防止后续改动静默打开。
- 保留内容：M0–M2 的账本、投影、只读隔离、typed handoff 与私有产物均在位且已被集成验收覆盖，可在未来需要时重新评估；M3 的评测基础设施（fixture、harness、gate）同样保留，但不再运行。
- 不再推进的范围：TCC 运行、TCC provider 实验、自动 relevance scorer 与任何默认开启路径。M4 两层工具能力目录、M5 可逆 compaction、M6 成本感知路由仍按本 ledger 继续，但必须作为独立里程碑验收，不得借此重新开启 TCC。
- 依据：代表性评测虽通过冻结门禁，但代价为 output token +109.8%、时长 ×2.7、整体协议失败率 30%，投入产出不值得继续投入工程时间。

### M4-01（2026-09-22）
- 状态：已完成。
- 实际变更：在 `packages/shared/src/context/capability.ts` 新增版本化 `CapabilityDescriptor` 与 `CapabilityCatalog`，覆盖 builtin/MCP/workspace source、schemaRef、access、dataClasses、confirmation、parallelSafe；catalog 按稳定 id 去重并返回防御性副本。完整 schema 不进入 descriptor，为 M4-02/03 按需加载保留边界。
- 测试命令：`bun test packages/shared/src/context/capability.test.ts`；`bun run typecheck`。
- 测试结果：目标测试 5 pass / 0 fail；全仓 typecheck 通过。
- 证据文件：`packages/shared/src/context/capability.ts`、`capability.test.ts`、`context/index.ts`。
- 风险变化：descriptor 校验对未知 source/access/data class、MCP 缺 server identity 和错误版本 fail-closed；不改变 TCC flag 或任何线上工具注册行为。
- 回滚方式：移除 capability export、descriptor 模块与测试即可；现有工具执行和权限路径不受影响。
- 下一步：M4-02 常驻 summary catalog；不得把 catalog 自动注入现有 Agent prompt。

### M4-02（2026-09-22）
- 状态：已完成。
- 实际变更：新增 `capability-summary.ts`：`renderCapabilitySummary()` 从 catalog 产出确定性、按 id 排序、与注册顺序无关的方向性摘要（名称、来源、server、access、dataClasses、confirmation、parallelSafe）。不携带参数 schema，也不出现 schemaRef 正文；空 catalog 输出合法空块。
- 测试命令：`bun test packages/shared/src/context/capability-summary.test.ts`。
- 测试结果：3 pass / 0 fail（含 golden snapshot 与 schema 泄漏负向断言）。
- 证据文件：`packages/shared/src/context/capability-summary.ts`、`capability-summary.test.ts`。
- 风险变化：纯渲染函数，无运行时调用点；未接入任何 Agent prompt。
- 回滚方式：删除模块、export 与测试即可。
- 下一步：M4-03 按需 schema projection。

### M4-03（2026-09-22）
- 状态：已完成。
- 实际变更：新增 `capability-schema-projection.ts`：只对选中的 capability 解析完整 schema；未知 id 与 resolver 异常 fail-closed 为可审计的 omission，不假装能力可用。集成测试（electron）验证投影产出的工具名走与 builtin 完全相同的 permission service 链路：safe 模式拒写、auto 模式写入产生 pending 审批请求且 `respondToPermission(deny)` 生效。
- 测试命令：`bun test packages/shared/src/context/capability-schema-projection.test.ts`；`bun test apps/electron/src/main/lib/agent-runtime/context/capability-schema-projection.integration.test.ts`。
- 测试结果：纯函数 2 pass；集成 2 pass / 0 fail。
- 证据文件：`capability-schema-projection.{ts,test.ts}`、`apps/electron/.../capability-schema-projection.integration.test.ts`。
- 风险变化：投影层无执行能力，权限语义未被削弱；未改变线上工具注入行为。
- 回滚方式：删除模块、export 与测试即可。
- 下一步：M4-04 工具选择回归（离线部分）。

### M4-04（2026-09-22，部分完成）
- 状态：离线 token 回归已完成；真实模型选择准确率回归阻塞。
- 实际变更：新增 `capability-token-benchmark.ts`：对同一 catalog 对比「全部 schema 进 prompt」与「summary + 选中 schema」的 token 估算，产出确定性 scoreboard。测试证明：选中子集时节省约 55%（fixture 相关）、估算与 summary+选中 schema 逐字等价、全选时 summary 成为纯开销（节省率 ≤ 0，即两层目录只对子集有收益）、同输入结果稳定。
- 测试命令：`bun test packages/shared/src/context/capability-token-benchmark.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：4 pass / 0 fail；全量隔离测试通过。
- 证据文件：`capability-token-benchmark.{ts,test.ts}`。
- 风险变化：纯离线估算，无 provider 调用；token 估算沿用 chars/4 口径，不代表真实计费 token。
- 2026-09-23 更新：用户单独授权真实运行验证。新增 `tool-selection-{fixture,experiment}.ts` 与正式入口 `scripts/run-capability-eval.ts`（授权数硬校验、逐次落盘）。真实矩阵 10 cases × 2 variants × 3 runs = 60 次（zhipu glm-5.3-flash）全部完成：full_schema 30/30 正确（avg input 2,540 tokens）、summary_on_demand 30/30 正确（avg input 1,914 tokens）。**门禁通过：准确率持平 100% ≥ baseline，prompt token −24.6%**，逐次记录在私有 cap-eval scoreboard。
- 回滚方式：删除模块、export 与测试即可。
- 下一步：M4-04 已收束；M5 不依赖该结论，可独立开始。

### M5-01…M5-05（2026-09-22）
- 状态：已完成（工程模块与验收测试；生产接入保持关闭）。
- 实际变更：
  1. M5-01：shared 新增 `CompactMetadata` 契约（version、sourceRevision、policyId、retained/omitted itemIds、summaryVersion、tokenEstimate、createdAt），序列化/解析严格校验 fail-closed；policyId 为键序无关的 sha256 指纹。
  2. M5-02：`compaction-rebuild.ts` 从原始 ledger 经生产 projector 重建视图；只读消费不改写原始事实，同输入 byte-stable，ledger revision 变更使视图失效。
  3. M5-03：`compaction-trigger.ts` 只做 budget/轮数/retry 廉价阈值判断，供 turn boundary 调用，无每 turn scorer。
  4. M5-04：`compaction-boundary-policy.ts` 固化「中止/报错/空结果/缺摘要不写成功边界」契约，audit 口径对齐 `pi/automatic`；生产 Pi 路径未改动。
  5. M5-05：`compaction-fallback.ts` 统一回退语义——flag 关闭、view 抛错或为空时走旧 compact 路径并记录原因。
- 测试命令：`bun test packages/shared/src/context/compaction-metadata.test.ts`；`bun test apps/electron/src/main/lib/agent-runtime/context/compaction-{rebuild,trigger,boundary-policy,fallback}.test.ts`。
- 测试结果：2+3+4+3+3 = 15 pass / 0 fail；全仓 typecheck 通过。
- 证据文件：`packages/shared/src/context/compaction-metadata.{ts,test.ts}`、`apps/electron/.../context/compaction-{rebuild,trigger,boundary-policy,fallback}.{ts,test.ts}`。
- 风险变化：重建与回退都是纯函数/旁路模块，无运行时调用点；原始 ledger 不可变性有测试固化。
- 回滚方式：删除新增模块、export 与测试即可。
- 下一步：M6-01…05。

### M6-01…M6-05（2026-09-22）
- 状态：已完成（离线；线上模型选择未改变）。
- 实际变更：
  1. M6-01：`provider-cost-capability.ts` 只登记已验证 provider（anthropic/openai/deepseek/zhipu，含证据说明）；未登记 provider 一律返回 unknown 保守默认。
  2. M6-02：`cost-model.ts` 参数化计价（input/output/cache read/write/retry），价格来源必填；unknown/unsupported cache 的 cache tokens 按全价 input 计入并写入 assumptions。
  3. M6-03：`routing-policy.ts` fail-closed——allowlist 为空全拒；敏感数据只能去能力已验证 provider。
  4. M6-04：`explainable-router.ts` 按 policy 过滤 → 成本估算 → 最低价胜出（平局取输入顺序）；每次选择/拒绝都带 reason，unknown cache 假设进入决策理由。
  5. M6-05：`routing-benchmark.ts` 离线对比可解释路由与朴素 baseline（首个候选），输出成本、隐私违规数、决策可解释性；`autoEnabled` 固定为 false。
- 测试命令：`bun test packages/shared/src/context/{provider-cost-capability,cost-model,routing-policy,explainable-router,routing-benchmark}.test.ts`。
- 测试结果：2+6+4+4+2 = 18 pass / 0 fail；全仓 typecheck 通过。
- 证据文件：上述 `packages/shared/src/context/*.{ts,test.ts}` 与 `context/index.ts`。
- 风险变化：全部为离线纯函数，无运行时调用点，不改变线上模型选择或 provider 行为；价格 fixture 仅用于测试，真实计费须注入带来源的价格表。
- 阻塞与边界：真实流量下的质量/延迟回归需要 provider 调用，与「不做 provider 实验」决定冲突，需用户单独授权。
- 回滚方式：删除新增模块、export 与测试即可。
- 下一步：M0–M6 工程项全部收束；等待用户决定是否授权真实运行验证。

### M2-07（2026-09-22）
- 状态：已完成。
- 实际变更：typed-v1 spawn 将原始 child response 解析为 `SubtaskResult` 后，父 Agent 只接收格式化的状态、summary、claims（含 evidence）、artifacts、unverified 与 recommended next steps；raw child transcript 仅保留在 M2-05 的工作区私有 artifact，不再自动注入父 Agent。plain-text 调用仍返回原始文本。
- 测试命令：`bun test apps/electron/src/main/lib/agent-runtime/context/subtask-result-parser.test.ts`；`bun run typecheck`；`bun run test`。
- 测试结果：目标测试 5 pass / 0 fail；全仓 typecheck 通过；全量隔离测试 `bun run test`：440 文件 / 0 失败。
- 证据文件：`context/subtask-result-parser.{ts,test.ts}`、`agent-orchestrator.ts`。
- 风险变化：协议异常也以 partial typed handoff 返回，明确列出未验证项，避免 child 自由文本被父 Agent 当作已验证事实；非 typed 调用不受影响。
- 回滚方式：让 spawn 直接返回 raw response 即可恢复 M2-06 的回传行为。
- 下一步：完成 M2 集成验收，随后进入 M3 的 projection 对照评测与门禁。

## 8. 当前下一步

1. TCC 运行与真实实验保持关闭；后续改动不得静默开启 TCC（由 M2-08 验收测试守护）。
2. M0–M6 的工程模块与验收测试已全部落地；生产接入（TCC view、summary catalog 注入 prompt、线上路由）全部保持关闭，启用任何一项都需要单独决策与验收。
3. 剩余阻塞项均为真实运行验证：M4-04 工具选择准确率回归、M6-05 真实流量质量/延迟回归，均需用户单独授权 provider 调用。
