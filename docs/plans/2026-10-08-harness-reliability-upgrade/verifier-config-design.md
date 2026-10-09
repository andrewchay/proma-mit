# V03 私有 Verifier 配置设计草案（待用户判断）

> 2026-10-09 10:55 GMT+8。仅为方案草案，不改运行行为、不写配置文件。

## 目的

Goal 或任务完成前需要一个**不可由 Agent 改写**的“什么算验证通过”的定义，包括：运行哪条命令、在哪个工作目录、允许哪些退出码、测试结果从哪里采集、最低测试数量，以及它绑定的验收条件哈希。Agent 只能读取配置的摘要，不能编辑它。

## 草案 schema（v1，JSON，主进程读取）

```json
{
  "version": 1,
  "verifierId": "string, 稳定标识",
  "scope": { "workspaceId": "string", "goalId": "string | null" },
  "command": { "argv": ["string"], "cwd": "worktree-root | project-root", "shell": false },
  "timeoutMs": 600000,
  "expectedExitCodes": [0],
  "testCollection": { "protocol": "main-process-junit | main-process-json", "minimumCount": 1 },
  "criteriaSha256": "绑定的验收条件哈希",
  "owner": "local-admin",
  "createdAt": "ISO-8601"
}
```

- `argv` 数组执行，不经 shell；由主进程 spawn，子进程不能访问本配置文件路径。
- 测试结果由主进程指定的临时路径采集（JUnit/JSON），而不是读取 stdout 的 `PASS`。
- 每次运行记录配置哈希、criteriaSha256、退出码、采集计数与来源路径摘要，写入 V01 回执结构。

## 存放与写入权限（需要你决定）

- 存放位置：`~/.gravitas/` 下的独立 JSON（0600），仅主进程读写；不在工作区、不在 worktree 内。
- 写入方式：**A** 仅通过设置界面由人工编辑；**B** Agent 可提议草案，人工确认后由主进程写入。推荐 A 或 B 之一，但不应允许 Agent 直接写入。

## 关键未闭合风险（需要你判断）

1. **测试代码本身可被 Agent 修改**。若测试在 Agent 可写的 worktree 内运行，Agent 可以改测试使其通过。可选方案：
   - (a) 只把配置固定到某个已提交基线（pinned commit），验证在干净 checkout 中执行，忽略工作树未提交改动（代价：不能验证未提交的改动）；
   - (b) 测试文件路径列入保护清单，修改即使验证失败（实施复杂，覆盖不全）；
   - (c) 接受风险，仅在报告中标明“测试可能被同一会话修改”（不满足 V03 目标）。
2. **首批支持的测试框架**：Bun test 的结果采集需要自定义 reporter 或 JUnit 输出；现有 `scripts/run-tests.ts` 只暴露退出码与控制台汇总，需要改造后才能提供可信计数。
3. **是否允许 Goal 自动执行验证**：只做人工触发验证，还是 Goal 完成前自动执行（影响耗时与预算）。

## 对当前状态的影响

在方案 1 选定前，V03 仍保持阻塞；V02 的已有成果不因此失效。本草案不要求新的依赖或网络调用。
