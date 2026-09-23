# TCC M3 代表性真实评测决定

**日期：** 2026-09-22
**模型：** GLM-5.3-Flash（渠道 ID 见私有评测记录，不入库）
**矩阵：** 10 个长噪声 spawn 样本 × full context / brief / TCC projection × 3 次，共 90 次真实调用
**执行路径：** `scripts/run-tcc-spawn-eval.ts` → `tcc-spawn-eval-harness.ts` → `tcc-experiment-runner.ts` → `tcc-spawn-real-delegate.ts`；TCC 组经 `prepareSubAgentProjectionFromItems()` 走与生产相同的 spawn 边界
**评测隔离：** `disableTools: true`（零工具）、`permissionMode: 'safe'`、cwd 为临时隔离目录

## 结果

| Variant | 成功/总 | Input tokens | Output tokens | 总时长 | 已验证 claims | cache |
|---|---:|---:|---:|---:|---:|---|
| Full context | 24/30 (0.80) | 209,760 | 43,135 | 18.3 min | 48/48 | 15 hit / 9 miss |
| Brief | 15/30 (0.50) | 15,099 | 28,494 | 15.0 min | 10/11 | 10 hit / 5 miss |
| TCC projection | 24/30 (0.80) | 32,678 | 90,504 | 49.2 min | 48/50 | 16 hit / 8 miss |

- Input token 节省：**84.4%**（远高于 20% 门槛）。
- Output token 变化：**+109.8%**；总 token 由 252,895 降至 123,182（**−51.3%**）。
- 隐私：90 次 TCC 运行中，私密项被选入投影的次数为 **0**。
- 缓存：所有成功运行都有确定的 cache 状态，无 unknown；未把未知 cache 记为命中。
- 整体协议失败率 **30%**（full 6/30、brief 15/30、TCC 6/30），失败原因分布：9 次「未找到 typed-v1 JSON 对象」、2 次「结果缺少必要字段」。

## 冻结门禁判定

`evaluateTccExperimentGate()` 输出 `passed: true`，`reasons: []`：

- 覆盖：10 case × 3 variant × 3 run 齐全，无 skip，runtime identity 完整。
- success rate：TCC 0.80 ≥ full 0.80 × 0.95。
- evidence coverage：TCC 0.96 ≥ 0.90。
- false omission：TCC 0.00 ≤ 0.05。
- 成本：TCC input token ≤ full × 0.8。

## 决定

**门禁通过，TCC 获得 opt-in 试点资格；默认仍为关闭。** 不启用自动 relevance scorer、自动 compaction adoption 或自动模型路由。

> 后续更新（2026-09-22，M3-07）：本决定给出的 opt-in 试点资格已被用户关闭决定取代——TCC 运行与实验全部关闭，本文仅作为门禁证据存档。

依据与边界：

1. 首轮 M3（synthetic 短 prompt）测得 input token 仅降 14.3% 且未走真实 spawn 边界，因此被判不推广；本轮改为长噪声真实 spawn 样本、真实生产边界和真实协议解析后，input token 降幅为 84.4%，同时保持与 baseline 相同的成功率与 96% 证据覆盖。首轮结论由本轮证据取代。
2. **门禁通过不等于成本收益已被证明。** 本轮 TCC 用 input token 换 output token：input −84.4%，output +109.8%。门禁阈值定义在 input token 上，真实账单取决于 provider 的 input/output 单价，须按实际价格重新核算后才可声称净省钱。
3. **延迟显著回归。** TCC 组总时长 49.2 min，是 full context（18.3 min）的约 2.7 倍，主要来自更长的输出。门禁允许「token 或稳定性其一改善」，本次由 token 侧通过，延迟回归必须显式记录而不是被隐藏。
4. **评测范围有限。** 为避免模型先发起 `tool_use` 而在一轮内拿不到结论，评测禁用全部工具。因此本轮证明的是「投影承载的信息量足以支撑正确答案」，不等价于真实 explorer/researcher 子 Agent 带读工具时的端到端行为。
5. **协议合规是该模型的独立缺陷。** full context 也有 20% 运行无法产出可解析 typed-v1 结果，与 TCC 无关；在把 typed handoff 作为默认路径前，需要先降低这一失败率，否则失败会被计入 TCC 的可靠性评价。
6. 试点仍受既有约束：显式开关才启用（`sessionEnabled ?? workspaceEnabled ?? false`）、默认只读、raw typed-child transcript 仍为工作区私有产物。

## 证据边界

原始逐次运行记录保存在会话工作台私有文件 `tcc-m3-spawn-scoreboard-v3.json`，诊断文本 `tcc-m3-spawn-v3.log`；均不进入父 Agent 上下文或仓库版本控制。本轮共消耗 90 次真实调用（此前 28 次：修正前 19 次因评测缺陷作废、9 次诊断探针）。
