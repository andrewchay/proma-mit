# Companion Server 实施台账

> 计划：`docs/plans/2026-09-21-companion-server.md` · 分支：`feat/companion-server` · 开始：2026-09-21 15:50

| # | 任务 | 状态 | 提交 | 验证 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | shared 类型与常量扩展 | ✅ 完成 | b30d54a6 | shared typecheck 通过 | 版本实际 0.2.6→0.2.7（AGENTS.md 所记 0.1.76 已过时） |
| 2 | Settings companionServer 配置 | ✅ 完成 | 0d27c962 | settings-service.test 5 pass | 加入 NESTED_MERGE_FIELDS |
| 3 | companion-auth 模块 | ✅ 完成 | 18036bfc | companion-auth.test 4 pass | 含「明文不落盘」「旧 token 失效」断言 |
| 4 | companion-api 纯路由表 | ✅ 完成 | 6b60d300 | companion-api.test 12 pass | alwaysAllow 强制 false；运行中 409；pair_failed 审计 |
| 5 | companion-server（HTTP+SSE） | ✅ 完成 | f509a454 | companion-server.test 4 pass | 真实依赖动态 import；测试注入 fake deps+bus |
| 6 | companion 操作审计 | ✅ 完成 | 559b85ab | companion-audit-service.test 2 pass | JSONL 追加，不记正文 |
| 7 | 移动端单页 | 🔄 进行中 | — | — | 当前为占位页，本任务替换为完整实现 |
| 8 | 主进程接线 + IPC + 设置 UI | ⬜ 待开始 | — | — | 生命周期 + 设置页分区 |
| 9 | 全量验证 + 版本递增 | ⬜ 待开始 | — | — | typecheck + bun test + electron 0.11.70 |

## 问题与决策记录

| 时间 | 决策/问题 | 处理 |
| --- | --- | --- |
| 15:58 | shared 版本号实际为 0.2.6（计划中写 0.1.76 已过时） | 按 0.2.7 递增 |
| 16:12 | companion-server 顶层 import agent-service 会牵出整个主进程（含 electron mock 缺口），测试不可行 | 重构为依赖注入：测试注入 fake deps + fake 事件总线，真实依赖 `buildRealDeps()` 动态 import |
| 16:12 | envelope 默认 id 为 UUID 不可比较 | 用自增序列号作为 `options.id`，Last-Event-ID 数值比较 |
| 16:15 | `typecheck && \|\| tail` 管道吞掉退出码，带错提交 | 已修复并 `--amend`；后续提交前单独跑 typecheck |
