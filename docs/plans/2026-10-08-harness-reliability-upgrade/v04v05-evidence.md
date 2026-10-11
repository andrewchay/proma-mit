# V04 有界修复续跑 + V05 验证状态 UI 证据

> 2026-10-11 11:40 GMT+8。基线 5466a4f3。

## V04（3 例，先红后绿）

- **续跑计数持久化**：`AgentGoal.continuationCount`；同 store 新协调器（模拟重启）计数不重置，超限仍转 waiting。
- **外部准入注入**：`GoalCoordinatorOptions.canContinue`（预算/撤权策略）；拒绝或抛错都 fail-closed 转 waiting 并写明原因，不发起续跑。
- **不重放**：续跑 prompt 只携带 summary/nextAction 文本（不含 evidence 正文），新增"不要假设上一轮未验证副作用已生效，先重新核验"指令；blocked（用户暂停）不发起续跑。
- **修复既有缺陷**：`schedule()` 原使用调用方传入的陈旧 goal 快照做计数保存，会覆盖并发签发的 activeRunId（setStatus 排队与 captureRun 竞态时触发）；现计数前重读最新记录，有 activeRunId 直接跳过。该缺陷由本批测试首次暴露。

## V05（6 例纯函数 + 徽章组件）

- `resolveGoalVerificationStatus` 五态：accepted（completed+passed 回执）/ verified（回执 passed 未完成）/ finished_unverified（仅 checkpointRunId）/ unverified（legacy 无回执）/ mismatch（boundGoalId 不符，不串项）。
- AgentView Goal 横幅新增 `GoalVerificationBadge`：颜色区分 + detail 证据定位（verifier/提交/测试数/报告哈希）。

## 门禁与版本

全仓见提交记录；shared 0.2.46→0.2.47，electron 0.12.153→0.12.154。

## 边界

- V04 计数是"连续自动续跑"维度；用户手动"继续"重置语义由既有 setStatus 承担。
- canContinue 的生产接线（pilot 预算/撤权注入）未接——需要 project-pilot 侧提供策略回调，属后续批次。
- V05 徽章只读；mismatch 仅展示警告，不做自动撤销。
