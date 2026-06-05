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
import json
import os
import sys
from typing import Annotated

import httpx
from agent_framework import Agent, tool
from agent_framework.foundry import FoundryChatClient
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.identity import DefaultAzureCredential
from dotenv import load_dotenv

# override=True so that values in .env also win in deployed environments.
load_dotenv(override=True)


def _validation_enabled() -> bool:
    return os.environ.get("ENABLE_VALIDATION", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


VALIDATOR_URL = os.environ.get("VALIDATOR_URL", "http://localhost:8087/validate")

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
        return f"ERROR: could not reach the validation service ({exc})."

    if data.get("ok"):
        print("[agent] tool validate_babylon_code: OK", flush=True)
        return "OK"
    error = data.get("error", "unknown validation error")
    print(f"[agent] tool validate_babylon_code: ERROR - {error}", flush=True)
    return f"ERROR: {error}"


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
  * The page AUTO-SCALES whatever you add each turn to a consistent canonical size and
    frames the camera on it, so you do NOT need to worry about absolute units or making
    things fit the view. Focus on correct RELATIVE proportions between objects (a door
    smaller than its wall, a wheel smaller than its car). Build near the origin; the
    page rests new content on the ground and centers the first object for you.

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
"""


def build_instructions() -> str:
    if _validation_enabled():
        return BASE_INSTRUCTIONS + VALIDATION_INSTRUCTIONS
    return BASE_INSTRUCTIONS


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
    tools = [list_available_models, download_model]
    if _validation_enabled():
        tools.append(validate_babylon_code)
    return Agent(
        client=client,
        instructions=build_instructions(),
        tools=tools,
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
