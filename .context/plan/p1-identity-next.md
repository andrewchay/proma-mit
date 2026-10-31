# P1 身份与恢复边界：后续切片计划（2026-10-31）

## 已完成（PR #79，等待合并）
- 共享身份模块 `agent-runtime/runtime-session-identity.ts`，AI SDK 改为兼容层委托
- Pi：工具上下文创建即绑定，`canUseTool` 五处复核，`finally` 撤销
- Proma：活动会话创建即绑定，执行前两处复核，query/abort/dispose 三处撤销
- 模块级 11 条用例；适配器测试 93 pass；typecheck 9 包通过；CI 五项全绿

## 切片 2：门禁接收「已绑定身份」，不再只信任 sessionId
现状：`resolveOwnerExecutionGateSession(sessionId)` 对无 Owner 证据的 sessionId 返回
`unrestricted`，因此「传谁的 sessionId」决定了门禁结论。直接调用工具实现、或用别的
sessionId 复用同一执行路径时仍可绕过。

目标：
1. `assertToolAllowedForSessionPurpose` 增加可选 `boundIdentity` 参数（或新增
   `assertToolAllowedForBoundSession(owner, identity, toolName, args)`），有绑定时强制
   校验 sessionId/cwd/runtime 一致，不一致直接拒绝。
2. Pi / Proma / AI SDK 三处工具执行入口传绑定对象；未绑定视为缺失 → 拒绝。
3. 测试：直接调用（未绑定）必须拒绝；绑定对象与调用 sessionId 不一致必须拒绝。

验收：三 Runtime 的同一组用例全绿；typecheck 通过；CI 五项通过。

## 切片 3：Bash 纳入 unknown 门禁
现状：超时/中止后命令可能已产生副作用，模型可立即重跑同一命令。
目标：Bash 执行结束状态为 unknown 时登记 unknown action，同一会话同指纹再次执行前拦截，
需人工确认后解除；确认不改变原 unknown 结论。
验收：unknown 登记/拦截/确认解除三组用例；不伪造成功或费用结论。

## 切片 4：跨进程与恢复对账
目标：受管进程树之外的孙进程、崩溃重启后的外部动作对账；无法核验时保持 unknown，
不自动重试、不释放未决占额。

## 明确不在本计划内
- RSI 评测来源冻结、OpenDesign 受控注入、Enterprise 真实部署：需要真实环境/费用授权/
  人工判断，单独推进。
- 任何业务签收结论。
