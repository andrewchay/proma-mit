# Laminar (LMNR) → Proma 设计借鉴评估（2026-08）

> 目标：**不是引入 Laminar 平台**，而是把它的好设计抽象成可迁移的设计要素，用设计驱动 Proma 自身迭代进化。

## 一、Laminar 到底是什么

`lmnr-ai/lmnr`（Laminar，Apache-2.0，YC S24，3.1k⭐）是一个 **为 AI Agent 而生的开源可观测性平台**。Rust 核心、Postgres 存储、自带 Web UI。核心能力：

| 能力 | 说明 |
|---|---|
| Tracing | OpenTelemetry-native，一行代码自动追踪 Vercel AI SDK、LangChain、OpenAI、Anthropic、Gemini、Browser Use、Stagehand |
| Signals | 用自然语言描述 agent 行为（如"卡在循环里"），系统在每个 run 检测并在 Slack 提醒 |
| Evals | 可扩展 SDK + CLI 跑评估（本地/CI/CD），UI 对比结果 |
| MCP / CLI | coding agent 用 SQL 查 traces/spans/metrics/events，直接调试 |
| Dashboards | 基于 trace/metrics 的自定义 SQL 看板 |
| Datasets | 数据标注、数据集构建，供 evals 使用 |
| 性能 | Rust、20x trace 压缩、gRPC exporter、实时 span 全文本搜索 |

## 二、把它拆成可迁移的设计要素

Laminar 表面是可观测平台，真正好的不是 Postgres/Rust，而是 **5 个设计思想**：

| # | 设计思想 | 本质 | 对 Proma 的迁移价值 |
|---|---|---|---|
| D1 | Traces 是一等公民 | 一次 agent 运行做成可展开的树：HTTP → task → provider → tool/MCP → child task，每层含 input/output/latency/cost | 高——让"一次任务"从黑盒变成可回看的因果链 |
| D2 | Signals = 自然语言监控 | 不用写监控规则，用"人话"描述要盯的行为，系统自动检测并推送 | 非常高——降低门槛，契合 Proma natural-language-first |
| D3 | coding agent 用 SQL/MCP 查 trace | Agent 自己查 trace 调试，而非人看 UI | 高——自调试闭环 |
| D4 | Evals 与 data 打通 | 追踪到的真实数据直接变成 evals 数据集 | 中高——让测试/审计数据活起来 |
| D5 | Dashboards 自定义 SQL | 看板不是写死图表，而是可查询的数据层呈现 | 中，Proma 已有效能看板 |

**不值得学的（反着看）**：
- ❌ 集中式观测平台 = 又一个数据孤岛，违背 Proma local-first。
- ❌ 为普适而过度抽象；Proma 应做贴身的、懂自己语义的观测。

## 三、对照 Proma 现状：缺口在哪

Proma 底子很好，**缺的是"把数据组织成可观察的因果链"和"让用户/AI 能消费它"的设计层，而非数据采集本身**：

| 现有能力 | 现状 | 与 Laminar 的差距 |
|---|---|---|
| `metrics.ts` | 仅 aggregate（运行数/token/cost） | 无逐层 span、无 latency/per-tool |
| `audit.ts` | 已预留 `trace_id` 字段但**未闭环** | trace 链路未打通，audit 是扁平事件流而非树 |
| usage ledger / budget / rate-limit | 成本侧完整 | 未关联到"这一次运行"的上下文 |
| AI 员工 / 效能看板 | 有任务级 aggregate 看板 | 缺"单次任务下钻到每个工具调用"的层级 |
| Proactive Center（monitor） | 已有自然的 monitor 概念 | 与运行链路的联动未打通 |

**核心洞察**：
> Proma 已采集所有数据，但它们是"扁平的统计"，而非"有结构的运行档案"。Laminar 教会最关键的一点——**一次 agent 运行 = 一个可展开、可下钻、可复跑、可回放的第一等对象**。

## 四、迭代路线（按价值/成本排序，独立可落地）

### 🔹 P-I：trace_id 闭环 + 「运行档案」View（最优先）
- 前置：`audit.ts` 已预留 `trace_id`，是现成地基。
- 贯穿 `task_id → trace_id`，让一次 run 的 audit/usage/provider 调用可被 `trace_id` 聚合成树。
- Web 工作台（P6-1/P6-2）给任务加"运行档案" tab，可展开：
  ```
  Run #1234 (task)
  ├─ input/output 摘要
  ├─ tool: Bash          ← latency, exit code, artifact, cost, token
  ├─ tool: MCP-Feishu
  └─ child task
  ```
- 存 Proma 自有 Postgres 表 `proma_runtime_spans`。**用自研 structured span，不引 OTel 依赖。**
- 呼应 `docs/server-web-remaining-todo.md` P8-2 "OpenTelemetry traces：HTTP→task→provider→tool/MCP" 的**本地路径版本**。

### 🔹 P-II：Signals 用"人话"，装进 Proactive Center
- 复用 natural-language-first + 已有自动化/桥接。用户描述"agent 连续 3 次调用同一工具失败就提醒我"，底层翻译成可执行监测谓词作用在 span 树上（失败率/循环/成本/stale）。
- 命中后走已有飞书/钉钉桥接或 Proactive Today 呈现。
- **比 Laminar 先进**：用 Proma 自己的自动化引擎 + 自己的 span 数据 = 自闭环 Signals，不依赖外部平台。

### 🔹 P-III：让 Proma 的 Agent 自己"查档案"调试
- 把运行档案暴露成只读工具/MCP（`run.query`/`run.span`/`run.search`）。
- Agent 失败后自查 traceId，看每个工具干了什么、卡在哪，自我复盘，甚至结合 memory 沉淀教训。
- 契合 AI 员工"无人值守 + 心跳 + 回写结果"的产品线：失败溯源不再靠人翻 audit。

### 🔹 P-IV：让 evals/数据集"活"起来
- 用 span 里真实 input/output 采样成 datasets（复用 memory、feedback-synthesis 的 Skill 思路）。
- 与 Proma 测试体系（metrics.test.ts / real-e2e.test.ts / Playwright）挂钩，形成"追踪→评估→再追踪"飞轮。**最不急**。

## 五、一句话总结

> Laminar 最值得 Proma 学的不是平台，而是三个设计：**把"一次运行"变成可下钻的第一等对象（P-I）、用自然语言定义监测信号（P-II）、让 Agent 自己读运行档案做调试（P-III）**。Proma 有 audit.trace_id 地基、Proactive Center、自动化桥接，几乎每个外部能力都能映射到已有底层。真正要做的是把采集到的数据"结构化并闭环"，形成自己的运行档案层。

## 六、决策记录

- 2026-08-04 确定：不引入 Laminar 平台；只借设计，用 Proma 自有能力迭代。
- 顺序：先 P-I（地基）→ P-II/III → P-IV。

## 七、P-I 实施记录（2026-08-04）

P-I（trace_id 闭环 + Runtime Span 运行档案层）已完成，交付如下：

| 文件 | 职责 |
|---|---|
| `packages/shared/src/types/runtime-span.ts`（新增） | span 数据契约：`RuntimeSpan`（kind=task/provider/tool/subtask，traceId/taskId/parentSpanId/spanId/status/meta）、`RuntimeSpanSink`（begin/end） |
| `packages/shared/src/utils/agent-runtime-web-server.ts`（改） | `AgentRuntimeWebAgentTurnInput` 增加可选 `spanSink` + `traceId`，保持 runner 纯函数可测、不直接依赖 Postgres |
| `apps/server/src/spans.ts`（新增） | `PostgresRuntimeSpanStore`：建表 `proma_runtime_spans`（PRIMARY KEY tenant/user/trace/span），提供 begin/end/listTask(**按 taskId 组装为嵌套树**) |
| `apps/server/src/runtime.ts`（改） | provider span + tool span 埋点：进入 begin provider span（结束写 token meta）；tool_start/result/error 配对成 tool span，并继承 provider 作为 parent → 形成 provider→tool 树；错误路径统一 end(status=error) |
| `apps/server/src/app.ts`（改） | 装配真实 sink；new `GET /agent/traces?taskId=`（operator/admin/security-auditor）返回嵌套 span 树；`initialize()` 建表 |
| `apps/server/src/spans.test.ts`（新增） | 5 个单测：schema、begin/end 树、provider→tool 嵌套、多根、begin 不落完整负载 |

**关键设计取舍**：span 表只落轻量 meta（token/exitCode/截断错误），不存完整 prompt/output；原始内容仍由 event hub 承载（SSE 可重放）。`trace_id` 字段已预置，P-I 阶段以 taskId 作稳定 key，为 P-II/III 与 HTTP trace 贯穿留口。

**验证**：项目全量 typecheck 通过；spans 5 个单测 + metrics/audit/billing 共 14 tests 全过；服务端真实 Provider 矩阵测试为**既有失败**（clean checkout 同样失败，与本次改动无关）。

**后续**：P-II 自然语言 Signals（装进 Proactive Center）；P-III Agent 自查 span（只读工具/MCP）；P-IV evals/datasets 飞轮。

## 八、P-II 实施记录（2026-08-04）

P-II（自然语言 Signals，基于 span 树的确定性监测）已完成，交付如下：

| 文件 | 职责 |
|---|---|
| `apps/server/src/spans.ts`（改） | 跨 task 窗口查询：`querySpansInWindow` / `countErrorsInWindow` / `toolFailureRuns`（P-II 检测依赖） |
| `apps/server/src/signals.ts`（新增） | `Signal`/`SignalMatcher`/`SignalHit` 类型 + `PostgresSignalStore`（表 `proma_runtime_signals` + `proma_runtime_signal_hits`，含 listScopes/listEnabled/markChecked/appendHit/listHits） |
| `apps/server/src/signal-scan.ts`（新增） | `SignalScanner`（evaluate 各 matcher + scan 落 hit）+ `PostgresSignalDataSource`（task 失败率/成本/stale 查询） |
| `apps/server/src/app.ts`（改） | 装配 store+scanner+DataSource；新增 `GET/POST /agent/signals`、`DELETE /agent/signals/{id}`、`GET /agent/signals/hits`；`initialize` 建表 + `startSignalScanner`（30s 周期），shutdown 停；命中可选 `reportAlert({kind:'signal_hit'})` |
| `apps/server/src/operations.ts`（改） | OperationalAlert kind 增加 `'signal_hit'` |
| `apps/server/src/signals.test.ts`（新增） | 10 个单测：5 种 matcher 命中/不命中、scan 落 hit+推进 lastCheckedAt、store schema |

**5 种 SignalMatcher（确定性 SQL 判定，不跑 per-run LLM）**：`task_failure_rate`、`tool_repeat_failure`（循环/卡死检测）、`task_cost_threshold`、`stale_task`（复用 recovery 逻辑）、`provider_error`。

**验证**：项目全量 typecheck 通过；biome 无问题；server 55 tests 过（含新增 10 个 signal 测试）；唯一失败仍是既有的 provider 矩阵测试（与 P-II 无关）。

**说明**：P-II 刻意不碰 `packages/shared`（当时有并行会话在改 Goal/Token），所有类型都放在 server 本地。

**后续**：P-III Agent 自查 span（只读 MCP/工具）；P-IV evals/datasets；桌面/Web 端 Signal 列表呈现（数据层+API 已就绪，UI 见 P6-3）。
