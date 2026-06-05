# Live 3D Explorer

A full-screen Babylon.js canvas (left, 2/3 width) plus a chat panel (right, 1/3) that talks to a
**Microsoft Foundry hosted agent**. The agent generates Babylon.js JavaScript that is evaluated live
in the canvas, building up a cumulative 3D scene.

Inspired by [davrous/musicalJARVIB](https://github.com/davrous/musicalJARVIB), but using a Foundry
hosted agent (Microsoft Agent Framework) instead of a direct LLM call, and a custom web chat instead of Teams.

## Architecture

| Component | Path | Stack | Default Port |
|-----------|------|-------|--------------|
| Hosted agent | [agent.py](agent.py) | Python · Microsoft Agent Framework · `FoundryChatClient` + `ResponsesHostServer` (OpenAI Responses API at `POST /responses`) | 8088 |
| Validator (optional) | [validator/](validator/) | Node.js · Express · Babylon.js `NullEngine` (headless) | 8087 |
| Web chat | [webchat/](webchat/) | Node.js · Express proxy + static front-end (Babylon.js CDN) | 3000 |

**Validation flag** — the agent code is validated server-side, never in the browser:

- `ENABLE_VALIDATION=true` → the agent calls the Node.js `/validate` tool (headless `NullEngine`)
  before replying, and retries (up to 3×) if the generated code throws.
- `ENABLE_VALIDATION=false` → the LLM's code is returned directly with no validation.

The web chat client is intentionally unaware of validation — it just renders prose and executes the
returned `javascript` code blocks.

## Prerequisites

- Python 3.10+, Node.js 18+
- Azure CLI logged in for local dev: `az login` (the agent uses `DefaultAzureCredential`)
- A Microsoft Foundry project endpoint + a deployed model

## Setup

1. **Configure environment**

   ```bash
   cp .env.sample .env
   # then edit .env and set PROJECT_ENDPOINT (and adjust the model / flags if needed)
   ```

2. **Python agent** (always use the virtual environment)

   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install --pre -r requirements.txt
   ```

   > Stack note: this uses `agent-framework` + `agent-framework-foundry-hosting`
   > (`FoundryChatClient` + `ResponsesHostServer`). `--pre` is required because
   > `agent-framework-foundry-hosting` only ships pre-release builds today. We do **not**
   > use `AzureAIClient`/`azure-ai-agentserver-*`: that client registers a `kind: prompt`
   > agent that collides with the hosted agent in [agent.yaml](agent.yaml) (HTTP 400
   > "Agent kind mismatch"). The agent's name lives only in `agent.yaml`.

3. **Node services**

   ```bash
   (cd validator && npm install)
   (cd webchat   && npm install)
   ```

## Run (local)

Start in this order:

1. **Validator** (only needed when `ENABLE_VALIDATION=true`)

   ```bash
   cd validator && npm start          # -> http://localhost:8087
   ```

2. **Agent** — press <kbd>F5</kbd> in VS Code and pick
   **"Debug Local Agent/Workflow HTTP Server"** (Foundry Toolkit experience). It starts the agent on
   `http://localhost:8088`, opens the Agent Inspector, and (via tasks) launches the validator for you.

   Or run it manually:

   ```bash
   source .venv/bin/activate
   python agent.py                    # HTTP server (default) -> http://localhost:8088/responses
   python agent.py --cli              # interactive terminal chat instead
   ```

3. **Web chat**

   ```bash
   cd webchat && npm start            # -> http://localhost:3000
   ```

Open http://localhost:3000 and start describing the 3D scene you want.

## Deploy (hosted agent)

[agent.yaml](agent.yaml) declares the hosted-agent identity (`kind: hosted`, name
`babylon3d-agent`, Responses protocol) and [Dockerfile](Dockerfile) packages the Python
agent. The agent's name is defined **only** in `agent.yaml` — never in `Agent(...)` —
which is why server-side registration of a `kind: prompt` agent must be avoided.

The NullEngine validator is a local-dev-only Node service and is **not** in the
container, so `agent.yaml` sets `ENABLE_VALIDATION=false` for hosted deploys. To validate
server-side in production you would co-host the validator (or port it into the agent).

## Usage tips

- Each request adds to the existing scene (cumulative). Type `/reset` in the chat to clear both the
  canvas and the agent conversation.
- <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> inserts a newline.

## Configuration reference (`.env`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `PROJECT_ENDPOINT` | Foundry project endpoint | _(required)_ |
| `MODEL_DEPLOYMENT_NAME` | Model deployment name | `gpt-4.1` |
| `ENABLE_VALIDATION` | Toggle the NullEngine validation tool | `true` |
| `VALIDATOR_URL` | Validator endpoint used by the agent tool | `http://localhost:8087/validate` |
| `PORT` | Port the agent's Responses server listens on | `8088` |

The web chat backend also honors `PORT`, `AGENT_ENDPOINT`, and `AGENT_MODEL`
(see [webchat/server.js](webchat/server.js)).
