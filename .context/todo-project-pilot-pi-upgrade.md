# Pi 0.82.1 → 0.87.1 隔离升级验证（2026-09-27）
- [x] 固定脏工作区基线与官方版本差异；识别 session 历史权威源变更。
- [x] 在临时目录安装三件套 0.87.1，核对实际包类型和版本；不改项目 lockfile/node_modules。
- [x] 对现有 adapter 做隔离编译/无 Provider 的历史恢复和资源限制验证，记录真实失败与迁移建议。
- [x] 汇总测试/风险到会话 note 与台账；门禁与能力位不变，不调用 Provider。
- [x] 实际 bump（台账 `-35`，基线 `0c0e2d35`）：三件套 0.82.1→0.87.1＋lockfile；历史恢复改 SessionManager 预种子（`buildPiHistorySessionEntries`＋`SessionManager.inMemory(cwd, undefined, entries)`）；adapter 测试 `streamSimple` 改 `normalizeContext`。3 个 0.87 回归测试 PASS、全仓 498 文件 0 失败、typecheck/Biome PASS。真实 Provider 冒烟未开，Pi 能力位/白名单不变，G0/G1 不变。
