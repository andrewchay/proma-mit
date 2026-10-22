# 修复 React #310 Hooks 顺序回归

## 目标
修复 Agent 常驻交互横幅因请求状态变化而违反 Hooks 调用顺序的问题，验证请求从无到有、有到无及题目数据变化都不会触发 React #310。

## 证据
React #310 解码为 “Rendered more hooks than during the previous render”。代码审阅发现 AskUserBanner、PermissionBanner、McpOAuthBanner、ExitPlanModeBanner 都在若干 hooks 之后根据 `request` 提前返回；AskUserBanner 还在 `currentQuestion` 不存在时提前返回。请求异步到达/消失会改变同一组件实例的 hooks 数量。该文件不在 PR #26 的 renderer diff 内，因此这是 main 上既存的 UI 稳定性缺陷，不应错误归因于 PR #26。

## 步骤
1. 将四个横幅的条件返回移到所有 hooks 与稳定回调声明之后；AskUserBanner 将 `currentQuestion` 的缺省 UI 作为渲染条件处理，确保 hook 顺序固定。
2. 增加一个定向回归测试，验证无请求/有请求切换及 AskUser 缺题状态；如项目测试环境不支持 React DOM，至少做静态 hook 顺序契约测试并运行 renderer 构建/typecheck。
3. 执行相关测试、Electron typecheck、Biome 与 build:renderer。
4. 查看当前分支/工作树。修复与 PR #26 的提交集无关，不擅自塞入隔离 PR；单独提交 hotfix 并开针对 `main` 的 PR（若 PR #26 仍未合并则保持独立 PR）。
5. 不合并 PR、不发布、不触碰生产用户数据。

## 安全边界
- 保留已有未提交改动，不 stash、不 reset、不 checkout 覆盖。
- 避免把本机的未提交 AgentOrchestrator/文档生成改动带入 hotfix。
- 先通过本地测试验证，不操作正在运行的生产宿主。
