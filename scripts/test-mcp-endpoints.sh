#!/usr/bin/env bash
#
# scripts/test-mcp-endpoints.sh
#
# Exercises the Campervan MCP server's JSON-RPC HTTP endpoints (initialize,
# tools/list, and a handful of tools/call requests) against a running server.
# The server itself is NOT started or stopped by this script; the caller is
# responsible for pointing BASE_URL at a reachable MCP server.
#
# This lets the same test assertions be reused against:
#   - a locally spawned `wrangler dev` server (see scripts/smoke-test-server.sh)
#   - the deployed Cloudflare Workers server (see .github/workflows/deploy-production.yml)
#
# Usage:
#   BASE_URL=http://127.0.0.1:8787 scripts/test-mcp-endpoints.sh
#   BASE_URL=https://campervan-mcp-server.garlandk.workers.dev scripts/test-mcp-endpoints.sh
#
# Environment variables:
#   BASE_URL     Full base URL of the MCP server (required, no trailing slash)
#   READY_WAIT   Max seconds to wait for the server to respond (default: 30)

set -euo pipefail

BASE_URL="${BASE_URL:-}"
READY_WAIT="${READY_WAIT:-30}"

if [[ -z "${BASE_URL}" ]]; then
  echo "ERROR: BASE_URL is required (e.g. BASE_URL=http://127.0.0.1:8787)" >&2
  exit 2
fi

# Strip a trailing slash so we can always concatenate "/" below.
BASE_URL="${BASE_URL%/}"

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

echo "Testing MCP endpoints at ${BASE_URL}"
echo "Waiting up to ${READY_WAIT}s for the server to respond to initialize..."
ready=false
for ((i = 0; i < READY_WAIT; i++)); do
  if curl -sS -o /dev/null -X POST "${BASE_URL}/" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-endpoint-test","version":"1.0"}}}'; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != "true" ]]; then
  echo "FAIL: server at ${BASE_URL} did not respond within ${READY_WAIT}s"
  exit 1
fi
echo "Server is reachable."

echo
echo "--- initialize ---"
init_response=$(json_rpc 1 initialize '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"mcp-endpoint-test","version":"1.0"}}')
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
assert_field "lookup_component_specs succeeds" "${specs_response}" '.result.isError != true'

echo
echo "All MCP endpoint tests passed against ${BASE_URL}."
