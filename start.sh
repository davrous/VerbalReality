#!/usr/bin/env bash
# =====================================================
# Container entrypoint for the bundled Babylon3DAgent image.
#
# Starts the Node.js Babylon NullEngine validator in the background, waits for it
# to report healthy, then execs the Python agent in the foreground (so it becomes
# the container's main process and receives signals via tini).
#
# Ports:
#   * Python agent       -> $PORT            (default 8088, the Responses API)
#   * Node validator     -> $VALIDATOR_PORT  (default 8087, POST /validate)
# The agent reaches the validator via VALIDATOR_URL (defaults to localhost:8087).
# =====================================================
set -euo pipefail

VALIDATOR_PORT="${VALIDATOR_PORT:-8087}"

# =====================================================
# Azure credentials (local Docker only).
# In Foundry the agent uses its managed identity, so both steps below are skipped:
# section 0 only triggers when ~/.azure is bind-mounted, and section 1 detects the
# hosted identity endpoint and does nothing.
# =====================================================

# ── 0. Fix read-only ~/.azure mount ──
# When the host config is mounted with -v ~/.azure:/root/.azure:ro, the Azure CLI and
# azure-identity can't write their token cache. Copy just the files they need to a
# writable dir and point AZURE_CONFIG_DIR there.
if [ -d /root/.azure ] && ! touch /root/.azure/.writetest 2>/dev/null; then
  echo "[start] read-only ~/.azure mount detected, copying auth state to a writable dir..."
  mkdir -p /tmp/.azure-writable
  for f in azureProfile.json clouds.config config \
           msal_token_cache.bin msal_token_cache.json \
           service_principal_entries.bin service_principal_entries.json \
           AzureRmContext.json TokenCache.dat versionCheck.json; do
    [ -e "/root/.azure/$f" ] && cp -p "/root/.azure/$f" "/tmp/.azure-writable/" 2>/dev/null || true
  done
  export AZURE_CONFIG_DIR=/tmp/.azure-writable
  echo "[start] AZURE_CONFIG_DIR=/tmp/.azure-writable"
else
  rm -f /root/.azure/.writetest 2>/dev/null || true
fi

# ── 1. Ensure a usable Azure credential before the agent starts ──
# Hosted (managed identity) -> nothing to do. Otherwise, if no cached CLI login is
# present, fall back to an interactive device-code login so DefaultAzureCredential ->
# AzureCliCredential can mint Foundry tokens.
if [ -n "${IDENTITY_ENDPOINT:-}" ] || [ -n "${MSI_ENDPOINT:-}" ]; then
  echo "[start] hosted environment detected (managed identity) — skipping az login."
elif ! az account show >/dev/null 2>&1; then
  echo "[start] no valid Azure credentials detected — logging in via device code..."
  az login --use-device-code
fi

echo "[start] launching Node validator on port ${VALIDATOR_PORT}..."
# The validator (validator/server.js) reads PORT for its own listener; scope it to this
# subprocess only so it does NOT inherit the agent's PORT (8088).
PORT="${VALIDATOR_PORT}" node validator/server.js &
VALIDATOR_PID=$!

# If the validator dies, take the whole container down so the platform restarts it
# (rather than silently running with a broken validation tool).
trap 'echo "[start] received signal, stopping..."; kill "${VALIDATOR_PID}" 2>/dev/null || true' TERM INT

# Wait for the validator to become healthy before starting the agent (up to ~30s).
echo "[start] waiting for validator health on http://localhost:${VALIDATOR_PORT}/health ..."
for i in $(seq 1 30); do
  if ! kill -0 "${VALIDATOR_PID}" 2>/dev/null; then
    echo "[start] ERROR: validator process exited before becoming healthy." >&2
    exit 1
  fi
  if curl -fsS "http://localhost:${VALIDATOR_PORT}/health" >/dev/null 2>&1; then
    echo "[start] validator is healthy."
    break
  fi
  if [ "${i}" -eq 30 ]; then
    echo "[start] ERROR: validator did not become healthy in time." >&2
    kill "${VALIDATOR_PID}" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo "[start] launching Python agent on port ${PORT:-8088}..."
exec python agent.py
