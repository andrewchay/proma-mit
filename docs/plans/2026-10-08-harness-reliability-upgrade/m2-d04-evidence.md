# M2 D04：工具选择 benchmark 证据

> 2026-10-11 01:15 GMT+8。基线 13a6c947。

## 落地

`agent-runtime/eval/tool-selection-benchmark.ts`（离线确定性，4 例）：

- 多步场景：步骤间目录修订（schema 变化）后，会话内旧定义调用被拒（schema_changed），重规划恢复成功（恢复非劣，unresolvedFailures 恒空）；
- 失败统计：tool_not_loaded / schema_changed / requiredMissing 分计数；
- schema token：基线=全量 name+summary+schema；优化=过滤摘要+选中 schema。42 工具目录下优化 1260→远小于基线（见测试断言 savingsRate>0）。
- 报告可 JSON 序列化，不含工具参数正文（脱敏统计）。

## 修正记录（如实）

- shared `runCapabilityTokenBenchmark` 的 optimized 侧是「全量摘要+选中 schema」（M4 语义），与本场景「过滤摘要+选中 schema」不符；基线侧复用 shared，优化侧按本场景语义计算（同用 shared 的 estimateCapabilityTokens 保证口径一致）。
- MCP 工具的 schemaRef 是 `mcp://<server>/<tool>`，初版 schemaBodies 只生成 builtin:// 键 → 修正为按 catalog descriptor 的 schemaRef/toolName 生成。
- 目录修订步骤的尝试语义明确为「上一版定义（会话内已加载的旧 schema）」，否则同计划内哈希必然一致、场景失真。

## 边界

- 时延只含机制耗时（发现+计划+门禁），**不含模型质量**；模型级工具选择评测需 Provider 授权（G3 范畴），复用 eval-runner.ts 的真实渠道接入是后续真实运行批。
- 不拿历史 M4 单轮结果作 PASS：本 benchmark 独立断言。
- D04 标记为"离线骨架完成"；真实 Provider 评测未授权未运行。

## 真实筛查结果（2026-10-11 08:32 GMT+8，ai-sdk × glm-5.3-flash，7任务×2臂=14运行）

| 臂 | 任务通过 | required-tool recall |
|---|---|---|
| baseline（全量 schema） | 6/7 | 6/7 |
| loading（D03 摘要预算 130） | 2/7 | 2/7 |

**未通过非劣筛查**：loading 臂显著劣于 baseline。逐例归因（模型回复原文见报告）：

- loading 臂模型只见到零星无关工具（AddMemory、Chrome 类），报"当前会话没有文件读取或命令执行能力"——**D02 发现在 130 token 预算 + CJK 任务查询下选错工具**；预算是主因（仅容 ~2 条摘要）。
- edit-constant loading 例：模型用了 Read 但 Edit 未在选中集 → 门禁按设计拒绝（边界正确），任务因发现未选中 Edit 而失败。
- baseline 唯一失败 grep-then-read：模型用 Bash 替代 Grep+Read（单工具替换，非边界问题）。

## 设施缺陷（已修，影响本次费用计量）

usage 权威值在 result 消息，初版从 assistant 消息提取 → 全部记 0，费用熔断未生效。**本次 14 次运行的实际 Provider 费用未知**（台账预留仍为 ¥4.863；请以智谱控制台为准）。已修复提取逻辑，后续运行按 result 消息计量。

## 结论与下一步（不宣称通过）

- D03 门禁行为本身符合设计（未加载/旧 schema 拒绝生效）；**瓶颈在 D02 发现质量**：小预算 + CJK 查询选择错误。
- 改进方向（无需 Provider 即可做）：核心文件工具常驻集（Read/Write/Edit/Grep/Bash 始终加载）、CJK 任务词→工具类型映射、预算默认值上调。
- 复测需用户授权新额度（本次实际费用未知，不假设免费）。
