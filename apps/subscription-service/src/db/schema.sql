CREATE TABLE IF NOT EXISTS subscription_accounts (
  id TEXT PRIMARY KEY,
  phone_hash TEXT UNIQUE,
  oauth_subject_hash TEXT UNIQUE,
  display_name TEXT,
  disabled_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

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
  amount_cny INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS subscription_payment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES subscription_orders(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  verified BOOLEAN NOT NULL,
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

CREATE INDEX IF NOT EXISTS subscription_subscriptions_account_idx
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
  label TEXT,
  revoked_at BIGINT,
  created_at BIGINT NOT NULL,
  UNIQUE (account_id, device_id)
);
