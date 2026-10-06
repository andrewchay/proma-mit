# 订阅服务部署与上线清单

本文档面向部署运维，说明如何把订阅服务从「代码就绪」推进到「真实收款」。
**所有支付渠道凭据必须由具备资质的主体从官方平台获取，代码中不包含任何真实凭据。**

## 一、当前完成度

| 能力 | 状态 |
| --- | --- |
| 权益领域模型与签名快照 | 已完成 |
| 独立订阅服务（持久化、认证、权益签发） | 已完成 |
| 微信支付 API v3 回调验签与解密 | 已完成 |
| 支付宝 RSA2 异步通知验签 | 已完成 |
| 下单预支付与主动查单 | 已完成 |
| 到期降级、退款收回、状态推导 | 已完成 |
| 本地联调环境（Docker + 密钥生成） | 已完成 |
| 零依赖端到端冒烟测试（28 项断言） | 已完成 |
| 应用内订阅引导页 | 已完成 |
| **真实邮件服务（Resend API Key + 域名）** | **待用户提供** |
| **真实渠道凭据与商户签约** | **待用户提供** |
| **真实渠道下单接口联调** | **待凭据到位后进行** |

## 二、本地联调（无需任何外部依赖）

拿到凭据之前，可以用内存模式完整验证业务链路。数据不持久化，仅用于自检。

### 1. 跑通端到端冒烟测试

```bash
cd apps/subscription-service
bun run smoke
```

该脚本在零外部依赖下验证 28 项断言，覆盖：

- schema 初始化与套餐种子数据
- 邮箱验证码存储（只存哈希，不存明文）
- 账号创建与令牌签发
- 微信回调验签与 AES-GCM 解密
- 篡改请求体、伪造签名、他用密钥签名均被拒绝
- 订单支付、权益开通为 pro、重复回调幂等
- 客户端用公钥验签快照，篡改后验签失败
- 退款收回权益、重复退款不生效
- 到期订阅扫描与降级
- 生产环境缺少密钥时拒绝启动

### 2. 启动服务并手工验证

```bash
cd apps/subscription-service
bun run dev:memory
```

服务默认监听 `127.0.0.1:4310`。验证：

```bash
# 健康检查
curl http://127.0.0.1:4310/healthz
# {"ok":true}

# 请求验证码（开发环境验证码打印在服务控制台，不真的发邮件）
curl -X POST http://127.0.0.1:4310/v1/auth/email/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'

# 从服务控制台复制验证码后完成登录
curl -X POST http://127.0.0.1:4310/v1/auth/email/verify \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"123456"}'
```

服务控制台会输出类似：

```text
[email] 未配置邮件服务，验证码（仅开发可见）: 620681
```

### 3. 让客户端连上本地服务

在应用内进入「设置 → 订阅与账户 → 服务地址」，填入：

```text
http://127.0.0.1:4310
```

服务地址也可通过环境变量指定（优先级低于用户在设置中填写的值）：

```bash
GRAVITAS_SUBSCRIPTION_SERVICE_URL=http://127.0.0.1:4310
```

## 三、上线前置资质

以下资质无法由开发工作替代，必须由经营主体自行申请。

### 微信支付

1. 企业或个体工商户营业执照（个人主体无法申请商户号）
2. 微信支付商户号 `mchId`（商户平台申请，审核约 1–5 工作日）
3. 与服务号/小程序关联的 AppID `appId`
4. API v3 密钥 `apiV3Key`（商户平台自行设置，32 位）
5. 商户 API 证书（`apiclient_key.pem` 与证书序列号 `serialNo`）
6. 微信支付平台证书公钥（用于回调验签）

### 支付宝

1. 企业营业执照
2. 开放平台账号与应用 `appId`
3. 应用私钥与支付宝公钥
4. 签约「电脑网站支付」或「APP 支付」产品

### 服务端

1. 公网可访问的 HTTPS 域名（回调地址必须公网可达）
2. 若服务器在中国大陆，域名需完成 ICP 备案
3. PostgreSQL 实例

### 邮件服务（邮箱验证码登录）

1. Resend 账号与 API Key（免费档 3000 封/月）
2. 一个自有域名，并配置 SPF 与 DKIM 记录（Resend 要求域名验证）
3. `SUBSCRIPTION_EMAIL_FROM` 必须使用已验证域名下的地址

**若未配置邮件服务**：生产环境发码会直接失败（返回 503），不会静默降级。

### 第三方登录（可选）

1. GitHub OAuth App 的 clientId / clientSecret
2. Google OAuth Client 的 clientId / clientSecret

## 四、部署步骤

### 1. 启动本地联调环境

```bash
# 在项目根目录
docker compose up -d

# 确认数据库就绪
docker compose ps
```

### 2. 生成服务端密钥

```bash
cd apps/subscription-service
bun run scripts/generate-keys.ts --out .env
```

脚本会生成权益签名密钥对与 access token 密钥，文件权限为 600。
`.env` 已在 `.gitignore` 中，但仍需确认不会被提交。

### 3. 填入支付渠道凭据

编辑 `apps/subscription-service/.env`，取消注释并填入上一步获取的凭据：

```bash
WECHAT_PAY_APP_ID="wx..."
WECHAT_PAY_MCH_ID="16..."
WECHAT_PAY_API_V3_KEY="32位密钥"
WECHAT_PAY_SERIAL_NO="商户证书序列号"
WECHAT_PAY_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
WECHAT_PAY_NOTIFY_URL="https://your-domain.com/v1/payments/wechat/notify"

ALIPAY_APP_ID="2021..."
ALIPAY_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
ALIPAY_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"
ALIPAY_NOTIFY_URL="https://your-domain.com/v1/payments/alipay/notify"
```

邮件与第三方登录（可选）：

```bash
RESEND_API_KEY="re_..."
SUBSCRIPTION_EMAIL_FROM="Gravitas <noreply@your-domain.com>"

GITHUB_OAUTH_CLIENT_ID="..."
GITHUB_OAUTH_CLIENT_SECRET="..."
GITHUB_OAUTH_REDIRECT_URI="https://your-domain.com/oauth/github/callback"

GOOGLE_OAUTH_CLIENT_ID="..."
GOOGLE_OAUTH_CLIENT_SECRET="..."
GOOGLE_OAUTH_REDIRECT_URI="https://your-domain.com/oauth/google/callback"
```

公网部署还需注意（均有安全默认值）：

```bash
# 监听地址。默认 127.0.0.1，置于反向代理后时保持默认即可
# SUBSCRIPTION_SERVICE_HOSTNAME="127.0.0.1"

# CORS 白名单。留空表示不允许任何浏览器来源（Electron 客户端不受影响）
SUBSCRIPTION_ALLOWED_ORIGINS="https://your-domain.com"

# 可信反向代理网段。必须配置才能正确识别真实客户端 IP 并限流
SUBSCRIPTION_TRUSTED_PROXY_CIDRS="10.0.0.0/8"
```

PEM 内容中的换行需转义为 `\n`。`generate-keys.ts` 输出的格式可直接参考。

### 4. 启动服务

```bash
cd apps/subscription-service
bun run start
```

验证健康检查：

```bash
curl https://your-domain.com/healthz
# {"ok":true}
```

### 5. 配置回调地址

在微信支付商户平台与支付宝开放平台，把回调地址设置为上一步的 `notifyUrl`。

## 五、安全约束（不可绕过）

代码层面已强制的约束，部署时不要修改：

1. **回调必须验签**：微信使用平台公钥验签 + APIv3 密钥解密；支付宝使用支付宝公钥 RSA2 验签。请求体中的任何自述字段（如 `verified`）都不被信任。
2. **未配置凭据时拒绝回调**：返回 503，不会静默降级为「不验签」。
3. **金额严格比对**：回调金额与订单金额不一致时拒绝发放权益。
4. **幂等**：以渠道流水号为幂等键，重复通知不会重复发放权益。
5. **时间戳容差**：微信回调时间戳超出 5 分钟窗口一律拒绝，防止重放。
6. **退款立即收回**：退款通知到达后撤销订阅并签发 free 权益。
7. **密钥不入库不进 Git**：所有私钥经环境变量注入，`.env` 已被 gitignore。

## 六、验证清单

上线前逐项确认：

- [ ] `docker compose up -d` 后数据库健康
- [ ] `bun run scripts/generate-keys.ts --out .env` 生成的文件权限为 600
- [ ] `git status` 中不包含 `.env` 或任何含密钥的文件
- [ ] `bun test` 全部通过
- [ ] `bun run typecheck` 通过
- [ ] `/healthz` 返回 `{"ok":true}`
- [ ] 微信支付：用 0.01 元测试订单完成一次真实支付，确认权益开通
- [ ] 微信支付：确认伪造回调（无签名）被拒绝
- [ ] 支付宝：用 0.01 元测试订单完成一次真实支付，确认权益开通
- [ ] 支付宝：确认 `app_id` 不匹配的通知被拒绝
- [ ] 申请一次测试退款，确认权益被收回
- [ ] 客户端断网超过 72 小时后确认降级为 free

## 七、常见问题

**回调一直收不到**

确认 `notifyUrl` 是公网可访问的 HTTPS 地址。微信支付会校验域名可达性；若服务器在中国大陆，未备案域名可能被拦截。

**回调返回 400**

检查日志中的 `reason` 字段。`provider_not_configured` 说明环境变量未生效；`signature_mismatch` 说明平台公钥配置错误。

**权益未开通但回调返回成功**

检查订单金额与回调金额是否一致。金额不符会返回 400 且不发放权益。

**退款后权益未收回**

确认退款通知已到达。若渠道未推送退款通知，需通过 `SubscriptionLifecycleService.handleRefund` 手动触发。
