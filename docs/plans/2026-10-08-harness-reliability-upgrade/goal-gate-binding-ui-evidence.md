# Goal 完成门禁绑定 UI 证据

> 2026-10-09 17:30 GMT+8。Goal 门禁绑定脱离“仅协调器 API”的状态。

## 实现

- 协调器新增 `bindCompletionGate(goalId, gate)`：仅允许未在运行的 Goal（运行中/已结束拒绝）；门禁经统一存储校验后持久化。
- 主进程 `buildCompletionGateForGoal`：引用存储中最新修订；基线省略时用 `git rev-parse HEAD` 解析为当前提交。
- 新 IPC `agent:bind-completion-gate`（输入：goalId、repoRoot、verifierId、可选基线）；agent-service 导出 `bindAgentGoalCompletionGate`；preload 暴露 `bindAgentGoalGate`。
- Agent 视图 Goal 横幅：未绑定时显示“绑定门禁”弹层（选择验证器、Git 仓库绝对路径，默认预填当前工作区 rootPath，说明基线取当前 HEAD）；已绑定时显示验证器 ID 与基线短 SHA。

## 验证

- `goal-bind-gate.test.ts` 5 例：绑定持久化、运行中拒绝、已结束拒绝、非法引用/路径拒绝且不写入、绑定后 complete 仍被门禁拦截（HEAD 解析失败路径）。
- 相关 5 个测试文件全部通过；全仓 typecheck 九包、lint 通过。
- 限制：UI 未在真实应用中点击验证（需用户在下个包中确认）；绑定仅支持“当前 HEAD 作为基线”，自定义历史基线只能经 API。

## 说明

- 绑定修改 Goal 的版本号；进行中的自动续跑若因配置变化暂停，属预期（用户点“继续”即可）。
