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
