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
#   - a locally spawned `cf dev` server (see scripts/smoke-test-server.sh)
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
  if command -v jq > /dev/null 2>&1; then
    if ! echo "${json}" | jq -e "${jq_expr}" > /dev/null 2>&1; then
      echo "FAIL: ${description}"
      echo "Response: ${json}"
      exit 1
    fi
  else
    # Fallback to node evaluator if jq is not installed locally
    if ! node -e "
      const data = JSON.parse(process.argv[1]);
      // basic check
      if (data.error || data.result?.isError === true) process.exit(1);
    " "${json}" 2>/dev/null; then
      echo "FAIL: ${description}"
      echo "Response: ${json}"
      exit 1
    fi
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
assert_field "tools/list returns calculate_dc_wire_and_fuse" "${tools_response}" '.result.tools[] | select(.name == "calculate_dc_wire_and_fuse")'
assert_field "tools/list returns search_van_manuals" "${tools_response}" '.result.tools[] | select(.name == "search_van_manuals")'
assert_field "tools/list returns inspect_manual_chunks" "${tools_response}" '.result.tools[] | select(.name == "inspect_manual_chunks")'

echo
echo "--- tools/call calculate_dc_wire_and_fuse ---"
abyc_response=$(json_rpc 3 tools/call '{"name":"calculate_dc_wire_and_fuse","arguments":{"system_voltage":12,"amperage":60,"one_way_distance_feet":15,"allowable_drop_percent":3,"is_engine_compartment":false}}')
assert_field "calculate_dc_wire_and_fuse succeeds" "${abyc_response}" '.result.isError != true'
assert_field "calculate_dc_wire_and_fuse returns fuse_type" "${abyc_response}" '(.result.content[0].text | fromjson).fuse_type == "MIDI / AMI Fuse"'

echo
echo "--- tools/call search_van_manuals ---"
manuals_response=$(json_rpc 4 tools/call '{"name":"search_van_manuals","arguments":{"query":"Transit body builder roof load rating","top_k":2}}')
assert_field "search_van_manuals succeeds" "${manuals_response}" '.result.isError != true'
assert_field "search_van_manuals returns query" "${manuals_response}" '(.result.content[0].text | fromjson).query == "Transit body builder roof load rating"'

echo
echo "--- tools/call inspect_manual_chunks ---"
inspect_response=$(json_rpc 5 tools/call '{"name":"inspect_manual_chunks","arguments":{"keyword":"CCP2","limit":2}}')
assert_field "inspect_manual_chunks succeeds" "${inspect_response}" '.result.isError != true'

# -----------------------------------------------------------------------------
# Post-Deploy Live Server Verification (when LIVE_DEPLOYED_TEST=true)
# -----------------------------------------------------------------------------
LIVE_DEPLOYED_TEST="${LIVE_DEPLOYED_TEST:-false}"
if [[ "${LIVE_DEPLOYED_TEST}" == "true" ]]; then
  echo
  echo "=========================================================="
  echo "=== Running Post-Deploy Live Edge Tests against ${BASE_URL} ==="
  echo "=========================================================="
  
  echo "--- live search_van_manuals (live Vectorize & D1) ---"
  live_search_resp=$(json_rpc 11 tools/call '{"name":"search_van_manuals","arguments":{"query":"Transit auxiliary power tap 60A continuous","chassis":"transit","subsystem":"12v_dc","top_k":3}}')
  assert_field "live search_van_manuals succeeds" "${live_search_resp}" '.result.isError != true'
  assert_field "live search_van_manuals returns query" "${live_search_resp}" '(.result.content[0].text | fromjson).query == "Transit auxiliary power tap 60A continuous"'

  echo "--- live inspect_manual_chunks (live D1 chunks) ---"
  live_inspect_resp=$(json_rpc 12 tools/call '{"name":"inspect_manual_chunks","arguments":{"keyword":"CCP2","limit":2}}')
  assert_field "live inspect_manual_chunks succeeds" "${live_inspect_resp}" '.result.isError != true'
  echo "Live post-deploy MCP edge verification passed successfully!"
fi

echo "All MCP endpoint tests passed against ${BASE_URL}."
