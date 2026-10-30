# 本轮任务：收拢仓库（2026-10-30 21:10 起）

目标：把 50 项未提交改动按主题提交，再与 origin/main（behind 16）对齐，处理重叠文件冲突。
授权边界：允许本地提交与建分支推送；禁止连生产环境、禁止产生真实 Provider 费用。

## 状态

- [x] 侦察：工作树 33 modified + 17 untracked，main ahead 3 / behind 16
- [x] 侦察：.context/glm-real-acceptance/ 8.1GB / 37621 文件，不可入库
- [x] 侦察：真正双向冲突仅 5 个文件（2 个 package.json + #66 触及的 3 个）
- [ ] C1 fix(bash): Git 结构门禁
- [ ] C2 fix(agent): 停止事实作为完成终态
- [ ] C3 fix(owner): 统一权威交付终态
- [ ] C4 fix(owner): 历史质量结论按原回执时间核验与显式续期
- [ ] C5 test(owner): 验收烟测与固定包验证工具
- [ ] C6 chore(release): 0.13.483
- [ ] C7 docs(context): 台账与验收记录
- [ ] 分支 codex/... + rebase origin/main + 解冲突
- [ ] typecheck + 聚焦测试
- [ ] push + PR

## 已知问题（本轮发现，待后续处理）

1. `project-owner-execution-command.ts` 与 `project-owner-development-artifact.ts` 用 `require('./owner-quality-revalidation-smoke')`
   接入生产路径，仅靠 `GRAVITAS_PACKAGE_SMOKE=1` 环境变量保护。生产代码依赖烟测模块属于临时接线，需在后续切片改为显式注入或移除。
2. `.context/plan/p1-next.md` 记录"远端多 1 个提交"已过期，实际 behind 16。
