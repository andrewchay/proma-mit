# Gravitas 订阅服务运维指南

## 密钥管理

- `SUBSCRIPTION_ACCESS_TOKEN_SECRET`：用于签名短时 access token，生产环境必须通过密钥管理服务注入。
- `SUBSCRIPTION_ENTITLEMENT_PRIVATE_KEY_PEM` / `SUBSCRIPTION_ENTITLEMENT_PUBLIC_KEY_PEM`：用于签名/验证权益快照，私钥绝不进入 Git 或客户端。
- 微信支付/支付宝的商户私钥、平台证书、API v3 密钥等仅保存在部署环境的密钥管理中，客户端只接收订单二维码或跳转链接。

## 支付回调

- 回调入口：`/webhooks/wechat`、`/webhooks/alipay`。
- 必须先验签，再校验订单归属与金额，最后以事务推进订单、订阅与权益审计。
- 所有回调使用幂等键去重，重复回调返回成功但不重复发权益。

## 权益与宽限

- 客户端每次启动、登录、购买完成和固定周期刷新权益。
- 网络不可用时，仅在最近成功校验后的 72 小时宽限期内继续使用已有权益。
- 退款、到期、撤销和登出后，下一次刷新会收回对应能力。

## 数据与审计

- 订阅数据存储在 PostgreSQL，关键表：`subscription_accounts`、`subscription_auth_sessions`、`subscription_orders`、`subscription_subscriptions`、`subscription_entitlement_revisions`。
- 审计事件不记录 access token、refresh token、商户私钥、支付证书或完整敏感回调负载。

## 降级与事故处理

- 订阅服务不可用时，客户端按宽限策略降级为免费功能。
- 支付验签失败、金额不匹配、订单归属错误时拒绝变更并记录审计。
- 需要轮换密钥时，先轮换服务端签名私钥，再发布客户端公钥集合。

## 测试与验收

- 单元测试使用 `PROMA_TEST_CONFIG_DIR` 隔离配置，不写入真实 `~/.gravitas/`。
- 真实支付链路仅在显式配置官方沙箱凭据后单独验收，不得把 skip 记为通过。
