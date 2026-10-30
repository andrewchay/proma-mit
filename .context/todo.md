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

---

# 追加任务：PR #73 macOS package smoke 失败修复（2026-10-30 22:00 起）

## 目标
让 PR #73 的 Package Smoke 三平台全绿，并修复 macOS 打包缺失 node-pty spawn-helper 的根因。

## 状态：已完成（PR #73 全绿，可合并）

- [x] 定位：macOS 作业报 `posix_spawnp failed`，打包日志有
      `file source doesn't exist from=node_modules/node-pty/build/Release/spawn-helper`
- [x] 结论：CI/发布流水线直接调用 electron-builder，不经过 `rebuild:natives`，
      `build/Release/spawn-helper` 不存在；旧 `mac.extraFiles` 只取该路径，
      electron-builder 仅告警后继续，产出缺 helper 的包
- [x] 新增 `beforePack` 钩子：`apps/electron/scripts/before-pack.cjs` +
      `node-pty-helper.cjs`（build/Release → build/Debug → prebuilds 依次查找，
      缺失即抛错；修补 unixTerminal.js；暂存到 `.packaging/`）
- [x] `mac.extraFiles` 改读暂存路径；`.gitignore` 忽略 `apps/electron/.packaging/`
- [x] `prepare-node-pty.ts` 复用同一实现，删除旧的 `node-pty-packaging.ts`
- [x] 单测 `node-pty-helper.test.ts`：7 pass / 0 fail
- [x] 本地模拟 CI（移走 `build/Release`）：`electron-builder --dir` 成功，
      产出包含 `Contents/MacOS/node-pty-spawn-helper`（0755）且 asar.unpacked 内
      `unixTerminal.js` 含 `GRAVITAS_MACOS_PACKAGED_HELPER`
- [x] Package Smoke 的 macOS 步骤新增 helper 存在性断言
- [x] 提交 `00b93933` 并推送
- [x] CI：macOS arm64 4m36s pass / Windows 6m13s pass / Linux 2m18s pass
- [x] `quality` 作业 pass（15m4s，全仓回归 + lint + docs:check）
- [x] rebase 到 origin/main（0.13.497 基线，含 #71/#72/#76）；重新生成 docs facts
- [x] rebase 后本地验证：typecheck 9 包全通过；聚焦测试 56 + 7 pass / 0 fail
- [x] 修复 CI 门禁：`docs:check` 生成文件过期、quality 作业 20 分钟超时被取消
      → 放宽到 35 分钟（`dac1b95d`）
- [x] 最终 head `f6a6dc38`：macOS 3m39s / Windows 5m53s / Linux 2m14s 全 pass，
      mergeStateStatus=CLEAN

## 环境限制（本地不可绕过）
本机 Agent seatbelt 内 Electron 无法启动（`sandbox initialization failed`），
node-pty 也无法真正起 shell（仓库内短路径同样 `posix_spawnp failed`）。
因此 PTY 行为只能以 CI 为准；本地只验证打包结构与补丁内容。

## 顺带发现
发布流水线（`.github/workflows/release.yml`）同样不跑 `rebuild:natives`，
过去发布的 macOS 包同样缺 helper；本次钩子覆盖该路径，未改发布工作流。

---

# 下一阶段：受控自主身份与恢复边界（2026-10-31 00:35 起）

## 目标
把进程内会话身份绑定从 AI SDK 扩展到 Pi / Proma，用测试覆盖四条绕过路径
（直接调用 / 子 Agent / 恢复会话 / 不同 Runtime），使「身份缺失或不匹配默认拒绝」成立。

## 前置事实核对（已完成）
- [x] PR #73 已合并（`dc4b6e44`）；PR #78 仍 OPEN，三平台包烟测已过、quality 在跑
- [x] `resolveOwnerExecutionGateSession`（project-owner-execution-gates.ts:135）在 sessionId
      无 Owner 证据时返回 `unrestricted` → 门禁结论仍取决于调用方提供的 sessionId
- [x] AI SDK 身份绑定：`ai-sdk-session-identity.ts`；绑定点 `ai-sdk-agent-adapter.ts:181`，
      撤销点 406/415/474；复核点 `ai-sdk-runtime-core.ts:122`
- [x] Pi：`pi-agent-adapter.ts:342` 构造 toolContext（sessionId/cwd 来自 input），
      仅按 sessionId 查账本，无进程内身份比对
- [x] Proma：`provider-agnostic-agent-adapter.ts:43` 直接用 `createCoreTools`，
      仅 `assertNoOwnerBusinessSession`，无身份绑定

## 实施项
- [x] 新增共享身份模块 `agent-runtime/runtime-session-identity.ts`（bind/revoke/assert），
      AI SDK 版改为兼容层委托
- [x] Pi：工具上下文创建即绑定、canUseTool 五处复核、finally 撤销
- [x] Proma：活动会话创建即绑定、执行前两处复核、query/abort/dispose 三处撤销
- [x] 模块级 11 条用例覆盖未绑定/不匹配/撤销/幂等/跨 Runtime；
      适配器级四条路径用例未补（需 electron mock 脚手架）
- [x] typecheck 9 包全通过；身份测试 32 pass；两个适配器测试 61 pass；biome 通过
- [ ] 分支推送与 PR

## 边界
- 不改普通会话行为；只让身份缺失/不匹配时拒绝
- 不动 AGENTS.md / README.md；不声称生产验收
- Bash unknown 门禁、跨进程协调另立切片

## 环境备注
`.context/tmp/`（gitignored）在实施期间被清空，本轮早期临时日志（打包模拟、CI 模拟）已丢失；
结论仍可从 PR #73 与 CI 记录核对。
