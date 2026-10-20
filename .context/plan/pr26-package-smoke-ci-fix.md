# 修复 PR #26 包烟测 mock 兼容

## 背景
PR #26 当前 head 为 `45fe87b0`。CI 全量测试在 `apps/electron/src/main/index.ts` 模块导入阶段失败：测试 mock 中 `app.setPath` 不存在。PR 分支为 Dev/Stable 隔离新增了源码 Dev userData 的 `app.setPath` 调用；同时 package smoke 在测试配置下重定向 userData。应对真实 Electron 有 `setPath` 的启动行为保留隔离，但兼容缺失此 Electron API 的模块测试 mock。

## 当前工作区
当前 cwd 已切换到 `feat/agent-input-ux`（HEAD `3ff1593c`），有用户未提交改动和 `apps/electron/out-dev/` 未跟踪内容；不得修改、暂存、清理或切换该工作树。

## 计划
1. 在 cwd 可写且不属于现有仓库的隔离位置创建临时 Git worktree，基于 `origin/feat/dev-stable-isolation`（head `45fe87b0`）。若权限不允许则停止，不尝试覆盖当前工作树。
2. 修改 userData 初始化：只有 `typeof app.setPath === 'function'` 时才执行路径重定向；Dev 真实 Electron 仍设置独立 `appData/Gravitas Dev`，package smoke 仍重定向临时目录；mock 场景跳过 Electron 路径设置。
3. 增加启动路径回归测试，覆盖 package smoke 临时目录、Dev 独立 userData、mock 缺失 setPath 三种分支。
4. 运行定向测试、Electron typecheck、Biome、完整相关 test 脚本或 CI 同等门禁，并检查差异。
5. 只提交该修复与测试，推送 PR #26 的专用分支，等待 GitHub 检查。
6. PR #26 所有必需检查通过后，按需合并 #26；其后更新/重跑 #27 的 main-base 检查，全部通过才尝试合并 #27。若检查失败或有额外权限问题则停止并报告，不绕过门禁。

## 安全边界
- 不改动当前 `feat/agent-input-ux` 工作树中的任何未提交/未跟踪内容。
- 不触碰生产 `~/.gravitas` 数据，不退出或重启生产宿主。
- 不用 force push；不绕过失败质量检查。
- PR 合并只在用户已明确要求“尝试合并 open PR”且所有门禁通过后执行；不发布、不打 release tag。
