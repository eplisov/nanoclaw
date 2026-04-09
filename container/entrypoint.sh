#!/bin/bash
set -e

# Set up git config if available (written by container-runner session init)
if [ -f /home/node/.claude/.gitconfig ]; then
  cp /home/node/.claude/.gitconfig /home/node/.gitconfig 2>/dev/null || true
fi

# Configure gh as git credential helper (uses GITHUB_TOKEN env var)
if [ -n "$GITHUB_TOKEN" ] && command -v gh >/dev/null 2>&1; then
  gh auth setup-git 2>/dev/null || true
fi

# Compile agent-runner TypeScript
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Read input from stdin and run agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
