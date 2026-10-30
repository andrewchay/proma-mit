# P1 下一步计划（2026-10-30 进度核查后）

目标：先把已做的工作并回主线，并取得可信的全仓回归结果，再继续推进新的切片。

## 1. 收拢主线（阻塞项）
- 本地 main 与 origin/main 已分叉：本地多 3 个提交（50ea51dd、c68b210a、60f17d06），远端多 1 个提交（dae96d3c #61）。
- 做法：在本地 main 上 rebase 到 origin/main，切出 `codex/p1-mcp-unknown-git-env` 分支，提 PR 走 CI，不直接推 main。
- 验收：CI 的 Repository Quality / Package Smoke 通过；`bun run test` 在 CI 上 0 个失败文件。

## 2. 处理未提交的 git-command-boundary 切片
- 问题 1（可用性回退）：`git init && git add -A && git commit` 被拒绝，`git commit -m "...GIT_DIR=..."` 和 heredoc 里出现 `git init` 也会被误拒。
- 问题 2（拦截不完整）：`g''it -c core.fsmonitor=...`、`"git" init; ...`、变量拼接、`printf >> .git/config; git status` 都能放行。
- 做法：二选一，由用户决定。
  - A：保留它，作为“明显形式”的提示层。去掉 `git init` 组合命令的拒绝，补误拒/绕过的反例测试，在证据文档写明“词法门禁不是边界”。
  - B：放弃词法门禁，把同命令内执行的窗口登记为已知限制，等待基于执行身份或 seatbelt 的方案。
- 验收：反例测试覆盖上面 7 条命令；证据文档如实写明剩余窗口。

## 3. 更新台账
- `.context/todo-p1-p2-progress.md` 的基线（仍写 ahead 1）和失败统计（写 22 个，实际 18 个文件）已过期，需要按 CI 结果重写。
- 本地全量回归运行在 Agent seatbelt 里（/tmp 不可写，sandbox-exec 不能嵌套），不能作为门禁。门禁以 CI 为准，或者在普通终端里跑。

## 4. 之后的顺序（不变）
可信执行身份的四条绕过路径测试 → Bash 纳入 unknown 门禁 → 真实打包应用验证。
