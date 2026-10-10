# M2 第一批：D01 能力目录派生 + D02 工具发现证据

> 2026-10-11 00:20 GMT+8。基线 a9747a9e。

## D01：tool-capability-catalog（4 例）

- 从真实 Runtime 工具注册实例派生 CapabilityCatalog（单一数据源，不重复实现 catalog）：
  - 内置 id `builtin:<name>`；MCP 按同名规则 `mcp__<server>__<tool>` 解析，id `mcp:<server>:<tool>`；
  - access/confirmation/parallelSafe 由 E01 tool-effects 推导：纯幂等读→read/never/可并行；写→write/on_demand/不可并行；unknown→external/always/不可并行（B09 保守）；
  - 失效 descriptor 明确省略并给原因，构建不崩溃；同 id 替换不重复。
- 测试先写（模块缺失红灯），实现后 4 例绿。

## D02：tool-discovery（5 例）

- 词法/规则发现（无模型）：子串 + 分词评分排序；预算内全部收录（相关度只定序），required 超预算也保留（不静默丢失 > 预算严格）；
- requiredIds 目录缺失 → requiredMissing 明确报告；预算截断 → omittedByBudget 记录；
- CJK 子串匹配（Grep 中文描述命中）；同名工具按稳定 id 区分；目录修订天然生效（无缓存）。
- 初版三处测试期望与实现语义不符（摘要含"完整参数 schema"指引语、预算只约束非 required、多命中合法），已按设计语义修正测试，未改实现迁就。

## 门禁与版本

全仓门禁见提交记录；electron 0.12.147→0.12.148。

## 边界

- D02 只做"给模型看哪些摘要"的选择；权限、schema 投影、执行边界是 D03；D02 结果不进入任何生产提示词（未接线）。
- 评分为词法规则，无语义理解；空匹配时结果可为空（required 除外），不伪造相关度。
