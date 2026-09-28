# 计划：把 derive→reserve→verify 接进 ai-sdk 生产请求出口（目标模型 glm-5.3-flash）

日期：2026-09-28 · 前置：-51/-52/-53 已完成证据注册表、请求体指纹、原子子预留与 GLM 官方牌价入库（zai-glm-5.3-flash-2026-09-28）

## 目标

让 Pilot 受控执行的每一次 ai-sdk HTTP 模型请求（含工具循环多 step、压缩调用）都先经过：
derivePilotRequestEnvelope（最终 body 派生包络，fail-closed）→ reservePilotRequest（预算内原子子预留）→ verifyPilotRequestBody（指纹一致）→ 才放行真实 fetch。
预算不足 / 证据不符 / 多模态 / 内置工具 / 缺 max_tokens 一律**HTTP 零发送**。

## 边界（本片不做）

- 不调用真实 Provider；readiness/capability 与 G0/G1 不变。
- 不做逐请求结算/释放（响应后对账、失败回收是下一片）；未知占额保持 reserved。
- Pi Runtime 接线另起一片（双 Runtime 分别验收）。
- 真实 GLM 渠道（base URL / API Key）属用户配置，仅 G2 授权后需要。

## 步骤

1. **探索（explorer）**：追踪 ai-sdk 模型创建链——agent-employee-service（Pilot 执行入口，execution/command/session 可得处）→ adapter → ai-sdk-runtime-core.ts 的 createAgentAISDKModel（fetch 形参已有）；同时定位 streamText 的 maxOutputTokens 缺口（Pilot 模式必须传，否则 derive 拒发）与压缩调用（context-compaction）的模型实例来源（Pilot 下必须复用受控出口或禁用）。
2. **新建 `project-pilot-request-exit.ts`**：createPilotRequestFetch({commandId, executionId, sessionId, priceEvidenceId='zai-glm-5.3-flash-2026-09-28'}) 返回受控 fetch：读最终 body 字符串 → derive → 生成 requestId（executionId:序号）→ reservePilotRequest → verifyPilotRequestBody → 调原 fetch；任何失败 throw（AI SDK 收到异常即中止，零 HTTP）。仅 Pilot 受控执行注入该 fetch，普通会话行为不变。
3. **离线夹具测试**（OpenAI-compatible loopback，参照既有 6-PASS 模式）：
   - 预算不足：HTTP 零发送，报预算错误；
   - 足额：恰好 1 次 HTTP，预留行存在且指纹匹配；
   - 同 body 二次请求（换 requestId）：HTTP 零发送；
   - 多模态 body / 缺 max_tokens / 非 function 工具：HTTP 零发送；
   - streamText 两 step 工具循环：两次请求各自预留、累计不超命令预留；
   - 崩溃重开库：占额保留、同指纹拒绝。
4. **接线**：createAgentAISDKModel 在 Pilot 受控执行时注入受控 fetch；streamText 增加 Pilot 专用 maxOutputTokens（≤131072，来自 grant/策略，未配置则拒发）；压缩调用纳入同一出口或 Pilot 模式禁用（以探索结论为准）。
5. **门禁与文档**：定向 + 全仓 509+ 文件零失败 + typecheck/lint/docs:check/git diff --check；ledger -54、todo、note 更新；缩小范围 code-reviewer 审查资金安全；GoalCheckpoint。

## 风险

- fetch 拿到的 Request body 可能是流/已消费——实现时需在受控 fetch 内先缓存字符串再重建请求（以测试锁定）。
- maxOutputTokens 注入点若与重试/压缩路径交叉，遗漏任一请求路径都会 fail-closed 拒发（宁可拒发不可漏发）。

## 交付判据

Pilot 受控执行内：不存在任何绕过 derive/reserve/verify 就能发出的 HTTP 模型请求；非 Pilot 会话零行为变化；全部离线验证。
