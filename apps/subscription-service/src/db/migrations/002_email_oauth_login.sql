-- 迁移 002：邮箱验证码与 OAuth 登录
--
-- 1. accounts 增加 email_hash / email_verified_at
-- 2. 新增 email_otp 与 oauth_states 表
-- 3. 补齐 plans 种子数据
--
-- 说明：001 已包含完整结构（新装环境直接执行 001 即可）。
-- 本文件用于已按旧版结构建库的环境增量升级。

ALTER TABLE subscription_accounts
  ADD COLUMN IF NOT EXISTS email_hash TEXT;

ALTER TABLE subscription_accounts
  ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS subscription_accounts_email_hash_key
  ON subscription_accounts (email_hash);

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

CREATE TABLE IF NOT EXISTS subscription_oauth_states (
  state TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  code_verifier TEXT,
  redirect_uri TEXT,
  consumed_at BIGINT,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

INSERT INTO subscription_plans (id, name, monthly_price_cny, yearly_price_cny, capabilities, active, created_at, updated_at)
VALUES
  ('free', '免费版', 0, 0, '[]'::jsonb, TRUE, 0, 0),
  ('pro', '专业版', 68, 680, '["influencer","paid-media","outbound-sourcing"]'::jsonb, TRUE, 0, 0)
ON CONFLICT (id) DO NOTHING;
