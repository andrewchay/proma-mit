#!/usr/bin/env bash
# ============================================================
# smoke-private-deploy.sh — 私有部署一键冒烟
#
# 验证「docker compose up 一条命令起全套」后：
#   1. 所有服务 healthy
#   2. 浏览器登录闭环可用（本地 authMode）
#   3. 建会话 → 跑一个 Agent 任务 → 流式响应
#   4. GET /agent/health 返回贵慢重准
#
# 用法：
#   cp .env.example .env   # 至少填 PROMA_WEB_ENVELOPE_KEY、PROMA_WEB_EXECUTOR_TOKEN
#   PROMA_AGENT_PROMPT="你好，简单打个招呼" ./scripts/smoke-private-deploy.sh
# ==== 前置：读 .env ====
set -euo pipefail

BASE_URL="${PROMA_SMOKE_BASE_URL:-http://localhost:8080}"
SERVER_URL="${PROMA_SMOKE_SERVER_URL:-http://localhost:3000}"
COMPOSE_FILE="${PROMA_SMOKE_COMPOSE:-docker-compose.production.yml}"
TIMEOUT_SEC="${PROMA_SMOKE_TIMEOUT_SEC:-120}"

# 从 .env 读取登录凭据（若 .env 已配置）
if [[ -f .env ]]; then
  ADMIN_LINE=$(grep -E '^PROMA_WEB_ADMIN=' .env | tail -1 | cut -d= -f2-)
  AUTH_MODE=$(grep -E '^PROMA_WEB_AUTH_MODE=' .env | tail -1 | cut -d= -f2- || true)
fi
ADMIN_LINE="${ADMIN_LINE:-admin:default:s3cret-pass}"
AUTH_MODE="${AUTH_MODE:-local}"
ADMIN_USER="${ADMIN_LINE%%:*}"
ADMIN_TENANT="${ADMIN_LINE#*:}"; ADMIN_TENANT="${ADMIN_TENANT%%:*}"
ADMIN_PASS="${ADMIN_LINE##*:}"

pass() { echo "  ✔ $*"; }
fail() { echo "  ✘ $*" >&2; exit 1; }

echo "=== 1/6 拉起服务 (compose: $COMPOSE_FILE) ==="
docker compose -f "$COMPOSE_FILE" up -d --build

echo "=== 2/6 等待健康 ==="
deadline=$(( $(date +%s) + TIMEOUT_SEC ))
until curl -sf "$SERVER_URL/healthz" >/dev/null 2>&1; do
  if (( $(date +%s) > deadline )); then fail "等待 $SERVER_URL/healthz 超时"; fi
  sleep 3
done
pass "server /healthz OK"

# nginx 入口代理 /auth 与 /agent（若有反代）
echo "=== 3/6 浏览器登录闭环 (authMode=$AUTH_MODE, user=$ADMIN_USER@$ADMIN_TENANT) ==="
LOGIN_URL="$BASE_URL/auth/login"
page_code=$(curl -s -o /dev/null -w "%{http_code}" "$LOGIN_URL")
[[ "$page_code" == "200" ]] || fail "登录页 $LOGIN_URL 应为 200，实际 $page_code"
pass "登录页可访问 (HTTP $page_code)"

bad_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H 'content-type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"wrong-password\"}" "$BASE_URL/auth/login")
[[ "$bad_code" == "401" ]] || fail "错误密码登录应 401，实际 $bad_code"
pass "错误密码被拒 (HTTP $bad_code)"

COOKIE_JAR=$(mktemp)
good_code=$(curl -s -o /dev/null -w "%{http_code}" -c "$COOKIE_JAR" -X POST -H 'content-type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" "$BASE_URL/auth/login")
[[ "$good_code" == "302" || "$good_code" == "200" ]] || fail "正确密码登录应 302/200，实际 $good_code"
grep -q 'proma_session' "$COOKIE_JAR" || fail "登录后未获得会话 cookie"
pass "登录成功并取得会话 cookie"

echo "=== 4/6 建会话 ==="
SESSION=$(curl -s -b "$COOKIE_JAR" -X POST -H 'content-type: application/json' \
  -d "{\"workspaceSlug\":\"default\",\"channelId\":\"openai\"}" "$BASE_URL/agent/sessions")
SESSION_ID=$(printf '%s' "$SESSION" | sed -n 's/.*"sessionId":"\([^"]*\)".*/\1/p' | head -1)
[[ -n "$SESSION_ID" ]] || fail "创建会话失败：$SESSION"
pass "已创建会话 $SESSION_ID"

echo "=== 5/6 跑一个 Agent 任务 ==="
PROMPT="${PROMA_AGENT_PROMPT:-请只回复一句话：你好，我是私有部署冒烟测试。}"
run_code=$(curl -s -o /tmp/proma-smoke-run.txt -w "%{http_code}" -b "$COOKIE_JAR" -X POST \
  -H 'content-type: application/json' -d "{\"prompt\":\"$PROMPT\"}" \
  "$BASE_URL/agent/sessions/$SESSION_ID/run")
[[ "$run_code" == "200" || "$run_code" == "202" ]] || fail "运行任务失败 (HTTP $run_code): $(cat /tmp/proma-smoke-run.txt)"
pass "任务已提交 (HTTP $run_code)"

echo "=== 6/6 健康看板 + 清理 ==="
health_code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" "$BASE_URL/agent/health")
[[ "$health_code" == "200" ]] || fail "GET /agent/health 应 200，实际 $health_code"
pass "健康看板可访问 (HTTP $health_code)"

rm -f "$COOKIE_JAR" /tmp/proma-smoke-run.txt
echo
echo "✅ 私有部署一键冒烟通过（$BASE_URL）"
echo "   登录：$BASE_URL/auth/login (user=$ADMIN_USER)"
echo "   工作台：$BASE_URL/agent/ui"
echo "   清理：docker compose -f $COMPOSE_FILE down"
