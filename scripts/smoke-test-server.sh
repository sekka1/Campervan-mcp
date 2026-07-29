#!/usr/bin/env bash
#
# scripts/smoke-test-server.sh
#
# Starts the Campervan MCP server locally (via `wrangler dev`), waits for it
# to become ready, then exercises the MCP JSON-RPC endpoints (initialize,
# tools/list, and a handful of tools/call requests) to verify the server is
# working end-to-end. Intended to be run manually or from CI (see
# .github/workflows/server-smoke-test.yml).
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

cleanup() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "Stopping local MCP server (pid ${SERVER_PID})..."
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

json_rpc() {
  local id="$1" method="$2" params="$3"
  curl -sS -X POST "${BASE_URL}/" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":${id},\"method\":\"${method}\",\"params\":${params}}"
}

assert_field() {
  local description="$1" json="$2" jq_expr="$3"
  if ! echo "${json}" | jq -e "${jq_expr}" > /dev/null 2>&1; then
    echo "FAIL: ${description}"
    echo "Response: ${json}"
    exit 1
  fi
  echo "PASS: ${description}"
}

echo "Applying local D1 migrations..."
npx wrangler d1 migrations apply DB --local

echo "Starting local MCP server on port ${PORT}..."
npx wrangler dev --port "${PORT}" > "${LOG_FILE}" 2>&1 &
SERVER_PID=$!

echo "Waiting up to ${STARTUP_WAIT}s for the server to become ready..."
ready=false
for ((i = 0; i < STARTUP_WAIT; i++)); do
  if curl -sS -o /dev/null -X POST "${BASE_URL}/" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}'; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != "true" ]]; then
  echo "FAIL: server did not become ready within ${STARTUP_WAIT}s"
  echo "----- wrangler dev log -----"
  cat "${LOG_FILE}"
  exit 1
fi
echo "Server is up."

echo
echo "--- initialize ---"
init_response=$(json_rpc 1 initialize '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}')
assert_field "initialize returns server info" "${init_response}" '.result.serverInfo.name == "Campervan Technical & Electrical MCP"'

echo
echo "--- tools/list ---"
tools_response=$(json_rpc 2 tools/list '{}')
assert_field "tools/list returns calculate_wire_gauge" "${tools_response}" '.result.tools[] | select(.name == "calculate_wire_gauge")'
assert_field "tools/list returns calculate_van_payload" "${tools_response}" '.result.tools[] | select(.name == "calculate_van_payload")'
assert_field "tools/list returns lookup_component_specs" "${tools_response}" '.result.tools[] | select(.name == "lookup_component_specs")'

echo
echo "--- tools/call calculate_wire_gauge ---"
wire_response=$(json_rpc 3 tools/call '{"name":"calculate_wire_gauge","arguments":{"current_amps":30,"length_feet":10,"voltage":"12","allowable_drop_pct":3}}')
assert_field "calculate_wire_gauge succeeds" "${wire_response}" '.result.isError != true'
assert_field "calculate_wire_gauge returns recommended_awg" "${wire_response}" '(.result.content[0].text | fromjson).recommended_awg'

echo
echo "--- tools/call calculate_van_payload ---"
payload_response=$(json_rpc 4 tools/call '{"name":"calculate_van_payload","arguments":{"van_model":"sprinter_144","components":[{"name":"Test Battery","weight_lbs":58}]}}')
assert_field "calculate_van_payload succeeds" "${payload_response}" '.result.isError != true'

echo
echo "--- tools/call list_van_models ---"
models_response=$(json_rpc 5 tools/call '{"name":"list_van_models","arguments":{}}')
assert_field "list_van_models succeeds" "${models_response}" '.result.isError != true'

echo
echo "--- tools/call lookup_component_specs ---"
specs_response=$(json_rpc 6 tools/call '{"name":"lookup_component_specs","arguments":{"category":"inverter_charger"}}')
assert_field "lookup_component_specs succeeds against local D1" "${specs_response}" '.result.isError != true'

echo
echo "All MCP server smoke tests passed."
