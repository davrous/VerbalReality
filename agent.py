"""Babylon3DAgent — a Microsoft Foundry hosted agent that generates Babylon.js code.

The agent turns natural-language requests into Babylon.js JavaScript snippets that
operate on an existing `scene` (and `engine`) in the browser. The generated code is
cumulative: new snippets can reference meshes created in previous turns by name.

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

When you reply to the user:
  * Give a short, friendly explanation of what you are adding to the scene.
  * Provide the code in a single ```javascript fenced code block. The web client
    extracts that block and executes it in the canvas, so it MUST be valid on its own.
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
    """Create the Agent with or without the validation tool, based on the flag.

    No `name=` is passed: the hosted-agent identity comes from agent.yaml. `store` is
    disabled so the Foundry service does not persist server-side conversation state —
    the web client drives multi-turn continuity via `previous_response_id`.
    """
    tools = [validate_babylon_code] if _validation_enabled() else None
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
