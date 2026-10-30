# 本轮任务：收拢仓库（2026-10-30 21:10 起）

目标：把 50 项未提交改动按主题提交，再与 origin/main（behind 16）对齐，处理重叠文件冲突。
授权边界：允许本地提交与建分支推送；禁止连生产环境、禁止产生真实 Provider 费用。

## 状态：已完成

- [x] 侦察：工作树 33 modified + 17 untracked，main 曾 ahead 3 / behind 16
- [x] 侦察：.context/glm-real-acceptance/ 8.1GB / 37621 文件，已加入 .gitignore
- [x] C1 `fix(autonomy): 拒绝同命令内的 Git 结构执行通道`
- [x] C2 `fix(agent): 以已接受的停止事实作为完成终态`
- [x] C3 `fix(owner): 统一权威交付终态并等待在途轮次退出`
- [x] C4 `fix(owner): 按原回执时间核验历史质量结论并支持显式续期`
- [x] C5 `test(owner): 补齐固定包与真实验收烟测工具`
- [x] C7 `docs(context): 记录 0.13.483 验收结果与 P1 进度台账`
- [x] 分支 `codex/p1-owner-delivery-harness` rebase 到 origin/main（8 提交全部重放）
- [x] C8 `chore(release): 0.13.494 / @gravitas/shared 0.2.149`

## 冲突处理记录

rebase 到 `32f17a5a`（origin/main）时只有两处真冲突：

1. `apps/electron/package.json` 版本号（两次）：取远端 0.13.493，最终统一提到 0.13.494。
2. `project-owner-management-conversation.ts`：远端 #66 新增 `fileChangeObservation`，
   本地新增 `frozenDeliveryReview`，两者都保留。

`project-owner-management-loop.ts` 由 git 自动合并（远端 3 行 fileObservation 改动 + 本地停止逻辑）。

## 验证结果（0.13.494，rebase 后）

日志：`.context/glm-real-acceptance/typecheck-0.13.494-rebase.log`、`typecheck-workspace-0.13.494-rebase.log`

- 全 workspace typecheck：9 个包全部 exit 0。
- `git diff --check`：通过。
- 聚焦测试 **133 pass / 0 fail**：

| 文件 | 结果 |
| --- | --- |
| project-owner-quality-actions.test.ts | 30 pass |
| project-owner-planning-run.test.ts | 19 pass |
| project-owner-execution-revalidation.test.ts | 13 pass |
| project-owner-planning-source.test.ts | 12 pass |
| project-owner-quality-protocol.test.ts | 8 pass |
| git-command-boundary.test.ts | 5 pass |
| owner-quality-revalidation-smoke.test.ts | 4 pass |
| owner-real-chain-smoke-budget.test.ts | 3 pass |
| project-owner-management-failures.loop.test.ts | 2 pass |
| project-owner-management-delegation.test.ts | 37 pass（额外） |

- `bash-sandbox.test.ts`：33 pass / 10 fail。10 项失败均为
  `sandbox-exec: sandbox_apply: Operation not permitted`，本机 Agent 沙箱内无法嵌套
  seatbelt，属环境性失败，与 P1 台账记录一致。

**未跑全仓回归**：本轮只做聚焦验证，不得声称 0.13.494 已完成全仓回归。

## 测试跑法纠正

`.context/` 根目录的 `bunfig.toml` 配置了 `preload = ["./tests/electron-mock.preload.ts"]`。
在 `apps/electron` 子目录跑 `bun test <绝对或相对路径>` **不会加载该 preload**，
表现为 `Export named 'BrowserWindow'/'shell' not found in electron/index.js`。
**必须在仓库根目录执行 `bun test <path>`。**

大文件（quality-actions 约 3 分钟）需后台运行 + 轮询日志，前台单条命令会被会话中止。

## 版本对应关系（重要）

0.13.483 的固定包验收（ZIP SHA-256 `29df89db…b905e6`）构建于 rebase 前内容，
基线不含 origin/main 新增的 16 个提交。0.13.494 引入这些提交后，**固定包结论
不能直接迁移**；若要据此签收，必须在 0.13.494 上重新构建并复跑固定包烟测。

## 已知问题（待后续处理）

1. `project-owner-execution-command.ts` 与 `project-owner-development-artifact.ts` 用
   `require('./owner-quality-revalidation-smoke')` 接入生产路径，仅靠
   `GRAVITAS_PACKAGE_SMOKE=1` 保护。生产代码依赖烟测模块属于临时接线。
2. Git 词法门禁会误伤提交信息与 heredoc 正文：本文档编写过程中，
   提交信息里描述 `git init` 即被拒绝。需要区分命令与文本。
3. `.context/plan/p1-next.md` 中"远端多 1 个提交"已过期（实际曾是 16）。
