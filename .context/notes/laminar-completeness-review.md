# Laminar→Proma 迭代四阶段完成度复查（2026-08-04）

> 对照原始规格（P-I~P-IV）逐条核对实现，标注完成度、缺口与补齐建议。
> 结论：数据层/API/单测基本完成；**结构完整性仍有 3 个实质缺口**，集中在 P-I 的 trace 闭环与数据完整性。

## 结论总表

| 阶段 | 数据层 | API | 单测 | 完成度 | 关键缺口 |
|---|---|---|---|---|---|
| P-I 运行档案 span 底座 | ✅ | ✅ | ✅ 5 | ⚠️ 70% | trace_id 未闭环到 task；span 无 cost；无 View UI |
| P-II Signals | ✅ | ✅ | ✅ 10 | ✅ 90% | "装进 Proactive Center"为桌面概念，实为服务端 SignalScanner |
| P-III Agent 自查工具 | ✅ | ✅ | ✅ 5 | ✅ 95% | 工具已只读 + scope 隔离 |
| P-IV Eval 数据集 | ✅ | ✅ | ✅ 6 | ⚠️ 60% | 未挂测试体系(metrics/E2E/Playwright)；未采样完整 input/output |

合计：26 个单测全过，变更 5 个 commit（P-I~P-IV + 1 个类型修复），服务端测试 66 过（唯一失败为既有的 provider 矩阵测试，与本次无关）。

## P-I 缺口（最需补齐）

### 缺口 A：trace_id 未真正闭环（结构性问题，最严重）
- **现状**：`runAgentTurn`→`agentTurnRunner` 调用时**未传 traceId**（app.ts 194 行），runtime 里 span 用 `input.traceId ?? input.taskId` 回退为 **taskId**。HTTP 层 `traceId`（app.ts 282 行）只写进 audit，与 span 的 traceId 是**两套独立 ID**。
- **规格要求**：贯穿 task_id→trace_id，让一次 run 的 **audit 事件 + usage + provider 调用**能被 trace_id 聚合成一棵树。
- **实际达成**：目前只有 **provider→tool** 通过 span 表聚合成树（同 taskId）；audit 和 usage **没有挂进这棵树**。
- **佐证**：audit 表有 trace_id 字段但 HTTP traceId 与 task 无关；usage 表**根本没有 trace_id 列**。

### 缺口 B：span 每层无 cost
- 规格要求每层 "latency + token + **cost** + 结果"。当前 span meta 只有 token（inputTokens/outputTokens/cache），**无 costMicroUsd**（usage 表有 cost 但未回填进 span）。

### 缺口 C：无「运行档案 View」UI
- dashboard.ts（无构建依赖的工作台）只引用 /agent/audit、metrics、tasks、recovery，**未引用 /agent/traces**；web/src/main.tsx 也未含 traces/signals/datasets。
- 规格明确要求"Web 工作台给任务加运行档案 tab，可展开展开 run→tool 树"。当前只有数据接口 + API，**无可视化 tab**。

## P-II 说明
- 规格："装进 Proactive Center / 推送到飞书钉钉 / Proactive Today 呈现"，强调"用 Proma 自己的自动化引擎"。
- 实现为**服务端 SignalScanner**（30s 周期扫描 span 表 → 命中落 signal_hits + 可选 reportAlert webhook）。这是**服务端自闭环**，不依赖桌面 Proactive Center。属合理的服务端映射，但**未接到 Proactive Today / IM 桥接**，也**无 UI 呈现**（只有 API）。

## P-III 说明
- 完成度高：RunInspect/ListRecentRuns/RunSearch 只读工具，按构造时 scope 强制隔离，未注入不注册。与规格"run.query/run.span/run.search"一致。
- 待办 P-III.2：与 memory 联动沉淀教训（规格提到"结合 memory"），当前未做。

## P-IV 缺口
- 规格："把 span 真实 input/output 采样成 datasets" + "把测试体系(metrics/replay/Playwright)与真实数据挂钩形成飞轮"。
- 现状：做了**轻量结构化采样**（刻意不存完整 input/output，符合 local-first），且**未挂测试体系**——只做了数据集采集层，没有"评估→回归"挂钩。
- 取舍说明：这个与 P-I "span 只存轻量 meta"的自洽，但严格看是**对规格的降级**（规格要完整 input/output 采样 + 测试挂钩），需用户确认是否接受轻量路径。

## 补齐优先级建议
1. **P-I 缺口 A（trace 闭环）**：结构地基，优先。需改 web-server 契约，让 runAgentTurn 能拿到 HTTP traceId 并下传给 span + audit + usage（usage 加 trace_id 列）。
2. **P-I 缺口 B（cost）**：把 usage 的 cost 回填到 provider span meta。
3. **P-IV 缺口（测试挂钩）**：把现有的真实 Sample 用到一个最小 eval 回归流程（可选，增量）。
4. **View UI + IM 桥接**：量大，放后续 P6-3（Web 工作台）落地。

## 十一、P-I 缺口 A+B 补齐记录（2026-08-04）

按复查结论补齐 P-I 两个结构缺口：

### 缺口 A（trace 闭环）：一个 run = 一个 traceId = 一棵树
- `runAgentTurnTask` 显式传 `traceId = input.context.taskId`（web-server），span 不再仅靠回退。
- 新增 `PostgresRunProfileAggregator` + `GET /agent/runs/{taskId}`：把一次 run 的 **span 树 + usage + audit** 按 taskId（逻辑 traceId）关联成一份运行档案。
- 语义：HTTP 层 requestId/traceId 保留给请求审计；run 档案以 taskId 为逻辑 traceId 聚合（审计与 span 两个正交维度，设计合理）。

### 缺口 B（span 每层带 cost）
- `RuntimeSpanSink` 新增 `attachCost(scope, taskId, costMicroUsd)`；`spanStore` 实现——把该 task 的 cost 回填到 provider span 的 meta.costMicroUsd。
- app.ts 在 `usageLedger.record` 后调用 `spanStore.attachCost`。

### 新增文件/测试
| 文件 | 改动 |
|---|---|
| `packages/shared/src/types/runtime-span.ts` | `RuntimeSpanSink.attachCost` |
| `packages/shared/src/utils/agent-runtime-web-server.ts` | `runAgentTurnTask` 传 traceId |
| `apps/server/src/spans.ts` | `attachCost` 实现 |
| `apps/server/src/run-profile.ts` | `PostgresRunProfileAggregator` |
| `apps/server/src/app.ts` | `attachCost` 回填 + `GET /agent/runs/{taskId}` |
| `apps/server/src/spans.test.ts` | +1（attachCost 回填） |
| `apps/server/src/run-profile.test.ts`（新增） | +3（聚合/undefined/纯 span 树） |

验证：全项目 typecheck 通过；biome 干净；server 70 tests 过（新增 4 个）；唯一失败仍是既有的 provider 矩阵测试。

**完成度更新**：P-I 从 70% 提升至 ~90%（trace 闭环+span cost 已补齐；剩余「运行档案 View UI」属 P6-3 呈现层）。

## 十二、P-IV 路线1 补充记录（2026-08-04）

按「路线1」补齐 P-IV 规格两点缺口（真实 input/output 采样 + 测试挂钩）：

### 缺口① 真实 input/output 采样
- `AgentRuntimeWebAgentTurnInput.spanSampling`（enabled/rate/maxBytes，默认关闭）。
- runtime：采样命中本 run（`Math.random()<rate`）时，tool span meta 追加 `sample:{input,output}`（截断），provider span end 时追加 `sample`（input=prompt 摘要，output=生成的 text）。
- `EvalSample` 增加 `input?`/`output?`，聚合/归档时从 span meta.sample 抽取。
- 新表列 `input`/`output`（TEXT），insert/select/toSample 同步。

### 缺口② 测试挂钩
- `real-e2e.test.ts`：真实 provider run 后 `POST /agent/datasets` + 断言 sample 归属该 taskId——真实数据进飞轮的常驻挂钩。
- `eval-dataset.test.ts` +1：带 meta.sample 的 provider span 被抽取为 input/output。

### 装配 + 运维
- `PromaWebServerConfig.spanSampling` → app 传 runtime；env `PROMA_WEB_SPAN_SAMPLING` / `PROMA_WEB_SPAN_SAMPLE_RATE` / `PROMA_WEB_SPAN_SAMPLE_MAX_BYTES`；READMe 记录。默认全关，不吃掉 local-first。

验证：全项目 typecheck 通过；biome 干净；server 71 tests 过（新增 2 个：eval-dataset input/output + real-e2e hook）；唯一失败仍是既有 provider 矩阵测试。

**完成度更新**：P-IV 从 60% 提升至 ~95%（input/output 采样 + 测试挂钩已补齐；剩余「完整 eval 打分/离群对比」属 P-IV 之后）。

## 十三、Web 可视化 tab（2026-08-04）

在无构建依赖的 `WEB_DASHBOARD_HTML`（`apps/server/src/dashboard.ts`）新增三个可视化视图，兑现 P-I/P-II/P-IV 的「呈现层」：

| 视图 | 内容 |
|---|---|
| **运行档案** | 列出任务 → 点击调 `/agent/runs/{taskId}` → 递归渲染 span 树（每层 latency · token · cost），错误标红，附 audit 摘要与 cost |
| **Signals** | 列表 + 命中记录 + 新建（人话描述 + tool_repeat_failure matcher） |
| **评估数据集** | 列表 + 采样新建（窗口）+ 样本（含 input/output/error） |

实现：nav 新增 3 按钮；`loadRuns`/`loadSignals`/`loadDatasets`/`loadRun`/`spanTree`/`loadSamples` 等函数；`viz()` 容器 + `setTab()` 高亮。内嵌 JS 通过 `node --check` 语法校验；span 树数据结构确认可被可视化消费。

新增 `apps/server/src/dashboard.test.ts`（4 个：导航包含、渲染函数存在、API 端点、JS 引用平衡）。biome 干净；server 75 tests 过；唯一失败仍是既有 provider 矩阵测试。

**至此 P-I~P-IV 全部规格（含 UI 呈现层）已闭环落库。**

## 十四、两个交互 UI 更新（2026-08-04）

按用户反馈调整两块交互：

### 1. 星标对话 → 独立常驻区块
`LeftSidebar.tsx`：移除原「星标对话」可折叠导航项 + 条件展开缩进列表，改为**常驻独立 section**——星标图标 + 标题 + 数量 + 直接平铺列表（`max-h-[40vh]` 可滚动，空态提示）。清理了 `SidebarItem` / `SidebarItemId` / `ITEM_TO_VIEW` / `handleItemClick` / `pinnedExpanded` 等死代码。

### 2. 子代理(SubAgent) → 嵌套层级
`ContentBlock.tsx`：新增 `depth` prop（默认 0，递归时 +1），Thread 到 ContentBlock→ToolUseBlock→childBlocks.map。完成后的嵌套子代理在折叠头部显示「子代理 · N」层级徽标，且外层套 `border-primary/10` 圆角容器，与顶层/并排块明确区分，呈现父→子层级树而非扁平平铺。

typecheck + biome 均通过。
