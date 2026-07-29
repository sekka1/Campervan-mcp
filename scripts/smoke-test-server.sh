#!/usr/bin/env bash
#
# scripts/smoke-test-server.sh
#
# Starts the Campervan MCP server locally (via `wrangler dev`), waits for it
# to become ready, then delegates the actual MCP JSON-RPC endpoint assertions
# to scripts/test-mcp-endpoints.sh. The shared endpoint script is also used
# by the deploy-to-production workflow to test the live Cloudflare Worker,
# which keeps both test paths in sync.
#
# Usage:
#   scripts/smoke-test-server.sh
#
# Environment variables:
#   PORT         Port to run the local server on (default: 8787)
#   STARTUP_WAIT Max seconds to wait for the server to become ready (default: 60)

set -euo pipefail

PORT="${PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}"
STARTUP_WAIT="${STARTUP_WAIT:-60}"
LOG_FILE="$(mktemp -t wrangler-dev-log.XXXXXX)"
SERVER_PID=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Stopping local MCP server (pid ${SERVER_PID})..."
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Applying local D1 migrations..."
npx wrangler d1 migrations apply DB --local

echo "Starting local MCP server on port ${PORT}..."
npx wrangler dev --port "${PORT}" > "${LOG_FILE}" 2>&1 &
SERVER_PID=$!

if ! BASE_URL="${BASE_URL}" READY_WAIT="${STARTUP_WAIT}" \
     "${SCRIPT_DIR}/test-mcp-endpoints.sh"; then
  echo "----- wrangler dev log -----"
  cat "${LOG_FILE}"
  exit 1
fi
