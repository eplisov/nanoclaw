#!/bin/bash
# Deploy nanoclaw to VPS
# Usage: ssh nanoclaw "cd ~/nanoclaw && bash deploy.sh"
# Or from local: ssh nanoclaw "cd ~/nanoclaw && git pull && npm install && npm run build && bash container/build.sh && systemctl --user restart nanoclaw"

set -e

echo "==> Pulling latest changes..."
git pull origin main

echo "==> Installing dependencies..."
npm install

echo "==> Building TypeScript..."
npm run build

echo "==> Syncing agent-runner source to session caches..."
for dir in data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp container/agent-runner/src/*.ts "$dir/" && echo "    Updated $dir"
done

echo "==> Rebuilding agent container..."
bash container/build.sh

echo "==> Security check..."
bash scripts/security-check.sh

echo "==> Restarting service..."
systemctl --user restart nanoclaw

sleep 2
echo "==> Status:"
systemctl --user status nanoclaw --no-pager | head -8
echo ""
echo "==> Deploy complete!"
