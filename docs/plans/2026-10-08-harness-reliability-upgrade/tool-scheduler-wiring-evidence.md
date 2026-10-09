# E05 第二十批：调度器生产接线证据

> 2026-10-09 21:50 GMT+8。基线 21ecba50。

## 接线

- 共享单例 `toolExecutionScheduler`（`tool-scheduler-service.ts`，maxConcurrent 4）；ai-sdk runtime（`executeRuntimeTool` 最终执行点）与 Pi 工具桥（权限通过后的通用执行点）都经 `runGuardedToolCall` 派发。
- 交互式/控制面工具（AskUserQuestion、GoalCheckpoint、EnterPlanMode、ExitPlanMode）旁路调度：无资源语义，全局串行只会卡住会话。
- **锁域声明**：仅本进程内经此调度器派发的调用。不支持跨进程共享锁——多实例、服务端 executor、子进程中的调用不在锁域内，禁止宣称全局安全。browser/terminal/Bash/MCP 等 unknown 工具走全局排他键，同一资源跨会话、父子 Agent 始终串行；文件工具在真实路径键上协调（读共享、写排他含祖先）。
- 指标：`snapshotMetrics()`（dispatched/completed/errored/cancelled/totalWaitMs），随每次派发更新。

## 关键修复

初版调度器只通知本批次的等待者：两个独立 `schedule()` 调用并发时，后一个永远等不到前一个释放锁的通知（服务测试 5 秒看门狗暴露）。改为调度器级等待者集合，锁释放（run finally）时唤醒全部等待方。

## 测试

- `tool-scheduler-service.test.ts` 7 例：同文件跨并发调用串行、独立文件读取并行、交互工具旁路（全局写阻塞时仍立即执行）、unknown 全局串行、错误原样抛出与指标计数、共享调度器并发上限、快照副本独立。
- 接线回归：ai-sdk-runtime-core、pi-tool-bridge、tool-impls 等 5 文件全部通过。
- 全仓 560 文件 3807 pass/0 fail/28 skip；九包 typecheck、lint、docs/diff 通过；真实 workspace 36→36。

## 限制（接线后仍成立）

- 调度器协调的是并发派发，不改变单次工具内部的副作用；Bash 的沙箱约束独立存在。
- unknown 全局串行意味着两个会话的 Bash/浏览器调用互斥——吞吐取舍已按保守策略确定。
- 未做性能基准；锁等待没有超时（依赖调用自身的超时/取消）。
- HR07–HR09/G2 仍未通过：真实运行下的同资源矩阵、调度指标观测、E2E 回放未做。
