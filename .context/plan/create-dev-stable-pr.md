# 创建 Dev/Stable 隔离 PR 计划

## 目标
将本地 main 上的两个已提交 commit 提交为 PR，目标分支为 origin/main；不直接修改远端 main。

## 提交范围
- `944fc619 fix(agent): explain Codex compact limitation`
- `3fd6a275 feat(electron): isolate dev and stable builds`

## 当前工作树
存在未提交及未跟踪用户改动：`.context/note.md`、`apps/electron/src/main/lib/agent-orchestrator.ts`、`docs/generated/repository-facts.md`、多个笔记/日志/计划与 controlled-autonomy 文档。全部保留，不纳入 PR 分支。

## 步骤
1. 创建 `feat/dev-stable-isolation`，从当前 main 创建，因此仅包含上述已提交历史。
2. 核对该分支与 origin/main 的 ahead commits 和工作树状态，确认未提交文件仍留在原工作树且未进入分支历史。
3. 将专用分支推送到 origin。
4. 创建指向 `main` 的 PR，说明变更与验证边界；不合并 PR、不创建 tag、不发布。
5. 返回 PR URL、分支名及提交 hash。

## 边界
- 不直接 push main。
- 不暂存、提交或丢弃任何未提交改动。
- 不触碰 `~/.gravitas` 生产数据，不退出当前应用。
- 不合并 PR、不发布、不打 tag。
