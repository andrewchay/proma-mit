# Project Pilot 实际开始回执切片（2026-09-27，台账 -36）

基线 HEAD `3b7f22b7`。目标：把"实际 Runtime 是否启动"从 unknown 变为可证明，
故障注入下保持保守恢复。不调用 Provider。

- [x] schema：`pilot_runtime_start_receipts` 不可变表（两处迁移点 + 项目删除清理）
- [x] 新模块 `project-pilot-start-receipt.ts`：record（校验执行归属/交接链/时钟/幂等）+ read + isPilotStartProven
- [x] 恢复边界新增 `started_proven`：receipt 有效链 → 启动事实已证、终态与费用仍 unknown
- [x] 接线：orchestrator 首条 runtime 消息 → onRuntimeSessionEstablished（主路径+重试路径，跨重试一次）→ registry onRuntimeStarted → employee-service recordPilotRuntimeStarted
- [x] 故障注入测试 7 PASS：claim/handoff/receipt 各断裂组合、重复 receipt、错配 session、非 Pilot 拒绝、表不可变
- [x] 门禁：Pilot 19 文件、全仓 500 文件 0 失败、typecheck 6 包、Biome PASS；台账 -36；版本 0.12.93
