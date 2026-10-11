# V02第四批子契约：已准备请求的调用上下文

> 2026-10-09 07:17 GMT+8起；基线72793fb5。只绑定实际query参数，不接V03。

## 设计

复用第三批captureRun的早期Goal/run闭包，避免异步初始化后重新查session而绑定新Goal。在调用adapter.query前增加主进程onPrepared(context)，保存已准备请求的workspace、cwd、runtime、channel、provider、requestedModelId；runId/goalId/sessionId/preparedAt由闭包自身提供，不从模型DTO读取。

- AI SDK/proma使用已经构造的queryOptions及已解析workspace；Pi使用resolvedModelId和已验证workspace。模型ID字段明确为请求值，不是Provider确认值。
- onPrepared只消费一次；未准备不能提交检查点。槽位失效/暂停/新run/新Goal使准备回调同样失效。
- 配置指定workspace/channel/model时必须与请求相等（模型未知不当作相等），runtime必须相等。未指定字段不补造固定配置；请求中未知的workspace/model保持缺失。
- 保存独立值副本到AgentGoal可选invocationContext，JSONL保留历史，新run清空旧投影。实际query前同步复查槽位所有权，防await准备后已停止却迟到启动。不得存API Key、headers、prompt、输出或任意模型证据。
- 准备前/检查点前比对capture时的Goal配置（runtime/workspace/channel/model/objective/acceptanceCriteria），发生变化拒绝，不把旧请求当成新授权；continue接收后漂移，结束回调也不能自动续跑。
- 还要检查保存的context与闭包副本一致，防本机记录不一致；这不是防具有私有目录写权限者的密码学认证。

## 边界

记录只证明本机准备了这些query参数；query可能未发出、Provider可能失败或路由到别的模型，不能宣称已确认模型、请求ID、费用或进程成功。未指定workspace不能填Goal默认值来拼VerificationSubject；无需迁移历史Goal。

不解决测试来源、criteria/verifier授权、task/execution映射、toolCallId、workspace目录/渠道配置的动态撤权与原子存储。V02整体保持部分完成，V03仍受可信采集前置阻塞。没有新flag/UI/IPC，也不改变TCC、ACP、业务验收规则。
