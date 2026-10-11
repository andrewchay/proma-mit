# E03 截断判定收束证据

> 2026-10-10 23:55 GMT+8。基线 76bbdd60。

## 核验结论（先行）

批次观察主链已落地（shared 判定词表 + ai-sdk result 持久化观察，见 tool-call-integrity-wiring-evidence.md）。本批回答 ledger 遗留的"零执行/Pi/调度消费"：

## 零执行（ai-sdk）：结构钉板而非新代码

ai-sdk@7 无宿主先验 gate（此前已核验）；截断批次中 SDK 未 invoke 的调用零执行是 SDK 固有行为，宿主不可抢占。宿主可控的两条硬保证由 `e03-zero-execution.test.ts` 钉住（mock 脚本化 streamText）：

1. **live 工具事件后瞬时错误：整轮不重试**（streamText 仅 1 次调用）——已开始 mutation 不重放；
2. **无 live 事件空流：不触发重试也不新增拒绝面**（行为兼容基线，1 次调用成功返回）。

溢出路径由既有 `attemptHadLiveEvents` 语义承担（事件存在即抛出不重放），同一机制。

## Pi：数据级断言 + 诚实声明

- bridge 只注册固定工具集（无动态/通配工具），模型无法经 bridge 调用未注册名——未知调用天然不可达，malformed 参数由 Pi SDK 的 TypeBox 校验在前拒绝。
- Proma 不伪造批次级零执行观察（无 unexecutedMandatory 置位路径），不宣称先验支持（契约一致）。

## 调度消费

截断拒绝发生在 SDK 层，调用到不了调度器；调度器无批次上下文，不消费该字段（如实记录，不硬造消费方）。

## 测试与门禁

新增 3 例（ai-sdk 2 + Pi 1）。全仓门禁与版本见提交记录。electron 0.12.146→0.12.147。

## 边界

- 观察仍可被本机写入伪造（既定限制）；`unexecutedMandatory` 恒 false，无消费方时保持。
- E03 整体仍记"部分完成"：ai-sdk 观察+非重放钉板、Pi 声明边界已收束；SDK 先验 gate 不存在是两 runtime 的共同事实，不宣称支持。
