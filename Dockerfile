# =====================================================
# Babylon3DAgent — hosted Microsoft Foundry agent
# Serves the OpenAI Responses API (POST /responses) on port 8088.
# =====================================================
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PORT=8088

WORKDIR /app

# Azure CLI lets DefaultAzureCredential fall back to AzureCliCredential when the image
# is run locally with: -v ~/.azure:/root/.azure:ro . In Foundry it uses managed identity.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
# `--pre` is required because agent-framework-foundry-hosting only ships pre-release
# (alpha) versions today.
RUN pip install --no-cache-dir --pre -r requirements.txt

COPY agent.py .
COPY agent.yaml .

EXPOSE 8088

# run_async() binds to 0.0.0.0 and reads PORT from the environment (default 8088).
CMD ["python", "agent.py"]
