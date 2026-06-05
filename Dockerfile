# =====================================================
# Babylon3DAgent — hosted Microsoft Foundry agent
# Serves the OpenAI Responses API (POST /responses) on port 8088.
#
# This image bundles TWO runtimes in one container:
#   * Python  -> the agent itself (Responses API on 8088).
#   * Node.js -> the Babylon.js NullEngine validator (POST /validate on 8087).
# Foundry runs a single container per hosted agent, so to keep server-side
# validation in production we co-host the Node validator next to the Python
# agent and start both with start.sh. The agent reaches the validator over
# localhost (VALIDATOR_URL), exactly as it does in local dev.
# =====================================================
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8088 \
    VALIDATOR_PORT=8087

WORKDIR /app

# System deps:
#   * curl / ca-certificates -> health probing + AzureCliCredential fallback locally.
#   * tini                   -> proper PID 1 (reaps the background Node process, forwards signals).
#   * Node.js 20 + npm       -> runs the Babylon NullEngine validator.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg tini \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- Azure CLI ---
# Required so DefaultAzureCredential -> AzureCliCredential works when the image is run
# locally with your host credentials mounted: -v ~/.azure:/root/.azure:ro (and as a
# device-code login fallback in start.sh). In Foundry this is unused -> managed identity.
RUN curl -sL https://aka.ms/InstallAzureCLIDeb | bash \
    && rm -rf /var/lib/apt/lists/*

# --- Node validator dependencies (cached layer) ---
# Copy only the manifest first so the install layer is cached unless deps change.
COPY validator/package.json validator/package-lock.json* ./validator/
RUN cd validator \
    && (npm ci --omit=dev || npm install --omit=dev)

# --- Python agent dependencies ---
# `--pre` is required because agent-framework-foundry-hosting only ships pre-release
# (alpha) versions today.
COPY requirements.txt .
RUN pip install --no-cache-dir --pre -r requirements.txt

# --- Application code ---
COPY agent.py .
COPY agent.yaml .
COPY validator/server.js ./validator/server.js
COPY start.sh .
RUN chmod +x start.sh

EXPOSE 8088

# tini as PID 1; start.sh launches the Node validator in the background, waits for it
# to become healthy, then execs the Python agent in the foreground.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./start.sh"]
