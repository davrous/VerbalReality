![Verbal Reality Logo](./webchat/public/VerbalRealityLogo.png "Verbal Reality Logo")

# Verbal Reality

A full-screen Babylon.js canvas (left, 2/3 width) plus a chat panel (right, 1/3) that talks to a
**Microsoft Foundry hosted agent**. The agent turns natural language into Babylon.js JavaScript that
is evaluated live in the canvas, building up a **cumulative** 3D scene one turn at a time. It can also
browse a library of ready-made GLB models and drop them into the scene.

Inspired by [davrous/musicalJARVIB](https://github.com/davrous/musicalJARVIB), but using a Foundry
hosted agent (Microsoft Agent Framework) instead of a direct LLM call, and a custom web chat instead of Teams.

## Features

- **Natural-language scene building** — describe what you want ("a glossy red sphere above a ground
  plane") and the agent writes Babylon.js code that runs immediately in the canvas.
- **Cumulative scene** — every turn adds to the existing scene and can reference meshes created in
  earlier turns by name. `/reset` clears both the canvas and the agent's conversation.
- **3D model library** — the agent can search Microsoft's public 3D-model service and return a
  thumbnail gallery in the chat. Clicking a thumbnail loads that GLB into the scene instantly
  (client-side), then silently tells the agent the model's name so follow-ups like "make it bigger"
  keep working.
- **Automatic sizing & framing** — [`SceneFit`](webchat/public/scenefit.js) measures each turn's new
  content, rescales it to a consistent canonical size, rests it on the ground, and frames the camera,
  so you never worry about absolute units.
- **Server-side validation (optional)** — when enabled, the agent validates its own generated code in
  a headless Babylon `NullEngine` sandbox and fixes-and-retries (up to 3×) before replying.
- **In-canvas activity HUD** — progress and tool calls are drawn with the Babylon 3D GUI (not DOM
  overlays), so they remain visible inside a future VR session.
- **Live streaming chat** — replies stream token-by-token over Server-Sent Events, with a status pill
  reflecting the agent's current step.

## Architecture

| Component | Path | Stack | Default Port |
|-----------|------|-------|--------------|
| Hosted agent | [agent.py](agent.py) | Python · Microsoft Agent Framework · `FoundryChatClient` + `ResponsesHostServer` (OpenAI Responses API at `POST /responses`) | 8088 |
| Validator (optional) | [validator/server.js](validator/server.js) | Node.js · Express · Babylon.js `NullEngine` (headless) | 8087 |
| Web chat backend | [webchat/server.js](webchat/server.js) | Node.js · Express proxy (SSE) + static file server | 3000 |
| Web chat front-end | [webchat/public/](webchat/public/) | Babylon.js (CDN) · [`app.js`](webchat/public/app.js) (chat + scene) · [`scenefit.js`](webchat/public/scenefit.js) (auto-scale) · [`activity.js`](webchat/public/activity.js) (3D HUD) | — |

```mermaid
flowchart LR
    user([User])

    subgraph browser["Browser — webchat/public"]
        canvas["Babylon.js canvas<br/>(live cumulative scene)"]
        chat["Chat panel + SSE client<br/>app.js"]
        scenefit["SceneFit<br/>auto-scale &amp; frame"]
        activity["ActivityIndicators<br/>3D GUI HUD"]
    end

    subgraph webchat["Web chat backend — webchat/server.js"]
        proxy["Express proxy<br/>/api/chat (SSE)<br/>session → previous_response_id"]
    end

    subgraph agent["Hosted agent — agent.py"]
        host["ResponsesHostServer<br/>POST /responses"]
        fcc["FoundryChatClient"]
        tools["Tools:<br/>validate_babylon_code<br/>list_available_models<br/>download_model"]
    end

    validator["Validator — validator/server.js<br/>Babylon NullEngine<br/>POST /validate (local dev only)"]
    foundry["Microsoft Foundry<br/>project + model deployment"]
    library["Microsoft 3D-model service<br/>(officeapps media search)"]

    user --> chat
    chat -->|POST /api/chat| proxy
    proxy -->|Responses API, stream| host
    host --> fcc --> foundry
    host --> tools
    tools -. ENABLE_VALIDATION=true .-> validator
    tools --> library
    proxy -->|SSE: delta / tool / done| chat
    chat -->|extract javascript block| canvas
    chat -->|gallery click loads GLB| canvas
    canvas --> scenefit
    chat --> activity
```

**Validation flag** — generated code is validated server-side, never in the browser:

- `ENABLE_VALIDATION=true` → the agent calls the Node.js `/validate` tool (headless `NullEngine`)
  before replying, and retries (up to 3×) if the generated code throws.
- `ENABLE_VALIDATION=false` → the LLM's code is returned directly with no validation.

The web chat client is intentionally unaware of validation — it just renders prose, executes the
returned `javascript` code blocks, and renders any `models` gallery block.

### Request flow

```mermaid
sequenceDiagram
    participant B as Browser (app.js)
    participant W as webchat/server.js
    participant A as agent.py (Responses)
    participant F as Foundry model
    participant V as Validator (NullEngine)

    B->>W: POST /api/chat { message, sessionId }
    W->>A: POST /responses (stream, previous_response_id)
    A->>F: chat completion
    F-->>A: text + tool calls
    opt ENABLE_VALIDATION=true
        A->>V: POST /validate { code }
        V-->>A: { ok } | { ok:false, error } (retry ≤3×)
    end
    A-->>W: SSE: output_text.delta, function_call, completed
    W-->>B: SSE: delta / tool / done
    B->>B: extract javascript block and run in canvas
    B->>B: SceneFit normalizes + frames new content
```

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
`verbalreality`, Responses protocol) and [Dockerfile](Dockerfile) packages the Python
agent. The agent's name is defined **only** in `agent.yaml` — never in `Agent(...)` —
which is why server-side registration of a `kind: prompt` agent must be avoided.

The NullEngine validator is a local-dev-only Node service and is **not** in the
container, so `agent.yaml` sets `ENABLE_VALIDATION=false` for hosted deploys. To validate
server-side in production you would co-host the validator (or port it into the agent).

## Usage tips

- Each request adds to the existing scene (cumulative). Type `/reset` in the chat to clear both the
  canvas and the agent conversation.
- Ask the agent to **find real models** ("find a chair", "show me some dinosaurs") to get a thumbnail
  gallery in the chat; click a thumbnail to drop that GLB into the scene instantly. Follow up in
  natural language ("make it twice as big", "rotate it") and the agent remembers the loaded mesh.
- Drag the divider on the chat's left border to resize the chat panel.
- <kbd>Enter</kbd> sends, <kbd>Shift</kbd>+<kbd>Enter</kbd> inserts a newline.

## Configuration reference (`.env`)

| Variable | Purpose | Default |
|----------|---------|---------|
| `PROJECT_ENDPOINT` | Foundry project endpoint | _(required)_ |
| `MODEL_DEPLOYMENT_NAME` | Model deployment name | `gpt-4.1` |
| `ENABLE_VALIDATION` | Toggle the NullEngine validation tool | `true` |
| `VALIDATOR_URL` | Validator endpoint used by the agent tool | `http://localhost:8087/validate` |
| `PORT` | Port the agent's Responses server listens on | `8088` |
| `MODEL_SEARCH_URL` | Microsoft 3D-model search endpoint used by `list_available_models` | _(officeapps media search)_ |
| `MODEL_SEARCH_PAGE_SIZE` | Max models returned per library search | `5` |

The web chat backend also honors `PORT`, `AGENT_ENDPOINT`, and `AGENT_MODEL`
(see [webchat/server.js](webchat/server.js)). The validator honors `PORT`
(see [validator/server.js](validator/server.js)).
