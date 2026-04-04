#!/bin/bash
# Security check for NanoClaw VPS deployment.
# Verifies that Docker hasn't exposed internal ports to the internet.
# Run after deploy, after docker compose changes, or on a schedule.
#
# Exit codes: 0 = ok, 1 = security issue found

set -euo pipefail

FAIL=0

echo "==> Security check"

# 1. Check for Docker-exposed ports that should be internal-only.
#    Docker bypasses UFW/firewall — ports in docker-compose "ports:" are
#    open to the internet even if UFW says otherwise.
EXPOSED=$(ss -tlnp 2>/dev/null | grep -E '0\.0\.0\.0:(5432|3306|6379|27017)' || true)
if [ -n "$EXPOSED" ]; then
  echo "FAIL: Database ports exposed on 0.0.0.0 (Docker bypasses UFW!):"
  echo "$EXPOSED"
  echo "  Fix: remove 'ports:' from docker-compose.yml for internal services"
  FAIL=1
fi

# 2. Check that OneCLI ports are blocked from external access via DOCKER-USER.
for PORT in 10254 10255; do
  RULE=$(sudo iptables -L DOCKER-USER -n 2>/dev/null | grep "tcp dpt:$PORT" | grep DROP || true)
  if [ -z "$RULE" ]; then
    echo "FAIL: Port $PORT has no DROP rule in DOCKER-USER chain"
    echo "  Fix: sudo iptables -A DOCKER-USER -p tcp --dport $PORT -j DROP"
    FAIL=1
  fi
done

# 3. Check that OneCLI PostgreSQL has a non-default password.
ONECLI_ENV="$HOME/.onecli/.env"
if [ -f "$ONECLI_ENV" ]; then
  if grep -q 'POSTGRES_PASSWORD=onecli' "$ONECLI_ENV" 2>/dev/null; then
    echo "FAIL: OneCLI PostgreSQL still using default password"
    FAIL=1
  fi
else
  # Check if OneCLI is running at all before flagging
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q onecli; then
    echo "FAIL: OneCLI running but no .env with custom password ($ONECLI_ENV missing)"
    FAIL=1
  fi
fi

# 4. Check that .ssh is not in mount allowlist.
ALLOWLIST="$HOME/.config/nanoclaw/mount-allowlist.json"
if [ -f "$ALLOWLIST" ]; then
  if grep -qi '\.ssh\|/home.*ssh' "$ALLOWLIST"; then
    echo "FAIL: .ssh appears in mount allowlist — agents could access SSH keys"
    FAIL=1
  fi
fi

if [ "$FAIL" -eq 0 ]; then
  echo "  All checks passed"
else
  echo ""
  echo "SECURITY ISSUES FOUND — fix before continuing"
  exit 1
fi
