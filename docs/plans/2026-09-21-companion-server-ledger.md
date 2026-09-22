# Companion Server 实施台账

> 计划：`docs/plans/2026-09-21-companion-server.md` · 分支：`feat/companion-server` · 开始：2026-09-21 15:50 · 完成：2026-09-21 16:35

| # | 任务 | 状态 | 提交 | 验证 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | shared 类型与常量扩展 | ✅ 完成 | b30d54a6 | shared typecheck 通过 | 版本实际 0.2.6→0.2.7（计划所记 0.1.76 已过时） |
| 2 | Settings companionServer 配置 | ✅ 完成 | 0d27c962 | settings-service.test 5 pass | 加入 NESTED_MERGE_FIELDS |
| 3 | companion-auth 模块 | ✅ 完成 | 18036bfc | companion-auth.test 4 pass | 含「明文不落盘」「旧 token 失效」断言 |
| 4 | companion-api 纯路由表 | ✅ 完成 | 6b60d300 | companion-api.test 12 pass | alwaysAllow 强制 false；运行中 409；pair_failed 审计 |
| 5 | companion-server（HTTP+SSE） | ✅ 完成 | f509a454 | companion-server.test 4 pass | 真实依赖动态 import；测试注入 fake deps+bus |
| 6 | companion 操作审计 | ✅ 完成 | 559b85ab | companion-audit-service.test 2 pass | JSONL 追加，不记正文 |
| 7 | 移动端单页 | ✅ 完成 | c2731c30 | typecheck 通过；server 测试覆盖页面可达 | 配对/会话列表/SSE 流/权限卡片/AskUser 卡片 |
| 8 | 主进程接线 + IPC + 设置 UI | ✅ 完成 | 35743d6a | 全仓 typecheck 通过 | 设置变更联动启停；「连接与同步」组新增远程访问 Tab |
| 9 | 全量验证 + 版本递增 | ✅ 完成 | 3f71c7cb | typecheck 全绿；bun test 2784 pass / 39 fail（存量） | electron 0.12.43→0.12.44 |

## 验证结论（Task 9）

- 全仓 `bun run typecheck`：6 个包全部通过。
- `bun test`（全量）：2784 pass / 27 skip / 39 fail。**39 个失败经 main 分支临时 worktree 对比确认为存量失败**（研发员工、WebSearch/WebFetch、Knowledge、PiAgentAdapter 等模块，单文件运行可通过，属全量运行的测试隔离污染），与本次改动无关；本次新增 27 个用例（含 settings 合并 1 个）全部通过。
- 测试隔离：所有 companion 测试使用 `PROMA_TEST_CONFIG_DIR` + `127.0.0.1` 随机端口，未触碰真实 `~/.gravitas/`。

## 问题与决策记录

| 时间 | 决策/问题 | 处理 |
| --- | --- | --- |
| 15:58 | shared 版本号实际为 0.2.6（计划中写 0.1.76 已过时） | 按 0.2.7 递增 |
| 16:12 | companion-server 顶层 import agent-service 会牵出整个主进程（含 electron mock 缺口），测试不可行 | 重构为依赖注入：测试注入 fake deps + fake 事件总线，真实依赖 `buildRealDeps()` 动态 import |
| 16:12 | envelope 默认 id 为 UUID 不可比较 | 用自增序列号作为 `options.id`，Last-Event-ID 数值比较 |
| 16:15 | `typecheck && bun test \| tail` 管道吞掉退出码，带错提交过一次 | 修复后 `--amend`；后续 typecheck 单独跑、确认输出再提交 |
| 16:30 | 全量 bun test 39 fail，需判定是否本次引入 | main 分支临时 worktree 全量对比：同为 39 fail → 存量问题，已记录不阻塞 |
| 16:32 | electron 版本实际 0.12.43（AGENTS.md 所记 0.11.69 已过时） | 按 0.12.44 递增 |

## 待办（不在本次范围）

- [ ] 真机手动验收（设计文档验证清单）：手机同 Wi-Fi 配对、权限远程确认、SSE 断线补发、关闭开关后端口释放
- [ ] 存量 39 个全量测试隔离污染问题（另开任务排查）
- [ ] `AGENTS.md` 版本号段落已过时（shared/electron 版本、测试基线数量），需用户授权后再更新
- [ ] M3：Web Push 通知、PWA manifest、附件只读预览
