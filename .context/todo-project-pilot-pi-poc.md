# Project Pilot Pi 0.82.1 无 Provider PoC（2026-09-27）
- [x] 核对仓库与已安装 0.82.1 API（该版没有公开 finishTurn / pre-request hook）。
- [x] 假 stream + 0.82.1 Agent：首轮准入、逐轮预算/缺费用/超限拒绝下一请求、工具前拒绝、手工 abort 接线；失败回执保留已报告费用。6 PASS。
- [x] Pilot 等合并 22 文件 154 PASS、全仓 typecheck、Biome/diff-check PASS；审查后补拒绝计数与失败费用测试；台账 `-34`。不改生产门禁、不调用 Provider。
- [x] 0.82.1→0.87.1 兼容评估：隔离 probe 安装+冒烟 PASS、changelog 破坏面核对；唯一行为断点 `pi-agent-adapter.ts:446` 的 session.state.messages 赋值，升级时须改 SessionManager 写法（详见 note.md）。
- [ ] 实际 bump 依赖到 0.87.1：待当前未提交切片收敛提交后单独切片（改 lockfile→修 adapter 446→typecheck→全量 Pilot 回归→审查）。
- [ ] 尚未完成真实 adapter/Bridge 接线、扩展逃逸、终态身份回执、重试去重和 Provider 级限额；不能宣称硬预算或 G0/G1 通过。
