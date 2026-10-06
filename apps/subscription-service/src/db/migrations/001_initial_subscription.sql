-- 订阅服务数据库结构
--
-- 本轮变更（0002）：
-- 1. subscription_accounts 增加 email_hash / email_verified_at，
--    保留 phone_hash 以兼容既有数据，但新登录流程不再使用
-- 2. 新增 subscription_email_otp 表，用于邮箱验证码
-- 3. 新增 subscription_oauth_states 表，用于 OAuth state 防 CSRF
-- 4. 新增 subscription_plans 种子数据（此前缺失，导致下单外键失败）

CREATE TABLE IF NOT EXISTS subscription_accounts (
  id TEXT PRIMARY KEY,
  phone_hash TEXT UNIQUE,
  email_hash TEXT UNIQUE,
  email_verified_at BIGINT,
  oauth_subject_hash TEXT UNIQUE,
  display_name TEXT,
  disabled_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_accounts_email_idx
  ON subscription_accounts (email_hash);

CREATE TABLE IF NOT EXISTS subscription_auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES subscription_accounts(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT,
  revoked_at BIGINT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_auth_sessions_account_idx
  ON subscription_auth_sessions (account_id, expires_at);

-- 邮箱验证码。
-- 只存验证码哈希而非明文，避免数据库泄露后被直接使用。
CREATE TABLE IF NOT EXISTS subscription_email_otp (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  consumed_at BIGINT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_email_otp_lookup_idx
  ON subscription_email_otp (email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS subscription_email_otp_expiry_idx
  ON subscription_email_otp (expires_at);

-- OAuth 授权流程的 state 值，用于防 CSRF 与串联回调
CREATE TABLE IF NOT EXISTS subscription_oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  consumed_at BIGINT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_oauth_states_expiry_idx
  ON subscription_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_price_cny INTEGER NOT NULL,
  yearly_price_cny INTEGER NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES subscription_accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  provider TEXT NOT NULL,
  amount_cny NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  period TEXT NOT NULL DEFAULT 'monthly',
  provider_transaction_id TEXT UNIQUE,
  expires_at BIGINT NOT NULL,
  paid_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_orders_account_idx
  ON subscription_orders (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS subscription_orders_pending_idx
  ON subscription_orders (account_id, status, expires_at);

CREATE TABLE IF NOT EXISTS subscription_payment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES subscription_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  payload_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscription_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES subscription_accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES subscription_plans(id),
  order_id TEXT NOT NULL REFERENCES subscription_orders(id),
  status TEXT NOT NULL,
  current_period_start BIGINT NOT NULL,
  current_period_end BIGINT NOT NULL,
  auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_subscriptions_active_idx
  ON subscription_subscriptions (account_id, status, current_period_end);

CREATE TABLE IF NOT EXISTS subscription_entitlement_revisions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES subscription_accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL,
  valid_until BIGINT,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (account_id, revision)
);

CREATE TABLE IF NOT EXISTS subscription_device_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES subscription_accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  bound_at BIGINT NOT NULL,
  UNIQUE (account_id, device_id)
);

-- 套餐种子数据。
-- 此前 schema 只有建表没有数据，而 orders/subscriptions 的 plan_id 有外键约束，
-- 导致首次下单必然失败。此处以 ON CONFLICT 保证可重复执行。
INSERT INTO subscription_plans (id, name, monthly_price_cny, yearly_price_cny, capabilities, active, created_at, updated_at)
VALUES
  ('free', '免费版', 0, 0, '[]'::jsonb, TRUE, 0, 0),
  ('pro', '专业版', 68, 680, '["influencer","paid-media","outbound-sourcing"]'::jsonb, TRUE, 0, 0)
ON CONFLICT (id) DO NOTHING;
