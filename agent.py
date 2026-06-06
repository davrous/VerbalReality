"""Babylon3DAgent — a Microsoft Foundry hosted agent that generates Babylon.js code.

The agent turns natural-language requests into Babylon.js JavaScript snippets that
operate on an existing `scene` (and `engine`) in the browser. The generated code is
cumulative: new snippets can reference meshes created in previous turns by name.

Beyond writing code, the agent can also browse a library of ready-made GLB models:
  * `list_available_models` searches the Microsoft 3D-model service and returns model
    thumbnails + GLB links, which the web client renders as a gallery in the chat.
  * `download_model` returns the Babylon.js snippet that loads a chosen model into the
    live scene.

Two modes, controlled by the ENABLE_VALIDATION environment variable:
  * ENABLE_VALIDATION=true  -> the agent is given a `validate_babylon_code` tool backed
                               by a Node.js Babylon NullEngine service. The agent must
                               validate every snippet before replying and fix-and-retry
                               on errors (up to 3 attempts).
  * ENABLE_VALIDATION=false -> no tool; the agent returns the generated code directly
                               with no server-side validation.

Stack (proven hosted-agent pattern):
  * FoundryChatClient   -> talks to the Foundry project + model deployment.
  * ResponsesHostServer -> serves the OpenAI Responses API at POST /responses.
  * The Agent has NO `name=` here: the identity lives only in agent.yaml, which avoids
    the "Agent kind mismatch" HTTP 400 you hit when a client also registers a
    `kind: prompt` agent in the project.

Run modes:
  * default (no flag)  -> HTTP server (OpenAI Responses API) for Foundry / F5 / deploy.
  * --cli              -> simple interactive terminal loop for quick local testing.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import sys
from typing import Annotated

import httpx
from agent_framework import Agent, AgentMiddleware, tool
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv
from opentelemetry import trace
from opentelemetry.trace import Status, StatusCode

import failure_store

# override=True so that values in .env also win in deployed environments.
load_dotenv(override=True)

# Structured logging to stdout so Foundry's container logs (and any connected
# Application Insights) capture validation failures with a consistent shape.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("babylon3d_agent")


def _capture_failures_enabled() -> bool:
    return os.environ.get("CAPTURE_VALIDATION_FAILURES", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


# Per-turn context shared from the agent middleware to the validation tool, which only
# receives the `code` argument from the model and otherwise has no access to the user
# prompt or the conversation/session identity.
_CURRENT_PROMPT: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_prompt", default=None
)
_CURRENT_CONV_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_conv_id", default=None
)
_CURRENT_SESSION_ID: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "current_session_id", default=None
)
_ATTEMPT_COUNTER: contextvars.ContextVar[int] = contextvars.ContextVar(
    "attempt_counter", default=0
)

# Max characters of the user prompt attached to an OpenTelemetry span event. OTel
# sensitive-data capture is off by default, so we keep the in-span copy short and put
# the full prompt only in the on-disk record.
_SPAN_PROMPT_MAX = 200


def _validation_enabled() -> bool:
    return os.environ.get("ENABLE_VALIDATION", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


VALIDATOR_URL = os.environ.get("VALIDATOR_URL", "http://localhost:8087/validate")

# Endpoint used to mirror browser-side model loads (gallery thumbnail clicks) into the
# validator's cumulative scene. Derived from VALIDATOR_URL unless overridden so that the
# two stay co-located on the same Node validator process.
VALIDATOR_REGISTER_URL = os.environ.get("VALIDATOR_REGISTER_URL") or (
    VALIDATOR_URL.rsplit("/validate", 1)[0] + "/register-mesh"
    if VALIDATOR_URL.endswith("/validate")
    else VALIDATOR_URL.rstrip("/") + "/register-mesh"
)

# Port the Responses API server listens on (8087 is taken by the Node validator).
SERVER_PORT = int(os.environ.get("PORT", "8088"))

# Microsoft Office / PowerPoint 3D-model media service. Same public endpoint the
# PowerPoint "3D Models" picker uses; returns thumbnail images + GLB download links.
MODEL_SEARCH_URL = os.environ.get(
    "MODEL_SEARCH_URL",
    "https://hubble.officeapps.live.com/mediasvc/api/media/search?v=1&lang=en-us",
)
# How many models to return per search (matches the reference JARVIB experience).
MODEL_SEARCH_PAGE_SIZE = int(os.environ.get("MODEL_SEARCH_PAGE_SIZE", "5"))


def _capture_validation_failure(code: str, error: str) -> None:
    """Persist + trace a single validation failure. Best-effort: never raises.

    Records the failing snippet, its error (classified by type), the originating user
    prompt and the conversation/session id to the micro-VM disk, emits a structured log
    line, and adds an OpenTelemetry error event to the current span so the failure is
    visible on the Foundry side and reusable for later agent evaluation.
    """
    if not _capture_failures_enabled():
        return
    try:
        attempt = _ATTEMPT_COUNTER.get() + 1
        _ATTEMPT_COUNTER.set(attempt)
        prompt = _CURRENT_PROMPT.get()
        conversation_id = _CURRENT_CONV_ID.get()
        session_id = _CURRENT_SESSION_ID.get()

        record = failure_store.record_failure(
            code=code,
            error=error,
            attempt=attempt,
            prompt=prompt,
            conversation_id=conversation_id,
            session_id=session_id,
        )
        error_type = record.get("error_type", "unknown")

        logger.error(
            "validation_failure attempt=%d type=%s conv=%s session=%s code_chars=%d error=%s",
            attempt,
            error_type,
            conversation_id,
            session_id,
            len(code or ""),
            error,
        )

        # OpenTelemetry: attach an error event to the active span (if any) so the
        # failure surfaces in Foundry tracing. Guard against a non-recording span.
        span = trace.get_current_span()
        if span is not None and span.is_recording():
            span.add_event(
                "validation_failure",
                {
                    "validation.attempt": attempt,
                    "validation.error_type": error_type,
                    "validation.error_message": error[:500],
                    "validation.code_chars": len(code or ""),
                    "validation.conversation_id": conversation_id or "",
                    "validation.session_id": session_id or "",
                    "validation.prompt": (prompt or "")[:_SPAN_PROMPT_MAX],
                },
            )
            span.set_status(Status(StatusCode.ERROR, f"validation_failure: {error_type}"))
    except Exception:  # noqa: BLE001 - capture must never break the agent turn
        logger.warning("Failed to capture validation failure", exc_info=True)


@tool(approval_mode="never_require")
async def validate_babylon_code(
    code: Annotated[
        str,
        "The Babylon.js JavaScript snippet to validate. It runs against a headless "
        "Babylon.js NullEngine scene that already exposes `scene` and `engine`.",
    ],
) -> str:
    """Validate a Babylon.js code snippet in a headless NullEngine sandbox.

    Returns "OK" when the snippet executes without error, otherwise a string starting
    with "ERROR:" describing what went wrong so the snippet can be fixed and revalidated.
    The sandbox scene is persistent and cumulative across calls, mirroring the browser.
    """
    preview = " ".join(code.split())[:80]
    print(f"[agent] tool validate_babylon_code: {len(code)} chars | \"{preview}\"", flush=True)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(VALIDATOR_URL, json={"code": code})
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # noqa: BLE001 - surface any transport error to the model
        print(f"[agent] tool validate_babylon_code: transport error ({exc})", flush=True)
        message = f"could not reach the validation service ({exc})."
        _capture_validation_failure(code, message)
        return f"ERROR: {message}"

    if data.get("ok"):
        print("[agent] tool validate_babylon_code: OK", flush=True)
        return "OK"
    error = data.get("error", "unknown validation error")
    print(f"[agent] tool validate_babylon_code: ERROR - {error}", flush=True)
    _capture_validation_failure(code, error)
    return f"ERROR: {error}"


@tool(approval_mode="never_require")
async def list_validation_failures(
    limit: Annotated[
        int,
        "How many of the most recent validation failures to return (newest first). "
        "Defaults to 10.",
    ] = 10,
) -> str:
    """List recent Babylon.js code-validation failures captured on this micro-VM.

    Returns a JSON array (as a string) of the most recent failures, each with its
    timestamp, attempt number, error_type, error_message, originating turn_prompt and a
    (truncated) copy of the failing code. Useful for diagnosing why code generation kept
    failing and for building an evaluation dataset. Returns "[]" when none are recorded.
    """
    print(f"[agent] tool list_validation_failures: limit={limit}", flush=True)
    records = failure_store.read_recent(limit)
    # Trim the code in each record to keep the tool payload small for the model.
    for record in records:
        code = record.get("code")
        if isinstance(code, str) and len(code) > 500:
            record["code"] = code[:500] + "…"
    return json.dumps(records)


@tool(approval_mode="never_require")
async def list_available_models(
    query: Annotated[
        str,
        "What kind of 3D model to look for in the library, e.g. 'chair', 'dog', "
        "'spaceship'. A short noun phrase works best.",
    ],
) -> str:
    """Search the Microsoft 3D-model library for downloadable GLB models.

    Returns a JSON array (as a string) of up to a few models, each shaped like
    {"name": str, "imageUrl": str, "modelUrl": str}:
      * imageUrl is a thumbnail preview the web client shows in the chat.
      * modelUrl is the GLB download link to pass to `download_model` when the user
        picks one.
    Returns "[]" when nothing matches, or a string starting with "ERROR:" on failure.
    """
    print(f"[agent] tool list_available_models: query={query!r}", flush=True)
    payload = {
        "type": "Search",
        "pageSize": MODEL_SEARCH_PAGE_SIZE,
        "query": query,
        "parameters": {"firstpartycontent": False, "app": "office"},
        "descriptor": {"$type": "FirstPartyContentSearchDescriptor"},
    }
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                MODEL_SEARCH_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
            )
            response.raise_for_status()
            content = response.json()
    except Exception as exc:  # noqa: BLE001 - surface any transport error to the model
        print(f"[agent] tool list_available_models: transport error ({exc})", flush=True)
        return f"ERROR: could not reach the model library ({exc})."

    result = content.get("Result") or {}
    part_groups = result.get("PartGroups") or []
    models: list[dict[str, str]] = []
    for group in part_groups:
        image_parts = group.get("ImageParts") or []
        image_url = image_parts[0].get("SourceUrl") if image_parts else None

        title = None
        model_url = None
        for text_part in group.get("TextParts") or []:
            category = text_part.get("TextCategory")
            if category == "Title":
                title = text_part.get("Text")
            elif category == "OasisGlbLink":
                model_url = text_part.get("Text")

        # Only surface entries that have everything the client needs to show + load them.
        if title and image_url and model_url:
            models.append({"name": title, "imageUrl": image_url, "modelUrl": model_url})

    print(f"[agent] tool list_available_models: {len(models)} model(s) found", flush=True)
    return json.dumps(models)


@tool(approval_mode="never_require")
async def register_loaded_mesh(
    name: Annotated[
        str,
        "The mesh name of a model that was already loaded into the browser scene "
        "outside of your generated code (e.g. when the user clicked a gallery "
        "thumbnail). This is the name reported in the `[scene event]` note.",
    ],
) -> str:
    """Mirror a browser-side model load into the validation sandbox.

    When a model is added to the scene without going through validated code (a gallery
    thumbnail click loads the GLB client-side), the validator's cumulative scene has no
    such mesh, so a later snippet that animates or moves it fails with
    `Mesh "<name>" not found`. Call this with that model's name so the sandbox registers
    a matching mesh and subsequent validation of code referencing it succeeds.

    Returns "OK" on success, otherwise a string starting with "ERROR:".
    """
    print(f"[agent] tool register_loaded_mesh: name={name!r}", flush=True)
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(VALIDATOR_REGISTER_URL, json={"name": name})
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # noqa: BLE001 - surface any transport error to the model
        print(f"[agent] tool register_loaded_mesh: transport error ({exc})", flush=True)
        return f"ERROR: could not reach the validation service ({exc})."

    if data.get("ok"):
        print("[agent] tool register_loaded_mesh: OK", flush=True)
        return "OK"
    error = data.get("error", "unknown registration error")
    print(f"[agent] tool register_loaded_mesh: ERROR - {error}", flush=True)
    return f"ERROR: {error}"


@tool(approval_mode="never_require")
async def download_model(
    model_url: Annotated[
        str,
        "The GLB download link (modelUrl) of the model to load, taken from a previous "
        "list_available_models result.",
    ],
    name: Annotated[
        str,
        "A short, descriptive name for the loaded model. Becomes the Babylon.js mesh "
        "name so later code can reference it (e.g. 'red_chair').",
    ],
    scale: Annotated[
        float,
        "Relative size multiplier for the imported model. The page already auto-scales "
        "every model to a consistent canonical size, so use 1 normally, and only pass a "
        "different value when the user asks for a bigger or smaller model (e.g. 2 = twice "
        "as big, 0.5 = half).",
    ] = 1.0,
) -> str:
    """Build the Babylon.js snippet that loads a chosen GLB model into the live scene.

    Returns runnable Babylon.js code (no markdown) that imports `model_url`, names the
    root mesh `name` and scales it by `scale`. The code is deterministic, so it does NOT
    need to be validated — put it straight into the ```javascript block of your reply.
    """
    print(
        f"[agent] tool download_model: name={name!r} scale={scale} url={model_url!r}",
        flush=True,
    )
    last_slash = model_url.rfind("/")
    base_url = model_url[: last_slash + 1]
    file_name = model_url[last_slash + 1 :]
    # Encode through JSON so any quotes in the values can't break out of the JS string.
    js_name = json.dumps(name)
    js_base = json.dumps(base_url)
    js_file = json.dumps(file_name)
    code = (
        f"BABYLON.SceneLoader.ImportMesh(\"\", {js_base}, {js_file}, scene, "
        f"function (newMeshes) {{\n"
        f"  if (newMeshes[0]) {{\n"
        f"    newMeshes[0].name = {js_name};\n"
        f"    if (window.SceneFit) {{\n"
        f"      SceneFit.fitImportedModel(scene, camera, newMeshes[0], {scale});\n"
        f"    }} else {{\n"
        f"      newMeshes[0].scaling = new BABYLON.Vector3({scale}, {scale}, {scale});\n"
        f"    }}\n"
        f"  }}\n"
        f"}});"
    )
    return code


BASE_INSTRUCTIONS = """\
You are Babylon3DAgent, an assistant that builds interactive 3D worlds by writing
Babylon.js (https://www.babylonjs.com) JavaScript code.

A web page already hosts a live Babylon.js scene. The following variables are ALWAYS
available in the execution context of the code you produce — never re-create them:
  * `scene`   — the BABYLON.Scene
  * `engine`  — the BABYLON.Engine
  * `BABYLON` — the global Babylon.js namespace
  * `camera`  — the active camera
A default camera and a light already exist. Do NOT create a new engine, scene, canvas
or render loop, and do NOT call engine.runRenderLoop (the page owns the render loop).

Rules for the code you generate:
  * Output runnable Babylon.js statements only — no imports, no module wrappers, no
    HTML, no markdown headers inside the code.
  * The scene is CUMULATIVE across turns. New code may reference meshes you created in
    earlier turns by their `name`. Always give meshes explicit, descriptive names.
  * Use `scene` as the scene argument of Babylon.js constructors
    (e.g. `BABYLON.MeshBuilder.CreateBox("box1", {size: 2}, scene)`).
  * Prefer BABYLON.MeshBuilder.* factory methods and StandardMaterial/PBRMaterial.
  * To animate, register with `scene.onBeforeRenderObservable.add(() => { ... })`.
  * To rotate or spin a mesh incrementally, ALWAYS use
    `mesh.rotate(BABYLON.Axis.Y, 0.01, BABYLON.Space.LOCAL)` — do NOT mutate
    `mesh.rotation.y += 0.01`. Imported GLB models (loaded from the library) have a
    `rotationQuaternion` set by the loader, and when that is present Babylon.js IGNORES
    the Euler `mesh.rotation` property, so `rotation.y += …` silently does nothing.
    `mesh.rotate(...)` updates the quaternion correctly and works for BOTH procedurally
    built meshes and imported models. Likewise prefer `mesh.translate(...)` or mutating
    `mesh.position` for movement.
  * Animations are CUMULATIVE: every turn re-runs in the same scene, so guard observers
    so they are only registered once. Use a flag on `scene`, e.g.
    `if (!scene._myMeshSpin) { scene._myMeshSpin = scene.onBeforeRenderObservable.add(() => { mesh.rotate(BABYLON.Axis.Y, 0.01, BABYLON.Space.LOCAL); }); }`.
    This prevents duplicate observers that make a mesh spin faster each time.
  * The page AUTO-SCALES whatever you add each turn to a consistent canonical size and
    frames the camera on it, so you do NOT need to worry about absolute units or making
    things fit the view. Focus on correct RELATIVE proportions between objects (a door
    smaller than its wall, a wheel smaller than its car). Build near the origin; the
    page rests new content on the ground and centers the first object for you.
  * After this normalization, every object already in the scene (built or loaded from the
    library) is about 5 world units across its largest dimension, sits ON the ground
    (its base near y = 0), and is positioned near the origin. So when you MOVE, PLACE or
    ANIMATE existing objects, use coordinates IN THAT SCALE: small offsets of a few units
    (and at most a few tens of units) are what stay on screen — e.g. spacing cars ~6-8
    units apart, or animating a position between x = -5 and x = 5. Keep y >= 0 so objects
    rest on or above the ground, and do NOT use large values like 100 or 1000 (the object
    will fly far out of view). These edits are in plain WORLD units: set `mesh.position`
    (or `mesh.position.x`, etc.) directly — they are NOT multiplied by any hidden scale.

When you reply to the user:
  * Give a short, friendly explanation of what you are adding to the scene.
  * Provide the code in a single ```javascript fenced code block. The web client
    extracts that block and executes it in the canvas, so it MUST be valid on its own.

Loading real 3D models from the library:
  You also have two tools to bring ready-made GLB models (chairs, animals, vehicles,
  characters, …) into the scene instead of building everything from primitives:
    * `list_available_models(query)` — search the library. It returns a JSON array of
      models, each with `name`, `imageUrl` (a thumbnail) and `modelUrl`.
    * `download_model(model_url, name, scale)` — returns the Babylon.js code that loads
      a chosen model into the scene.

  Workflow:
    * When the user wants to find or browse real models ("find a chair", "show me some
      dinosaurs", "do you have a spaceship?"), call `list_available_models`. Then, in
      your reply, include the tool's JSON array VERBATIM inside a single fenced block
      tagged ```models (NOT ```javascript). The web client renders those thumbnails as a
      gallery in the chat. Add a short friendly sentence before the block. Do NOT also
      write Babylon.js code in this turn — just present the gallery.
    * Example reply shape:
        Here are a few chairs I found:
        ```models
        [{"name":"Wooden Chair","imageUrl":"https://…","modelUrl":"https://….glb"}]
        ```
    * When the user then picks one ("load the wooden one", "add the 2nd", "the
      spaceship"), call `download_model` with that model's `modelUrl`, a short
      descriptive `name`, and a `scale` (1 unless they ask bigger/smaller). The page
      auto-scales imported models to the same canonical size, so `scale` is just a
      RELATIVE multiplier on top of that (e.g. 2 for "twice as big"). Put the code it
      returns into a single ```javascript block so the browser loads the model. This
      model-loading code is deterministic — do NOT validate it.
    * If `list_available_models` returns "[]", tell the user nothing matched and suggest
      a different search term. If it returns an "ERROR:…" string, briefly apologize and
      do not include a ```models block.

  Animating loaded models:
    * Imported models carry a `rotationQuaternion`, so to rotate/spin one you MUST use
      `mesh.rotate(BABYLON.Axis.Y, 0.01, BABYLON.Space.LOCAL)` (see the animation rules
      above). `mesh.rotation.y += …` will appear to do nothing on a loaded model.
"""

VALIDATION_INSTRUCTIONS = """\

Validation workflow (REQUIRED):
  * Before sending your reply, call the `validate_babylon_code` tool with the exact
    snippet you intend to return.
  * If it returns "OK", include that snippet in your reply.
  * If it returns a string starting with "ERROR:", fix the snippet based on the message
    and call the tool again. Retry up to 3 times.
  * If it still fails after 3 attempts, briefly tell the user you could not generate
    valid code and do not include a code block.
  * The validation sandbox shares the same cumulative scene state as the browser, so
    only validate the NEW snippet for the current turn.
  * Only validate code YOU wrote. Model-loading code returned by `download_model` is
    deterministic and must NOT be validated.
  * Keeping the sandbox in sync with browser-side loads: when you receive a
    `[scene event]` note saying the user loaded a model by clicking a gallery thumbnail,
    the model was imported in the BROWSER only — the validation sandbox does not know
    about it. Immediately call `register_loaded_mesh` with that model's mesh name so the
    sandbox gets a matching mesh. Otherwise a later request to animate/move/scale that
    model will fail validation with `Mesh "<name>" not found`.
"""


def build_instructions() -> str:
    if _validation_enabled():
        return BASE_INSTRUCTIONS + VALIDATION_INSTRUCTIONS
    return BASE_INSTRUCTIONS


def _extract_latest_user_prompt(messages) -> str | None:
    """Best-effort: join the text of the most recent user message in the turn input."""
    if not messages:
        return None
    try:
        for message in reversed(list(messages)):
            role = getattr(message, "role", None)
            role_value = getattr(role, "value", role)
            if role_value not in ("user", None):
                continue
            text = getattr(message, "text", None)
            if text:
                return text
            parts: list[str] = []
            for content in getattr(message, "contents", None) or []:
                part = getattr(content, "text", None)
                if part:
                    parts.append(part)
            if parts:
                return " ".join(parts)
    except Exception:  # noqa: BLE001 - prompt capture must never break the turn
        return None
    return None


def _resolve_conversation_id(context) -> str | None:
    """Best-effort resolution of a stable conversation id for failure attribution."""
    try:
        for source in (
            getattr(context, "metadata", None),
            getattr(context, "kwargs", None),
        ):
            if isinstance(source, dict):
                value = source.get("conversation_id")
                if value:
                    return str(value)
        agent = getattr(context, "agent", None)
        headers = getattr(agent, "_request_headers", None)
        if isinstance(headers, dict) and headers.get("conversation_id"):
            return str(headers["conversation_id"])
    except Exception:  # noqa: BLE001
        return None
    return None


class PromptCaptureMiddleware(AgentMiddleware):
    """Capture the user prompt + conversation/session id for the current turn.

    The `validate_babylon_code` tool only receives the `code` argument, so it cannot see
    the prompt that produced the code nor the conversation it belongs to. This middleware
    runs once per turn and stashes that context into contextvars (and resets the per-turn
    validation attempt counter) so a captured failure can be attributed correctly.
    """

    async def process(self, context, call_next):
        try:
            _CURRENT_PROMPT.set(_extract_latest_user_prompt(getattr(context, "messages", None)))
            _CURRENT_CONV_ID.set(_resolve_conversation_id(context))
            session = getattr(context, "session", None)
            _CURRENT_SESSION_ID.set(
                str(getattr(session, "session_id", None)) if session is not None else None
            )
            _ATTEMPT_COUNTER.set(0)
        except Exception:  # noqa: BLE001 - never block the turn on capture setup
            logger.warning("PromptCaptureMiddleware: failed to capture turn context", exc_info=True)
        await call_next()


def create_chat_client() -> FoundryChatClient:
    """Build the Foundry chat client from environment configuration."""
    return FoundryChatClient(
        project_endpoint=os.environ["PROJECT_ENDPOINT"],
        model=os.environ["MODEL_DEPLOYMENT_NAME"],
        credential=DefaultAzureCredential(),
    )


def create_agent(client: FoundryChatClient) -> Agent:
    """Create the Agent with its tools.

    The model-discovery tools (`list_available_models`, `download_model`) are always
    available; the `validate_babylon_code` tool is added only when validation is enabled.
    No `name=` is passed: the hosted-agent identity comes from agent.yaml. `store` is
    disabled so the Foundry service does not persist server-side conversation state —
    the web client drives multi-turn continuity via `previous_response_id`.
    """
    tools = [list_available_models, download_model, list_validation_failures]
    if _validation_enabled():
        tools.append(validate_babylon_code)
        tools.append(register_loaded_mesh)
    return Agent(
        client=client,
        instructions=build_instructions(),
        tools=tools,
        middleware=[PromptCaptureMiddleware()],
        default_options={"store": False},
    )


async def run_cli() -> None:
    """Interactive terminal loop — handy for quick local testing without the web UI."""
    client = create_chat_client()
    async with create_agent(client) as agent:
        print(
            f"Babylon3DAgent ready (validation "
            f"{'ON' if _validation_enabled() else 'OFF'}). Type 'exit' to quit.\n"
        )
        thread = agent.get_new_thread()
        while True:
            try:
                user_input = input("you> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if user_input.lower() in ("exit", "quit"):
                break
            if not user_input:
                continue
            result = await agent.run(user_input, thread=thread)
            print(f"agent> {result.text}\n")


async def run_server() -> None:
    """Host the agent as an HTTP server (OpenAI Responses API) for Foundry / F5."""
    client = create_chat_client()
    async with create_agent(client) as agent:
        server = ResponsesHostServer(agent)
        await server.run_async(port=SERVER_PORT)


def main() -> None:
    if "--cli" in sys.argv:
        asyncio.run(run_cli())
    else:
        asyncio.run(run_server())


if __name__ == "__main__":
    main()
