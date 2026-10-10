# V03 可信测试收集补强证据

> 2026-10-10 23:20 GMT+8。基线 a3dd2922。

## 本批前现状（核验结论）

可信采集主链此前已落地：seatbelt 沙箱内执行受保护 argv、`{{JUNIT_REPORT}}` 占位符由主进程生成报告路径、JUnit 根节点严格解析（非 stdout  scraping）、`collection_missing`/`too_few_tests`/`test_failures` 拒绝、非 darwin fail-closed、exit 0 但 0 测试不通过。即 B03 的"exit 非 0 / 测试数为 0"两条已覆盖。

## 本批补强（两个缺口）

1. **回执未绑定采集内容（B03 残余）**：回执只有解析后的计数，不含实际解析报告的哈希与字节数。同计数伪造报告无法从回执上区分。现 receipt 增加 `reportSha256`（64 位十六进制）与 `reportBytes`：采集成功必填，采集失败字段不存在。verifier 在解析前对报告字节计算 SHA-256。
2. **回执未绑定权威身份（B02）**：`completionVerification` 是裸 receipt，同用户进程可从 Goal A 移植到 Goal B。现 coordinator 完成写入时绑定 `boundGoalId` / `boundRunId`（runId 即完成后的 checkpointRunId），移植可检测。

## 测试（先红后绿）

- `pinned-baseline-verifier.test.ts` +2 例：采集成功回执携带哈希/字节数且同计数伪造报告哈希不同；采集失败不含哈希字段。真实 bun junit 在真实 git 仓库运行。
- `goal-completion-gate.test.ts` +1 例：持久化回执 boundGoalId/boundRunId 与本 Goal/本次 run 一致，移植身份不匹配可检测。

## 门禁

全仓 577 文件 3873 pass/0 fail/29 skip；typecheck/lint/docs/diff 通过；workspace 36→36。shared 0.2.45→0.2.46，electron 0.12.144→0.12.145。

## 边界（V03 仍不宣称整体通过）

- Goal 存储仍为未签名 JSON，绑定字段可被同用户进程一并改写——检测移植，不防同权限篡改（既有"本机私有文件信任"限制不变）。
- 显示侧（UI/对账）未消费绑定字段做拒绝；本批只保证记录与可检测性。
- 正式签名版（Developer ID）复验未做；沙箱仅覆盖验证命令，命令内网络未限制。
