# E03第六批子契约：调用批次完整性判定（不接线）

> 2026-10-09 10:08 GMT+8用户继续；基线b3a6ca40。

只实现E03第一片：纯判定模块与类型，不改AI SDK/Pi执行路径、不接入produce审批，不启用并行。SDK无法先验检查则不声明支持。

## 背景（已核验，ai@7.0.31）

- `streamText`在同一stream内等待工具执行，宿主不能在execute前对整批tool-call做先验完整性gate；`prepareStep`只影响请求，不提供"截断则零执行"开关。因此E03的mutation前先验阻断不能宣称已实现，只能事后分类+拒绝续跑。
- `StepResult.toolCalls`可含invalid的dynamic call（`invalid?: boolean`、`error`），finishReason含`length`截断语义。这使事后识别截断/无效调用可行，但已执行的效果不可撤销。

## 判定规则（shared/tool-call-integrity）

输入为一step的calls与finishReason，输出BatchIntegrity：version1、complete布尔、reasons[]、unexecutedMandatory布尔。

- complete=true当且仅当finishReason存在且不属`length|error|content-filter|other|unknown`，且所有calls无invalid标记、toolCallId唯一非空、toolName非空且无dynamic invalid error。
- finishReason缺失视为unknown→不完整；`tool-calls|stop`视为完整。
- reasons采用稳定字符串码（如finish_reason:length、invalid_tool_call、duplicate_tool_call_id、empty_tool_name），不携带工具参数/输出正文。
- 该判定只描述观察到的完整性，不构成回执、权限或对已执行效果的撤销声明。

## 保留边界

不宣称阻止了mutation执行；对已执行的流式调用只能记录事实，不能谎称撤销。不改动pi-tool-bridge；Pi等runtime后续按各自协议另行核验。E03整体、B10、HR基准与G2仍未通过；V02部分、V03受保护测试来源阻塞保持。

## 追加（2026-10-09 10:55 GMT+8，Pi语义核验）

- Pi agent-core 1.0.2：`length` 截断批次的工具调用由 SDK 判为失败而不执行；`error`/`aborted` 不执行工具。这是 Pi 的源码级零执行语义，见 pi-tool-call-batch-evidence.md。
- Pi 的 final assistant 消息已接入观察字段 `toolCallBatchIntegrity`；`deferred`/`pending` 未核实，按不完整。
- AI SDK 路径仍无先验 gate，结论不变。
