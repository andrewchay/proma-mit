# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-10-29] 业务验收不能由工程测试替代**
   Do instead: 单元测试和全仓回归只证明工程结果，真实 Provider、生产部署与用户接受分别保留独立验收记录。

## Shell & Command Reliability
1. **[2026-10-29] Bun 全量测试需要逐文件隔离**
   Do instead: 单文件使用 `bun test <file>`，全仓回归使用 `bun run test`，避免跨文件 mock 污染造成假失败。

## Domain Behavior Guardrails
1. **[2026-10-29] 不可验证的外部动作保持未知**
   Do instead: 对 unknown 结果强制门禁，不自动重试、不释放未决占额，等待可对账的恢复流程。
2. **[2026-10-29] 工具授权必须绑定可信执行身份**
   Do instead: 不信任调用方传入的会话标记，覆盖直接调用、子 Agent、恢复会话与不同 Runtime 的缺失或不匹配身份拒绝路径。

## User Directives
1. **[2026-10-29] 文档同步需要用户许可**
   Do instead: 功能变更后先提出文档更新需求，获得允许后再修改 `AGENTS.md` 与 `README.md`。
