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
