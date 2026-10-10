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
