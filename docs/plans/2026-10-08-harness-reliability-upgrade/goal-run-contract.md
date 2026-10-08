# V02第三批子契约：Goal调用身份（2026-10-08 22:47 GMT+8起）

## 冻结范围

只修复同会话检查点回调的身份与生命周期，不接V03完成验收。复用AgentGoal.activeRunId与Goal JSON/JSONL，不新增Run数据库。运行身份为主进程在Orchestrator抢占会话槽位后签发的UUID，不采用模型传入值或客户端startedAt。它证明本机已准入尝试，不等于Provider建立会话、实际执行成功或费用证明。

## 契约

- Coordinator.captureRun(sessionId)仅为当前active/waiting Goal签发闭包，持久activeRunId，清空旧checkpoint投影（历史JSONL保留）。
- 闭包固定goalId/runId，不在工具回调时重新按session查找最新Goal。检查点只写仍active、仍持有相同runId的Goal，接收后清空activeRunId，保留checkpointRunId，单次消费。
- 新run、外部暂停/取消、用户打断使旧闭包失效；旧run不能完成同会话新Goal。
- 结束回调单次消费且只针对该Goal/run。没有新检查点时等待用户，不重放上轮continue；停止请求接受后不得自动续跑。状态变化后的旧finally不得恢复或覆盖新Goal。
- Orchestrator在排队/预检之外签发，在AI SDK/Pi query中传入固定callback；compact-only不签发。回调校验槽位generation和闭包对象身份（防相同startedAt），停止释放槽位后拒绝。
- 结束在finally、驱动队列前执行；有用户排队时不插入自动续跑。无新run时保留旧权限请求清理，有新run时旧finally不按session清理请求；UI runAgent不再按session调用无身份onTurnFinished。headless及内部队列同样经过真实Orchestrator边界。
- 自动continuation不预造runId，执行真正准入时才签发；runner拒绝/异常要回读，不能把旧Goal快照重新写回覆盖本轮变化。

## 保留边界

抢占后的Provider支持/预算等预检仍可能失败，所以此身份只代表已准入尝试，不能宣称已建立Provider执行。runId不是SDK/toolCallId，不解决每条件criteria/verifier或测试收集。当前仅绑定Goal/session/run，实际workspace/channel/resolved model等InvocationContext还没有不可变来源快照，不能直接用Goal配置值补造V01完整subject。Goal字段仍受本机私有文件信任边界限制；索引与事件非事务原子。checkpointRunId只标记主进程已接收该run回调，模型evidence仍未验真。旧complete规则保持，不把生命周期身份修复宣称技术验证门禁已完成。真实abort/进程停止与重启次数限制属后续工作。

现有scripts/run-tests.ts只有每文件子进程退出和控制台输出，没有受保护的结构化收集协议；不据此派生test passed。即使添加JUnit parser，也不能自动信任可被验证子进程写入的文件。本批不以实现parser冒充可信采集完成；保留unknown/unsupported直到来源/配置边界落实。
