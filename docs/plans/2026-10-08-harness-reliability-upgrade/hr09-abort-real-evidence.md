# HR09 取消语义真实观测：未通过（发现 abort 传播缺口）

> 2026-10-10 22:29 GMT+8。报告：`r01-glm-abort-hr09/report.json`。预算累计预留 ¥4.7259／¥10。

## 设计

A 会话执行 `sleep 3`（Bash → 全局排他锁）；B 会话 Read notes.txt 后 Write shared.txt；B 在第 2.5 秒被 `AbortController` 中止。预期：B 的写未开始 → 零执行（shared.txt 不存在）。

## 实际结果（两臂一致）

- **两臂均失败：shared.txt 被创建**。B 在被中止后仍完成 Read 与 Write。
- 升级臂时间线：A 持锁 502342–505422；B 于 ~504842 被中止；B 的 Write 在 507121–507125 执行（此时锁已释放约 1.7s）。
- B 的错误流为空——会话没有以可见错误终止，而是继续跑完了 turn。

## 发现

**Pi runtime 的 abortSignal 在 turn 内 Provider 往返期间未生效**（或取消语义仅在 turn 边界检查）。中止信号已按适配器契约传入（`abortFromCaller` 监听注册存在），但进行中的 Provider 请求与其后发起的工具调用未被切断。这是真实缺陷报告，本批不修复，待专项排查。

## 附带真实证据

baseline 臂 B 的 Read 在 A 的全局排他锁上**真实排队约 1761ms**（totalWaitMs；A 释放的同一毫秒 519033 才执行）——锁等待的又一份计量，但与 HR09 判定无关。

## 结论

- HR09 真实观测**未通过**：取消语义在真实运行中未满足"未开始的 mutation 零执行"。
- 离线层（调度器 queued 取消零执行）此前已验证；缺口在 runtime 的 abort 传播。
- G0–G3 保持未过；不把本批失败修饰为通过。

## 修复与离线验证（2026-10-10 22:45 GMT+8）

根因：`abortSignal` 仅在压缩路径（runWithCompactionAbort）监听，主 prompt 执行链（runPromptChain/retryablePromptChain）从不响应调用方中止。

修复（pi-agent-adapter.ts）：

- 会话建立后接线调用方 abortSignal，语义等价 `adapter.abort(sessionId)`：终止流式、清 interrupt 队列、释放会话；finally 移除监听。
- 信号在会话建立前已中止：fail-fast，不发起任何 Provider 请求。

离线验证（pi-agent-abort-signal.test.ts，2 例，先失败后通过）：

- 挂起的 Provider 往返期间中止：session.abort 被调用一次，迭代以 AbortError 结束（修复前永久挂起）。
- 预中止信号：不发起 prompt，直接 AbortError。
- 回归：断流重试/流式队列/适配器既有 36 例全过；全仓 577 文件 3870 pass/0 fail/29 skip；workspace 36→36。

待做：修复后的真实复验（abort-queued-write 重跑，费用极小）；E04 语义保持——调度器层运行中调用仍不硬打断，工具自身 signal 负责。

## 修复后真实复验（2026-10-10 22:50 GMT+8，通过）

同一 abort-queued-write 用例重跑（报告 r01-glm-abort-hr09-v2）：两臂 shared.txt 均**未被创建**，B 在中止后未发起任何工具调用（工具数=无），锁事件仅有 A 的 sleep（无 shared.txt 写事件）——未开始的 mutation 零执行在真实运行下成立；A 运行中执行完整（不被硬打断）。预算累计预留 ¥4.863／¥10（本次结算估计 ¥0.0229，非账单）。

HR09 结论更新：离线确定性验证 + 真实运行复验均通过。样本每臂 1 次；截断类场景（流式提前 tool-call）属 batch 完整性域，另由 ai-sdk-batch-integrity 承担。
