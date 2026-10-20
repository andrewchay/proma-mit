# Dev / Stable 隔离改动提交计划

## 目标
把本次已完成的 Gravitas Dev / Stable 隔离功能作为一个本地 Git commit 保存；不推送、不发布。

## 当前状态
- 分支 `main`，基于 `944fc619`，工作树包含多组未提交任务成果。
- Dev/Stable 隔离已修改源码、构建配置、README/CLAUDE、发布验收文档与 CI 检查。
- 另有 Agent 项目负责人任务、笔记、测试日志等不属于此次提交，必须留在工作树。

## 步骤
1. 精确暂存 Dev/Stable 相关文件：身份/路径/更新/启动副作用隔离、Dev/Stable builder 与 dist 脚本、CI 渠道门禁、相关测试、README/CLAUDE/发布验收文档，以及本次隔离审计记录。
2. 检查暂存区 diff 和文件清单，确保不包含其他任务文件或生产用户数据。
3. 运行渠道门禁、定向测试、Electron typecheck、Biome、docs:check、diff check。
4. 创建描述性本地 commit。
5. 确认 commit hash 与剩余未提交改动；不 push、不发布。

## 边界
- 不触碰 `~/.gravitas` 正式用户数据。
- 不退出或重启当前生产应用。
- 不暂存 Agent 项目负责人等无关改动。
- 不推送、不发布、不创建 tag。
