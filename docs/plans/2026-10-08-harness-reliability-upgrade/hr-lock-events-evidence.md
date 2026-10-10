# HR07–HR09 锁事件执行窗口验证证据

> 2026-10-10 21:40 GMT+8。基线 69678e15。

## 采集机制

- `tool-scheduler.ts` 新增 `LockEvent`：seq / callId / 锁键 / 模式 / 阶段（acquired、execute_start、execute_end、released、error、cancelled）/ 时间戳。
- 只记录锁键与阶段，**不记录工具参数**，工作区内容不进入观测面。
- 进程内环形缓冲（上限 1000，超限丢弃最旧）；service 层 `schedulerLockEvents()` 暴露快照。
- `runGuardedToolCall`（ai-sdk + Pi 生产路径）经调度器执行，事件自动覆盖生产调用。

## 验证矩阵（tool-scheduler-lock-events.test.ts，6 例，确定性离线）

| 条目 | 用例 | 断言方式 | 结果 |
|---|---|---|---|
| HR07 | 同键互斥写两个并发批次 | 事件序列：一侧 acquired 严格晚于另一侧 execute_end；窗口内无对方 acquired/execute_start | 通过 |
| HR07 | realpath 符号链接别名 | 别名解析到同一真实路径键，互斥串行，两侧键一致 | 通过 |
| HR08 | 同键共享读并发批次 | 双方 execute_start 均早于对方 execute_end（重叠）；结果 ID 各自完整 | 通过 |
| HR09 | 排队中取消 | 无 acquired/execute_start 事件（零执行） | 通过 |
| HR09 | 执行中出错 | error 事件如实记录、释放锁，后续同键调用继续 | 通过 |
| HR07 | unknown 工具跨批次 | 全部走 global:unknown 键，严格串行 | 通过 |

断言基于**事件序列**（seq 偏序），不使用墙钟阈值，不做性能结论。

## 过程中修正的测试缺陷（如实记录）

- 初版测试给工具绑定了桩 execute，`bindCoreToolEffects` 因实例不可信使 effects 元数据丢失，全部落入 global:unknown——HR07a 曾在此配置下"假通过"（互斥断言在全局串行下恒真）。改为绑定真实 execute 实例后，测试才真正覆盖同键路径。
- 初版输入使用绝对路径，触发 E02 契约"非规范绝对路径回退 unknown"；改用相对路径 + cwd 后锁键解析生效。
- 两处把 `{call, dir}` 包装对象误传给 `schedule`，修正为 `call`。

## 边界（不宣称）

- 锁域仍是**本进程内经此调度器派发的调用**；跨进程（多实例、服务端 executor、外部编辑器）不支持，HR07 不覆盖。
- GLM 真实试点（r01-glm-30pairs-results.json）只有最终文件完整性与派发计数证据，**无执行窗口事件**；真实运行下的 HR07 时序证据仍未取得。
- HR09 的"输出截断/不完整参数"在调度层验证到"未开始零执行、已开始如实记录"；batch 截断完整性另由 ai-sdk-batch-integrity 承担。
- 事件缓冲为内存环形，进程重启即失；不做持久审计。
- G0–G3 与 HR07–HR09 的**真实运行验收**不因此改为通过；本批是确定性离线验证。
