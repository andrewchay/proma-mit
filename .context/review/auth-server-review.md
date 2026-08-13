# 代码审查：Gravitas server 新增/修改代码（S1–M4，53bb8d03^..HEAD）

审查角色：review
审查范围：`apps/server/src/` 下的登录/会话、agent-registry、audit hash chain、authMode 接线，以及部署层（compose/nginx/Dockerfile/env）。
方法：读取源码 + 单元测试，重点判断测试是否真正覆盖风险路径，而非只看有无测试。
结论：**整体可合入的基础已具备，但存在 1 个必须修复的认证漏洞（OIDC id_token 未验签）和 1 个功能回归（本地登录表单无法在浏览器使用），另有多处中危需在合入前或紧随其后的迭代修掉。**

---

## 严重程度分布

| 级别 | 数量 | 核心 |
|------|------|------|
| critical | 1 | OIDC id_token 未验签（可伪造身份/提权） |
| high | 3 | 本地登录表单 content-type 不匹配（登录闭环实际不可用）；OIDC callback 无 state 校验（login CSRF）；local 模式下 Bearer API 认证消失（与既有链路的回归冲突） |
| medium | 7 | cookie 无 Secure；logout 不销毁服务端会话；audit append 非并发安全；purge 破坏整租户链；OIDC 授权码模式信任 roles 声明；会话 cookie 无过期清理；`seq` 字段硬编码死字段 |
| low | 2 | admin 明文口令存在于 env；health 30 天滚动窗口与"本月"语义不符 |

---

## Critical

### C-1. OIDC id_token 未做签名/证书校验，可伪造身份与角色
- **文件**：`apps/server/src/auth-routes.ts` `defaultOidcTokenFromCode`（约 116–140 行）
- **现象**：OIDC callback 用的默认 token 交换函数，仅 base64url 解码 `id_token` 的 claims，**完全没有** JWKS 签名校验、iss/aud/exp 校验（对照 `jwt-auth.ts` 的 `createOidcJwtAuth` 是严格验签+验 issuer/audience/时效的）。
- **原因**：代码注释明确承认"由于缺少 JWT 校验 base，先做最小解析占位，真实校验在接线层补"。但 `app.ts` 的 `authRoutesDeps` **未注入** `oidcTokenFromCode`，因此实际运行时就是走这条不验签的默认路径。token 响应的 `sub`/`tenant_id`/`roles` 声明被直接采信。
- **风险**：只要攻击者是同一 IdP 受众内的合法用户（拿到自己的一次性 code），token endpoint 会返回*属于他本人*的 id_token；由于不验签也不校验 claims，攻击者对 claims 做任何篡改都无法被检测。若 IdP 的 token 流程允许客户端通过查询参数/请求影响 claims，或 jwt 本身可被拦截重放，将对 `roles`（其值直接决定 `/agent/audit`、`/agent/billing`、`/agent/registry` PUT 等 admin/operator 权限）实现提权。
- **修复建议**：把 `defaultOidcTokenFromCode` 替换为复用 `createOidcJwtAuth`（或 `jwt-auth.ts`）的 JWKS RS256 验签+iss/aud 校验逻辑后再抽取 claims；在 `app.ts` 显式注入一个验签实现，禁止走"未校验"默认值。

---

## High

### H-1. 本地登录表单无法在真实浏览器中使用（函数回归）
- **文件**：`apps/server/src/auth-routes.ts`（`loginPageHtml` 的 `<form method="post" action="/auth/login">`）与 `apps/server/src/app.ts` `/auth/login` POST 分支（`await request.json()`）
- **现象**：登录页 HTML 表单为原生 form（无 `enctype`，浏览器以 `application/x-www-form-urlencoded` 提交），但服务端 `app.ts` 只按 `request.json()` 读取 body。浏览器提交 → JSON 解析抛错 → 恒返回 `400 "请求体必须是 JSON"`。
- **验证**：`auth-routes.test.ts` 用 `loginForm({username, password})` 直接调函数（绕过了 HTTP content-type 层），**未覆盖**浏览器真实 POST 的 urlencoded 路径；`app.test.ts` 也无整链覆盖。所以登录闭环在真实浏览器里实际上打不通。
- **修复建议**：`/auth/login` 同时处理 `application/json` 与 `application/x-www-form-urlencoded`（按 `content-type` 分派），或前端改为 `fetch`+JSON（若 dashboard SPA 已改为 JSON，则把登录页 form 换成对应 fetch 提交，并补一个真实 HTTP 集成测试）。

### H-2. OIDC callback 无 state 校验（login CSRF）
- **文件**：`apps/server/src/auth-routes.ts` `oidcStart`（生成随机 state 但未持久化）与 `oidcCallback`（完全不读取/校验 state）
- **现象**：`oidcStart` 生成了 `state` 放入 URL，注释承认 state 不持久化；`oidcCallback` 只取 `code`，**不校验浏览器回传的 state 与发起时是否一致**。
- **风险**：攻击者可诱导已登录/未登录用户发起带自己 code 的回调，强制把用户会话绑定到攻击者账户，或配合 H-2/C-1 造成账户混淆。
- **修复建议**：把 state 存服务端（或签名 cookie），callback 时比对；这是 OIDC 最低安全要求，不是"私有部署最小集可接受"。

### H-3. local 模式下 Bearer API 认证彻底消失（与既有 Bearer 链路冲突/回退回归）
- **文件**：`apps/server/src/index.ts`（`let bearerAuth` 仅在 `!trustedHeaderAuth && oidcConfigured` 时创建）与 `app.ts` 的 `baseAuth = dependencies.auth ?? createTrustedHeaderAuth(...)`
- **现象**：`docker-compose.production.yml` 默认 `PROMA_WEB_AUTH_MODE=local` 且不配 OIDC → `oidcConfigured=false` → `bearerAuth` 为 `undefined` → `baseAuth` 恒为 `createTrustedHeaderAuth(false)` → 永远返回 undefined。于是默认部署下**唯一**认证路径只剩本地 cookie 会话；任何带 `Authorization: Bearer <JWT>` 的既有 API 调用都被 401 拒绝。
- **验证**：dashboard SPA 仍保留"OIDC Bearer token"输入框（`dashboard.ts` 的 `#token`），在 local 模式下该输入变得完全无用；`jwt-auth.ts` 的 Bearer 验证仍有单测，但**没有**任何测试验证 local 模式与 Bearer 的共存，属未覆盖路径。
- **原因**：这是"把 OIDC 从必填改可选"的合理设计目标之一（无 OIDC 时 local 启动），但**没有为 API 客户端保留任何非 cookie 的替代认证**，若历史/第三方集成依赖 Bearer，会静默回归。
- **修复建议**：明确"local 模式是否应支持 API 直连认证"。若要支持，可为 local 模式提供独立的 API 令牌/受控 Bearer 签发；若明确不支持，应在 dashboard 上隐藏/禁用 Bearer 输入框，并在发行说明/文档中标注"local 模式仅支持浏览器 cookie 会话"，同时补一条"local 模式 + Bearer 401"的测试固化预期。

---

## Medium

### M-1. 会话 cookie 未设 `Secure`，且部署默认无 TLS
- **文件**：`auth-routes.ts` `createSessionCookie`；`docker-compose.production.yml`（nginx 监听 80、server 3000，均无 TLS）
- **现象**：`proma_session` 只 `Path=/; HttpOnly; SameSite=Lax; Max-Age`，无 `Secure`；compose 默认走明文 HTTP，会话 cookie 明文可被网络嗅探。
- **修复建议**：cookie 加 `Secure`；生产入口用 HTTPS 终止（nginx 配 TLS/443 或前置 LB），并把 `PROMA_WEB_PUBLIC_BASE_URL` 从 `http` 改为 `https`。

### M-2. logout 不销毁服务端会话记录
- **文件**：`auth-routes.ts` `logout()`（仅发 `Max-Age=0` 过期 cookie）——未调用 `sessionStore.destroy`
- **现象**：服务端 DB 里该 session 行在 TTL（默认 12h）之前仍有效；若攻击者以任何方式已持有该 session id，仍可继续使用。
- **修复建议**：logout 时先 destroy(sessionId) 再发过期 cookie（`AuthHandler.logout` 是同步函数，需要改为可解析 cookie→destroy，或至少接受异步签名）。

### M-3. audit hash chain `append` 非并发安全（真实断链）
- **文件**：`audit.ts` `append`（先 `SELECT hash ... LIMIT 1` 再 `INSERT`，两次查询）
- **现象**：多个并发 append 在读取链尾后拿到相同 `prevHash`，后插入的行 `prev_hash` 与前一行 `hash` 不一致 → `verifyChain` 判定整个租户链 invalid（对合法写入误报篡改）。
- **验证**：`audit-hashchain.test.ts` 覆盖了正常链接与篡改检测，**但没有覆盖并发 append**；注释也承认"极端并发下可能断链"。
- **修复建议**：用事务 + `SELECT ... FOR UPDATE` 或把链尾读取与插入放进同一事务；或接受并记录"并发会断链"，至少加一个并发测试暴露行为。

### M-4. `purgeBefore` 按 (tenant,user) 删除，但 verifyChain 按 tenant 校验 → 误伤同租户其他用户的链完整性
- **文件**：`audit.ts` `purgeBefore`（`WHERE tenant_id=$1 AND user_id=$2 AND created_at<$3`）与 `verifyChain`（`WHERE tenant_id=$1 ORDER BY id ASC`）
- **现象**：审计行按 (tenant,user) 落库但链按 tenant 串联。某用户合规清理会删掉中间节点，导致**整个租户**（含其他用户）的链在 `verifyChain` 下被判 invalid。注释已当成"设计预期"，但这意味着任一合法清档会让全租户的审计器报警，属跨用户副作用。
- **修复建议**：明确语义——要么链按 (tenant,user) 分段校验，要么 purge 采用"软删除/保留头尾桩节点"以维持链，并补充 purge→verifyChain 的测试。

### M-5. OIDC 授权码流程把 `roles`/`tenant_id` 声明直接采信（配合 C-1 放大）
- **文件**：`auth-routes.ts` `defaultOidcTokenFromCode` 的 `readRoles(claims.roles)`、`tenantId = claims.tenant_id`
- **现象**：角色与租户边界完全由声明决定，无验签时谁都能声称 admin 租户；即使验签后，也依赖 IdP 正确签发 `roles`/`tenant_id`，缺少服务端固定的角色来源。
- **修复建议**：验签后用 IdP 的 `sub`+固定映射（或仅接受白名单租户）决定 scope；角色应服务端固定而非盲信声明。

### M-6. 会话表无定期过期清理
- **文件**：`auth-session-store.ts`（仅有 `expires_at` 索引，无清理任务）
- **现象**：过期 session 行会无限累积（`get` 对过期返回 null 但不删除）。
- **修复建议**：加周期 `DELETE ... WHERE expires_at < now`（或随 `get` 惰性清理）。

### M-7. hash 中 `seq` 恒为 1，属死字段且未被行 id/其余字段参与
- **文件**：`audit.ts` `computeHash` 中 `String(input.seq)`，append 与 verifyChain 都传 `seq:1`
- **现象**：链的正确性完全依赖 `prevHash` + 顺序；`seq` 不参与任何区分，两行内容+prev+createdAt 完全相同会产生相同 hash（首条跨租户可重复是测试已接受的），削弱了防拷贝/防重排粒度。
- **修复建议**：把 DB `id` 或递增 seq 纳入 hash 输入以唯一化，并让 `id` 参与哈希。

---

## Low

### L-1. bootstrap 管理员明文口令常驻环境变量
- **文件**：`index.ts`（`parseAdminAccount(adminRaw)`）、`docker-compose.production.yml`（`PROMA_WEB_ADMIN:${PROMA_WEB_ADMIN:?...}`）
- **现象**：口令以 `username:tenant:password` 明文放 env；运行时仅内存哈希一次。相比专门的 secret 管理有泄露面。
- **建议**：用文件/secret 注入，避免进入 compose/ps env；并在文档明确"部署后应改密"。

### L-2. health"本月"统计用 30 天滚动窗口
- **文件**：`app.ts` `getHealthDashboard`（`monthStart = Date.now() - 30*24*60*60*1000`）
- **现象**：与 billing/预算的"自然月"语义不一致，健康度成本/预算占用可能与账单口径略有出入。
- **建议**：改为月初时间戳（已有 `monthStartedAt` 参数可传）。

---

## 测试覆盖缺口（重点：只测"有没有"不够）

- **缺 C-1 覆盖**：`auth-routes.test.ts` 全部用注入的 `oidcTokenFromCode` mock，**从不测默认 `defaultOidcTokenFromCode` 的验签路径** → 未校验直接采信 claims 的缺陷被测试"藏住"。
- **缺 H-1 覆盖**：无真实 HTTP 提交 urlencoded→ `/auth/login` 的集成/端到端测试。
- **缺 H-3 覆盖**：无"local 模式 + Bearer 401 / 无 OIDC 时 Bearer 不可用"的断言。
- **缺 M-3 覆盖**：无并发 append 断链测试（hash chain 篡改检测是被 `audit-hashchain.test.ts` 覆盖了，但并发正确性没有）。
- **缺 M-4 覆盖**：无 purge 后 verifyChain 的行为测试。
- cookie 认证的受保护路径**有** resolver 级测试（`auth-resolvers.test.ts`），但**没有**在 `app.ts` 层验证"cookie 会话能通过 `/agent/audit` 等受保护路由"（app.test.ts 未见此类整链断言）。

---

## 整体结论

代码**可合入但需附明确整改项**，不建议在修复 C-1 与 H-1 前视为"登录闭环已闭合"（提交声称 M1 login closed-loop complete 与 H-1 现实冲突）。

最大的 1–3 条隐患：
1. **OIDC id_token 未验签（C-1）** —— 一旦启用 oidc/both 即存在可伪造身份+提权的认证绕过；这是必须优先修复的安全缺陷。
2. **本地登录表单在真实浏览器不可用（H-1）+ local 模式 Bearer API 认证消失（H-3）** —— 默认本地部署的登录闭环打不通、且既有 API 集成被静默切断，两者叠加让 M1"私有部署最小集"实际体验与宣称不符。
3. **audit hash chain 的非并发安全（M-3）与 purge 跨用户破坏链（M-4）** —— 会让合法写入/合规清档被审计器误报为篡改，削弱链的可信度，需在接入真实流量前明确并发与清档语义。

值得肯定：agent-registry 全程参数化查询（无 SQL 注入），scope/rent 隔离正确；jwt-auth 的 Bearer 验签链路完好未被破坏；cookie 会话 resolver 与 RBAC（`hasAnyRole`/`requireAgentActionRole`）集成正确；authMode 启动策略把 trusted-header 限制在本机开发、未配 OIDC 时可 local 启动，方向合理。主要风险集中在 OIDC 默认实现、登录资源类型分派、以及 local 模式下 API 认证的口径。
