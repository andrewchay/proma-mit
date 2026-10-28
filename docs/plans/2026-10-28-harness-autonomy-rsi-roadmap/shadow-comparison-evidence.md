# 影子对比与可比性判定：局部证据

日期：2026-10-29；范围仅"两侧已落盘评测结果的可比性判定与差值报告"，不含影子流量采集、Provider 成本核对、UI 呈现与真实人工验收。

## 缺口

RSI 路线剩余的"影子对比"此前没有代码：`self-evolver` 内部虽然有基线与候选的接受/回滚判断（`completeCaseScore` 要求训练集与 held-out case 完整），但那是**单轮优化闭环内部**的决策，不是"两个已落盘版本之间的对比报告"。缺少的是：给定两条历史评测，能否比较、差多少、在什么情况下必须拒绝下结论。

## 本次改动

新增 `eval/shadow-comparison.ts`（纯函数，无副作用、不落盘、不激活能力）：

- `compareShadowRuns(baseline, candidate)`：
  - **可比前提**：基准版本、rubric 版本一致；两侧 case 集合完全一致；单侧内部无重复 case；每个 case 两侧都有 `0..1` 的有限分数。
  - **不可比即拒绝结论**：任一前提不满足时 `comparable=false`、`verdict='inconclusive'`、`meanDelta=null`，并在 `reasons` 里逐条写明（版本不同、缺哪个 case、多哪个 case、哪个 case 没分）。
  - **缺分不按 0 计**：只有分数的 case 保留在明细里供人工查看，但不参与均值与结论。
  - **判定阈值**：均值差绝对值小于 `deltaThreshold`（默认 0.02，可配置）判为 `no_difference`，避免把噪声当提升。
- `describeShadowComparison`：一句话结论；不可比时明写"不可比，不下结论 + 原因"，与"无显著差异"严格区分。
- `shadowRunFromEvaluation` / `compareScoreboardEvaluations`：把 scoreboard 的 0..100 百分制评测转换为 0..1 并复用同一套判定；越界或非有限分数按缺分处理（不裁剪）。

## 证据

`shadow-comparison.test.ts`（15 项）：

| 场景 | 断言 |
| --- | --- |
| 版本与 case 一致、分数齐全 | `comparable=true`、均值与差值正确、改善/持平计数正确、`candidate_better` |
| 候选明显下降 | `candidate_worse`、退步计数正确 |
| 差值小于阈值 | `no_difference`（不当成提升） |
| 阈值可配置 | 0.03 差值在 0.01 阈值下判为更好 |
| 基准版本不同 / rubric 版本不同 | `comparable=false`、`inconclusive`、`meanDelta=null` |
| case 集合不同 | 明确写出"候选缺少 case：b""候选多出 case：c" |
| case 重复 | 判为不可比（且不把两侧共有 case 误判为重复） |
| 一侧缺分 | 不可比、`meanCandidate=null`、明细保留有分 case、不按 0 计 |
| 分数越界或非有限（1.5 / -0.1 / NaN / Infinity） | 一律按缺分判不可比 |
| 文案 | 可比时含趋势与差值；不可比时含"不可比""不下结论"与原因 |
| scoreboard 适配 | 百分制换算、缺 case 报不可比、被测对象版本不同不构成不可比 |

定向回归：`shadow-comparison` 15 项、`benchmark-versioning` 3 项、`benchmark-store` 5 项、`held-out` 全部零失败；typecheck=0、biome 通过。

实现过程中被自己的用例抓到一个 bug：重复检测最初把"两侧共有同一 case"当成重复（所有正常输入都会判不可比），已修正为只在单侧内部判定重复。

## 边界

- **不是影子流量**：本切片比较的是已落盘的批量评测结果，没有把线上真实请求复制一份给候选侧执行。真正的影子流量（旁路真实流量 + 成本核对 + 不影响用户）尚未实现。
- **不做成本与延迟判定**：只比较分数；`costUsd`/`durationMs` 未纳入结论，成本回退不会被判为不可接受。
- **不做统计显著性**：阈值法是产品口径的"最小有意义差值"，不是置信区间或检验；`scoreStd` 虽在 scoreboard 里，但本模块不据此判断差异是否显著。
- **未接入 UI/审批流**：模块目前无生产调用方，`compareScoreboardEvaluations` 供后续界面或审批摘要调用；不在本切片声称用户可见。
- 判定前提依赖 scoreboard 记录的 case 分数可信；历史记录不回填、不改写，来源仍需独立审计。
