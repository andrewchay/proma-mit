# 两日迭代代码审查报告（S1→M4，2026-08-13）

> 审查时间：2026-08-13 21:00 GMT+8
> 审查范围：git diff `53bb8d03^ HEAD`（S1 Agent Card → M4 Sub Agent 树，22 commits）
> 审查方式：2 个 review 子代理并行 + 主 Agent 复核关键点 + 全量测试回归
> 审查对象：40 个改动文件（server auth/registry/audit/dashboard + electron 契约层 + shared 类型 + 部署层）

---

## 一、总体结论

**代码可合入，但存在 1 个 HIGH 功能缺陷和 2 个 HIGH 安全/认证隐患，且"登录闭环已闭合"的结论需修正**——因为之前 M1/M3 的真实环境验证用的是 `curl` 手动设 JSON content-type，**掩盖了真实浏览器登录表单打不通这个 bug**。

另外发现：**shared 有 1 个 pre-existing 测试失败**（`normalizeAgentRuntime('unknown')` 期望 claude 返回 pi），`agent.ts` 这两天没被改过，与本次改动无关。

测试回归结果：
- server：**119 pass / 0 fail** ✅
- shared：**125 pass / 1 fail**（pre-existing，与本次无关）
- electron 契约层新增测试：15 pass / 0 fail ✅

---

## 二、按严重程度分级的问题清单

### 🔴 HIGH（需修复才能算"闭环闭合"）

**H-1｜真实浏览器本地登录表单打不通（功能缺陷）**
- 位置：`apps/server/src/app.ts:349`（/auth/login POST 读 `request.json()`）+ `auth-routes.ts` 的 `loginPageHtml`（form 无 enctype）
- 现象：HTML form 提交默认 `application/x-www-form-urlencoded`，但 handler 只读 JSON → **浏览器点登录恒 400 "请求体必须是 JSON"**
- 为何没被发现：M1/M3 冒烟用 `curl -X POST -H 'content-type: application/json'`，绕过了 HTTP content-type 层；`auth-routes.test.ts` 的函数级测试也绕过了这层
- 影响：M1 "登录闭环已闭合" 的结论**不成立**——真实用户在浏览器打不开登录
- 修复：`/auth/login` POST 同时兼容 JSON 与 `application/x-www-form-urlencoded`（读 body 时先看 content-type），或改 form 加 `enctype` + 前端改 fetch JSON。推荐前者（兼容 curl 冒烟 + 浏览器表单）

**H-2｜OIDC id_token 未做签名校验（认证缺陷）**
- 位置：`apps/server/src/auth-routes.ts:116` `defaultOidcTokenFromCode`
- 现象：只 base64url decode claims，**无 JWKS 签名/iss/aud/exp 校验**（对比 `jwt-auth.ts` 严格走 JWKS 验签）
- 为何危险：`app.ts` 未注入 `oidcTokenFromCode`，走的就是这条不验签路径。同 IdP 受众内的用户可篡改自己的 `sub/tenant_id/roles` 声明 → roles 直接决定 `/agent/audit`、`/agent/billing`、`/agent/registry PUT` 的 admin/operator 权限 → **提权**。代码注释已承认这是"简化占位"。
- 修复：复用 `jwt-auth.ts` 的 JWKS 校验逻辑验证 id_token（或注入一个真正验签的 `oidcTokenFromCode`）

**H-3｜OIDC 回调无 state 校验（Login CSRF）+ 本地/local 模式 Bearer 认证回归**
- 位置：`auth-routes.ts` `oidcStart`（生成 state 不持久化）+ `oidcCallback`（忽略 state）
- 现象：OIDC 回调无 state 校验 → Login CSRF；无 state 持久化
- 修复：生成 state 时存入会话（sessionStorage/内存 map），回调时校验
- **另**：`index.ts` 的 `bearerAuth` 仅在 `!trustedHeaderAuth && oidcConfigured` 创建。local 模式（无 OIDC）下唯一认证是 cookie 会话，**既有用 Bearer token 的 API 集成被 401 切断**（dashboard 的 Bearer 输入框也失效）。这是行为回归，需文档说明或提供 local 模式下的 API token 方案

### 🟠 MEDIUM

- **M-1｜契约状态机 `stale` 语义矛盾**：`isExecutionContractTerminal('stale')===true` 与 `VALID_TRANSITIONS.stale=['running']` 冲突（helper 判 stale 终态，状态机又允许它回 running）。建议引入 `isRecoverable()` 或统一语义
- **M-2｜binder 对"未 start 即 complete/fail"幂等兜底失真**：queued 直通 completed 非法，catch 后 store 停在 queued 但返回值带 result → 状态与 store 不符
- **M-3｜契约层未接入生产**：`execution-contract-service/binder` 无 production 引用（纯能力库），不会与 AgentExecution 冲突（因为没接线），但一旦接入需设计单写入口
- **M-4｜audit append 并发安全**：读链尾+插入两次查询无事务，并发下可能断链误报篡改（我已标注为已知取舍，单节点低风险但多 worker 会放大）
- **M-5｜purge 跨用户破坏链**：`purgeBefore` 按 (tenant,user) 删，`verifyChain` 按 tenant 校验 → 一个用户的合规清档会致同租户其他用户审计链 invalid
- **M-6｜dashboard health/span 数值字段未 `es()` 转义**：当前是 number 类型无 XSS，但缺纵深防御，未来字段变字符串即反射 XSS
- **M-7｜会话 cookie 无 `Secure` 标志**：compose 默认明文 HTTP，session cookie 可被网络嗅探

### 🟡 LOW

- L-1 admin 明文口令常驻 env
- L-2 health "本月"用 30 天滚动窗口
- L-3 logout 不销毁服务端会话（仅清 cookie，DB 行留到 TTL）

---

## 三、发现的其他重要问题

### 契约层"孤立"判断
`execution-contract-binder.ts`、`execution-contract-service.ts`、`agent-registry-service.ts` **均无生产代码引用**。这是**设计决策**（计划里明确"契约层独立交付，不强接入"），不算冲突，但需要：
- 明确它们不会被当成"死代码"清理
- 规划接入时设计单写入口（避免与 handleExecutionComplete 双回写）

### dashboard XSS（H-1 相关，被单独标注）
`renderSessions` 的三处按钮 `onclick="...renameSession('+x.sessionId+')"` 用 `sessionId` 未转义（对比 `pick()` 用 `JSON.stringify().replaceAll('"','&quot;')`）。`sessionId` 来自 `#session` 输入框（用户可控）→ **stored/self-XSS**。修复：改用 `data-session-id` 属性 + 事件委托，或用与 `pick()` 一致的转义。

---

## 四、值得肯定的部分

- **agent-registry**：SQL 全参数化无注入、租户隔离正确验证过
- **jwt-auth Bearer 验签链未被破坏**（`createOidcJwtAuth` 严格验签）——但只在 oidc 模式启用
- **authMode 启动策略**：trusted-header 限制 loopback+dev 方向正确
- **dashboard XSS 基线良好**：registry/任务树/数据集视图都正确用了 `es()`
- **契约状态机有 `VALID_TRANSITIONS` + 非法迁移测试覆盖**
- **shared 类型纯增量**，无重名冲突、无既有导出破坏
- **dashboard JS 语法完整**（node --check 通过、script 闭合=1）

---

## 六、修复进度（2026-08-13 22:00 UTC+8）

### ✅ 已修复（commit `607e6b9b` + `269921f8`）
| 问题 | 修复 | 验证 |
|---|---|---|
| **H-1** 登录表单打不通 | `readLoginCredentials` 兼容 JSON + urlencoded；app.ts 改用 | 真实 HTTP urlencoded → 302；app.test.ts 新增 HTTP 级测试防回归 |
| **H-2** OIDC id_token 未验签 | 抽取 `verifyJwtWithJwks` 复用 JWKS 验签；缺 jwksUrl/issuer/audience 时拒绝 | typecheck + 全量通过 |
| **H-3a** OIDC 无 state 校验 | `oidcStart` 持久化 state（TTL 内存 store，一次性），`oidcCallback` 校验，防重放 | +3 测试（含重放拒绝）|
| **S-XSS** sessionId 未转义 | `data-session-id`（转义）+ `data-op` + `sessOp(this)` 事件委托 | node --check 通过，真实 server 加载正常 |

### ⚠️ 待处理 / 需决策（H-3b + P2）
- **H-3b local 模式 Bearer 回归** → ✅ **已处理（document + UI）**：`GET /auth/status` 暴露 authMode，dashboard 在 local/none 模式隐藏 Bearer 输入框并提示；`.env.example` 与 private-deployment-minimal 文档明确 local 模式仅会话 cookie。需要 Bearer/API token → 配 oidc/both。
- **M-1 契约 stale 语义矛盾**（`isExecutionContractTerminal('stale')` vs `VALID_TRANSITIONS.stale=['running']`）：契约层未接入生产，可留待接入时统一为 `isRecoverable()`。
- **M-2 binder 幂等兜底失真**（queued 直通终态）：同上，接入时修。
- **M-4 audit append 并发安全**（两次查询无事务）：已知取舍，单节点低风险；多 worker 需事务/触发器（P8-3）。
- **M-5 purge 跨用户破坏链**：设计上有意（清理会断链被察觉），但跨用户连锁需文档说明。
- **M-6/M-7/L 系列**：低风险，可后续再议。

### 修复后的测试基线
- server 全量 **127 pass / 0 fail**，typecheck 干净
- 新增覆盖：urlencoded 登录、OIDC state CSRF、state 重放拒绝、app 层 HTTP 登录、`/auth/status`
- shared 唯一失败仍为 pre-existing（`agent.test.ts` normalizeAgentRuntime，与本轮无关）
