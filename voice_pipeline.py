"""Foundry-native voice pipeline for the Babylon3DAgent (invocations_ws + Azure Speech).

This module adds a real-time, push-to-talk VOICE path ALONGSIDE the existing text
Responses API — it does not replace it. The browser opens a WebSocket, streams 16 kHz
PCM microphone audio while the user holds the talk button, and this module runs a
cascaded pipeline inside the container:

    microphone audio ──▶ Azure Speech STT ──▶ the SAME in-process Agent ──▶
        • control frames (mirroring the browser's existing SSE event schema, so the
          client runs the returned Babylon.js code and renders galleries EXACTLY as it
          does for typed turns), and
        • Azure Speech TTS of the PROSE ONLY (every ```fenced``` block — JavaScript,
          ```models, ```textures — is stripped before synthesis, so the agent never
          reads code aloud while the code still reaches the canvas).

Transport
---------
For local development the WebSocket is served directly by `run_ws_server()` (the
`websockets` library) on its own port; the webchat backend relays the browser to it.
On Foundry this same frame protocol rides the hosted-agent `invocations_ws` preview
protocol (North Central US): the platform transparently relays raw text/binary frames
to the container, so the per-connection logic in `VoiceSession` is transport-agnostic
and `drive_connection()` can be wired to either transport.

Frame protocol (JSON text control + raw binary PCM)
---------------------------------------------------
client → server (text):   {"type":"start"}            begin an utterance (push-to-talk down)
                          {"type":"commit"}           end utterance, run the turn (button up)
                          {"type":"cancel"}           barge-in: stop any playback/synthesis
client → server (binary): 16 kHz / 16-bit / mono PCM frames (while talking)

server → client (text):   {"type":"stt","text":...}        recognized transcript (user bubble)
                          {"type":"tool","name":...}       a tool/validation step (activity HUD)
                          {"type":"delta","text":...}      streamed reply text
                          {"type":"done","reply":...}      final reply (browser runs its code)
                          {"type":"speaking_start"}        TTS audio is about to stream
                          {"type":"speaking_end"}          TTS audio finished
                          {"type":"error","error":...}     a turn-level error
server → client (binary): 16 kHz / 16-bit / mono PCM frames (the spoken prose)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any, Awaitable, Callable

logger = logging.getLogger("babylon3d_agent.voice")

# --- audio format shared by STT input and TTS output --------------------------------
SAMPLE_RATE = 16000
BITS_PER_SAMPLE = 16
CHANNELS = 1
# ~20 ms of 16 kHz/16-bit/mono audio = 640 bytes; we send TTS in small frames so the
# browser starts playing quickly and barge-in can interrupt promptly.
TTS_FRAME_BYTES = 640


def _voice_enabled() -> bool:
    return os.environ.get("ENABLE_VOICE", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _speech_configured() -> bool:
    """Voice needs an Azure Speech resource: either a key+region or a custom endpoint."""
    has_region = bool(os.environ.get("SPEECH_REGION"))
    has_key = bool(os.environ.get("SPEECH_KEY"))
    has_endpoint = bool(os.environ.get("SPEECH_ENDPOINT"))
    return (has_key and has_region) or has_endpoint or (has_region and _use_aad_for_speech())


def _use_aad_for_speech() -> bool:
    """When no SPEECH_KEY is set, authenticate to Speech with the agent's Entra identity."""
    return not os.environ.get("SPEECH_KEY")


def voice_available() -> bool:
    """True when the voice path should be started (feature flag on + Speech configured)."""
    return _voice_enabled() and _speech_configured()


VOICE_WS_PORT = int(os.environ.get("VOICE_WS_PORT", "8089"))
VOICE_WS_PATH = os.environ.get("VOICE_WS_PATH", "/invocations_ws")
SPEECH_VOICE_NAME = os.environ.get("SPEECH_VOICE_NAME", "en-US-AvaMultilingualNeural")
# STT language; Azure also supports auto-detect, but a single locale keeps latency low.
SPEECH_RECOGNITION_LANGUAGE = os.environ.get("SPEECH_RECOGNITION_LANGUAGE", "en-US")
SPEECH_AAD_SCOPE = os.environ.get("SPEECH_AAD_SCOPE", "https://cognitiveservices.azure.com/.default")

# Voice turns run through the SAME local OpenAI Responses endpoint that the typed chat
# uses, so both protocols chain on a shared `previous_response_id` and therefore share
# ONE conversation history. The webchat relay injects the current id before each voice
# turn and stores the new id when the turn completes (see webchat/server.js).
SERVER_PORT = int(os.environ.get("PORT", "8088"))
LOCAL_RESPONSES_URL = os.environ.get(
    "LOCAL_RESPONSES_URL", f"http://localhost:{SERVER_PORT}/responses"
)
# Mirror the value the webchat backend sends for typed turns so behaviour is identical.
AGENT_MODEL = os.environ.get("AGENT_MODEL", "gpt-4.1")


def _is_hosted() -> bool:
    """True when running inside a managed-identity environment (Foundry / Azure)."""
    return bool(os.environ.get("IDENTITY_ENDPOINT") or os.environ.get("MSI_ENDPOINT"))


# --- shared keyless Speech auth ----------------------------------------------------
# One process-wide credential + cached token, reused by every voice session. Two reasons:
#   * Avoid the ~4 s stall on the FIRST request: locally (no managed identity) the default
#     DefaultAzureCredential probes the Azure IMDS endpoint (169.254.169.254) first, which
#     times out and retries before falling back to the Azure CLI login. We skip the managed
#     identity probe entirely when not hosted, and pre-warm the token at startup.
#   * The Speech SDK's `auth_token` is a static string; caching + refresh keeps long-lived
#     sessions valid without re-minting a token on every utterance.
_speech_credential: Any = None
_speech_token: str | None = None
_speech_token_expiry: float = 0.0


def _get_speech_credential() -> Any:
    global _speech_credential
    if _speech_credential is None:
        from azure.identity import DefaultAzureCredential  # noqa: PLC0415

        # On Foundry the managed (agent) identity is the right credential. Locally there is
        # none, so excluding it avoids the slow IMDS probe and uses the CLI login directly.
        _speech_credential = DefaultAzureCredential(
            exclude_managed_identity_credential=not _is_hosted()
        )
    return _speech_credential


def get_speech_token(force: bool = False) -> str:
    """Return a cached Speech AAD token, refreshing ~5 min before expiry."""
    global _speech_token, _speech_token_expiry
    import time  # noqa: PLC0415

    now = time.time()
    if force or _speech_token is None or (_speech_token_expiry - now) < 300:
        result = _get_speech_credential().get_token(SPEECH_AAD_SCOPE)
        _speech_token = result.token
        _speech_token_expiry = float(getattr(result, "expires_on", now + 3600))
    return _speech_token


def prewarm_speech_auth() -> None:
    """Best-effort: mint the first token at startup so the first request isn't slowed."""
    if not _speech_configured() or os.environ.get("SPEECH_KEY"):
        return
    try:
        get_speech_token()
        logger.info("voice: Speech auth token pre-warmed.")
    except Exception:  # noqa: BLE001 - non-fatal; the first request will mint on demand
        logger.warning("voice: failed to pre-warm Speech auth token", exc_info=True)



# Mirror of the browser's stripFencedBlocks() (webchat/public/app.js): remove every
# fenced block (```javascript, ```models, ```textures, …) so only the agent's prose is
# spoken. The code itself still travels to the browser inside the {"type":"done"} frame.
_FENCE_RE = re.compile(r"```[a-z]*\s*\n.*?```", re.IGNORECASE | re.DOTALL)


def strip_fenced_blocks(text: str | None) -> str:
    if not text:
        return ""
    return _FENCE_RE.sub("", text).strip()


def _extract_responses_text(response: Any) -> str:
    """Pull the assistant text out of a Responses API `response` object (any known shape)."""
    if not isinstance(response, dict):
        return ""
    if isinstance(response.get("output_text"), str) and response["output_text"]:
        return response["output_text"]
    parts: list[str] = []
    for item in response.get("output") or []:
        for c in (item or {}).get("content") or []:
            if not isinstance(c, dict):
                continue
            t = c.get("text")
            if isinstance(t, str):
                parts.append(t)
            elif isinstance(t, dict) and isinstance(t.get("value"), str):
                parts.append(t["value"])
    return "\n".join(parts).strip()


def _extract_tool_names(update: Any) -> list[str]:
    """Best-effort: pull tool/function-call names out of a streaming update.

    The agent-framework update surfaces text deltas directly; tool calls live inside the
    structured contents. We scan the update's dict shape defensively so a schema change
    just yields no tool indicators rather than breaking the turn.
    """
    names: list[str] = []
    try:
        data = update.to_dict() if hasattr(update, "to_dict") else None
    except Exception:  # noqa: BLE001
        data = None
    if not isinstance(data, dict):
        return names

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            ntype = str(node.get("type", "")).lower()
            name = node.get("name")
            if name and ("function" in ntype or "tool" in ntype or "call" in ntype):
                names.append(str(name))
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    return names


class VoiceSession:
    """Owns one browser voice connection: STT capture, an agent turn, and TTS playback.

    `send_text`/`send_bytes` are async callables that write a frame back to the client.
    The session keeps a single agent conversation `session` so multi-turn voice requests
    stay cumulative ("make it twice as big" references the sphere built a moment ago),
    just like the typed chat keeps context via previous_response_id.
    """

    def __init__(
        self,
        agent: Any,
        send_text: Callable[[dict], Awaitable[None]],
        send_bytes: Callable[[bytes], Awaitable[None]],
        session_id: str | None = None,
    ) -> None:
        self._agent = agent
        self._send_text = send_text
        self._send_bytes = send_bytes
        self._loop = asyncio.get_event_loop()

        # Lazily import the Speech SDK so the Responses-only path never requires it.
        import azure.cognitiveservices.speech as speechsdk  # noqa: PLC0415

        self._speechsdk = speechsdk
        self._speech_config = self._build_speech_config()
        self._stream_format = speechsdk.audio.AudioStreamFormat(
            samples_per_second=SAMPLE_RATE,
            bits_per_sample=BITS_PER_SAMPLE,
            channels=CHANNELS,
        )

        # Per-utterance STT state (recreated on each {"type":"start"}).
        self._push_stream: Any = None
        self._recognizer: Any = None
        self._recognized_parts: list[str] = []
        self._capturing = False

        # Conversation continuity is SHARED with the typed chat: every voice turn runs
        # through the same local /responses endpoint and chains on previous_response_id,
        # which the webchat relay keeps in sync with typed turns (it sends the current id
        # in a {"type":"context"} frame before each turn, and stores the new id from the
        # {"type":"done"} frame this session returns).
        self._previous_response_id: str | None = None

        # Barge-in flag: set while we are streaming TTS so a new utterance can stop it.
        self._cancel_speech = asyncio.Event()
        self._speaking = False
        self._synthesizer: Any = None

    # --- setup ---------------------------------------------------------------------
    def _build_speech_config(self) -> Any:
        speechsdk = self._speechsdk
        key = os.environ.get("SPEECH_KEY")
        region = os.environ.get("SPEECH_REGION")
        endpoint = os.environ.get("SPEECH_ENDPOINT")

        if key and region:
            config = speechsdk.SpeechConfig(subscription=key, region=region)
        elif key and endpoint:
            config = speechsdk.SpeechConfig(subscription=key, endpoint=endpoint)
        else:
            # Keyless: authenticate with the agent's Entra identity (DefaultAzureCredential).
            token = self._fetch_aad_token()
            auth = f"aad#{os.environ.get('SPEECH_RESOURCE_ID', '')}#{token}" if os.environ.get(
                "SPEECH_RESOURCE_ID"
            ) else None
            if endpoint:
                config = speechsdk.SpeechConfig(auth_token=token, endpoint=endpoint) if not auth else speechsdk.SpeechConfig(
                    auth_token=auth, endpoint=endpoint
                )
            else:
                config = speechsdk.SpeechConfig(auth_token=auth or token, region=region)

        config.speech_recognition_language = SPEECH_RECOGNITION_LANGUAGE
        config.speech_synthesis_voice_name = SPEECH_VOICE_NAME
        # Raw 16 kHz PCM out so we can frame it straight to the browser's Web Audio queue.
        config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Raw16Khz16BitMonoPcm
        )
        return config

    def _fetch_aad_token(self) -> str:
        # Uses the shared, cached, pre-warmed token (see get_speech_token) so the first
        # request doesn't stall on credential discovery.
        return get_speech_token()

    # --- frame entry points --------------------------------------------------------
    async def on_control(self, message: dict) -> None:
        mtype = (message or {}).get("type")
        if mtype == "start":
            await self._start_capture()
        elif mtype == "context":
            # Sent by the webchat relay before a turn: the current shared response id, so
            # the voice turn continues whatever the typed chat (or a prior voice turn) last
            # produced.
            self._previous_response_id = (message or {}).get("previous_response_id") or None
        elif mtype == "commit":
            rid = (message or {}).get("previous_response_id")
            if rid:
                self._previous_response_id = rid
            await self._commit_and_run()
        elif mtype == "cancel":
            await self._barge_in()
        else:
            logger.debug("voice: ignoring unknown control frame %r", mtype)

    async def on_audio(self, chunk: bytes) -> None:
        if self._capturing and self._push_stream is not None and chunk:
            # PushAudioInputStream.write is non-blocking (buffers internally).
            self._push_stream.write(chunk)

    # --- STT -----------------------------------------------------------------------
    async def _start_capture(self) -> None:
        # A new utterance interrupts any in-flight speech (barge-in).
        await self._barge_in()
        if self._capturing:
            return
        speechsdk = self._speechsdk
        self._recognized_parts = []
        self._push_stream = speechsdk.audio.PushAudioInputStream(stream_format=self._stream_format)
        audio_config = speechsdk.audio.AudioConfig(stream=self._push_stream)
        self._recognizer = speechsdk.SpeechRecognizer(
            speech_config=self._speech_config, audio_config=audio_config
        )

        def _on_recognized(evt: Any) -> None:
            if evt.result.reason == speechsdk.ResultReason.RecognizedSpeech and evt.result.text:
                self._recognized_parts.append(evt.result.text)

        self._recognizer.recognized.connect(_on_recognized)
        await self._loop.run_in_executor(
            None, lambda: self._recognizer.start_continuous_recognition_async().get()
        )
        self._capturing = True

    async def _commit_and_run(self) -> None:
        if not self._capturing:
            return
        self._capturing = False
        try:
            if self._push_stream is not None:
                self._push_stream.close()
            if self._recognizer is not None:
                await self._loop.run_in_executor(
                    None, lambda: self._recognizer.stop_continuous_recognition_async().get()
                )
        finally:
            self._recognizer = None
            self._push_stream = None

        transcript = " ".join(p for p in self._recognized_parts if p).strip()
        if not transcript:
            await self._send_text({"type": "error", "error": "Sorry, I didn't catch that."})
            return
        await self._send_text({"type": "stt", "text": transcript})
        await self._run_turn(transcript)

    # --- agent turn ----------------------------------------------------------------
    async def _run_turn(self, transcript: str) -> None:
        # Drive the turn through the shared local /responses store (the SAME endpoint the
        # typed chat uses) so voice and typed turns are ONE conversation. Stream the SSE
        # and translate it to the same WS frames the browser already handles for typed
        # turns, then echo the new response id so the relay can keep the shared chain.
        import httpx  # noqa: PLC0415

        reply = ""
        seen_tools: set[str] = set()
        new_response_id: str | None = None
        errored = False

        body: dict = {"model": AGENT_MODEL, "input": transcript, "stream": True}
        if self._previous_response_id:
            body["previous_response_id"] = self._previous_response_id

        try:
            timeout = httpx.Timeout(300.0, connect=10.0)
            async with httpx.AsyncClient(timeout=timeout) as http:
                async with http.stream(
                    "POST",
                    LOCAL_RESPONSES_URL,
                    json=body,
                    headers={"Accept": "text/event-stream"},
                ) as resp:
                    if resp.status_code >= 400:
                        raw = (await resp.aread())[:300]
                        raise RuntimeError(f"responses {resp.status_code}: {raw!r}")
                    async for line in resp.aiter_lines():
                        if not line or not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if not data or data == "[DONE]":
                            continue
                        try:
                            evt = json.loads(data)
                        except ValueError:
                            continue
                        etype = evt.get("type", "")
                        r = evt.get("response")
                        if isinstance(r, dict) and r.get("id"):
                            new_response_id = r["id"]
                        if etype.endswith("output_text.delta") and isinstance(evt.get("delta"), str):
                            reply += evt["delta"]
                            await self._send_text({"type": "delta", "text": evt["delta"]})
                        elif etype == "response.output_item.done":
                            item = evt.get("item") or {}
                            if item.get("type") == "function_call" and item.get("name"):
                                key = item.get("id") or item.get("call_id") or item["name"]
                                if key not in seen_tools:
                                    seen_tools.add(key)
                                    await self._send_text({"type": "tool", "name": item["name"]})
                        elif etype in ("response.completed", "response.incomplete"):
                            txt = _extract_responses_text(r)
                            if txt:
                                reply = txt
                        elif etype in ("response.failed", "error"):
                            msg = None
                            if isinstance(r, dict):
                                msg = (r.get("error") or {}).get("message")
                            msg = msg or evt.get("message") or "Agent reported a failure."
                            await self._send_text({"type": "error", "error": msg})
                            errored = True
        except Exception as err:  # noqa: BLE001
            logger.exception("voice: agent turn failed")
            await self._send_text({"type": "error", "error": str(err) or "Agent error."})
            return

        if errored:
            return

        if new_response_id:
            self._previous_response_id = new_response_id

        # Echo the new response id so the webchat relay keeps the shared chain in sync.
        await self._send_text({"type": "done", "reply": reply, "response_id": new_response_id})

        # Speak only the prose — never the code that the browser is about to execute.
        prose = strip_fenced_blocks(reply)
        if prose:
            await self._speak(prose)

    # --- TTS -----------------------------------------------------------------------
    async def _speak(self, prose: str) -> None:
        speechsdk = self._speechsdk
        self._cancel_speech.clear()
        self._speaking = True
        await self._send_text({"type": "speaking_start"})
        try:
            # Pull-based synthesis so we can stream PCM out frame-by-frame and stop early
            # on barge-in instead of waiting for the whole utterance to render.
            synthesizer = speechsdk.SpeechSynthesizer(speech_config=self._speech_config, audio_config=None)
            self._synthesizer = synthesizer
            result = await self._loop.run_in_executor(
                None, lambda: synthesizer.speak_text_async(prose).get()
            )
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                audio = result.audio_data or b""
                for i in range(0, len(audio), TTS_FRAME_BYTES):
                    if self._cancel_speech.is_set():
                        break
                    await self._send_bytes(audio[i : i + TTS_FRAME_BYTES])
                    # Yield so cancel frames are processed between chunks.
                    await asyncio.sleep(0)
            elif result.reason == speechsdk.ResultReason.Canceled:
                details = result.cancellation_details
                logger.warning("voice: TTS canceled: %s", getattr(details, "error_details", details))
        except Exception:  # noqa: BLE001 - speech failure must not kill the connection
            logger.exception("voice: synthesis failed")
        finally:
            self._speaking = False
            self._synthesizer = None
            await self._send_text({"type": "speaking_end"})

    async def _barge_in(self) -> None:
        if self._speaking:
            self._cancel_speech.set()
            synth = self._synthesizer
            if synth is not None:
                try:
                    await self._loop.run_in_executor(None, lambda: synth.stop_speaking_async().get())
                except Exception:  # noqa: BLE001
                    pass

    async def close(self) -> None:
        await self._barge_in()
        if self._recognizer is not None:
            try:
                await self._loop.run_in_executor(
                    None, lambda: self._recognizer.stop_continuous_recognition_async().get()
                )
            except Exception:  # noqa: BLE001
                pass
        self._recognizer = None
        self._push_stream = None


async def drive_connection(
    agent: Any,
    *,
    send_text: Callable[[dict], Awaitable[None]],
    send_bytes: Callable[[bytes], Awaitable[None]],
    incoming: Any,
    session_id: str | None = None,
) -> None:
    """Transport-agnostic loop: feed text/binary frames from `incoming` into a session.

    `incoming` is an async iterator yielding either `str` (JSON control) or `bytes`
    (PCM). This is shared by the local `websockets` server and can be reused by a
    Foundry `invocations_ws` `@app.ws_handler`.
    """
    session = VoiceSession(agent, send_text, send_bytes, session_id=session_id)
    try:
        async for message in incoming:
            if isinstance(message, (bytes, bytearray)):
                await session.on_audio(bytes(message))
            else:
                try:
                    control = json.loads(message)
                except (ValueError, TypeError):
                    continue
                await session.on_control(control)
    finally:
        await session.close()


async def run_ws_server(agent: Any, *, host: str = "0.0.0.0", port: int | None = None) -> None:
    """Serve the voice WebSocket (local dev + the container side of invocations_ws).

    Runs forever; intended to be `asyncio.gather`-ed alongside the Responses server.
    """
    import websockets  # noqa: PLC0415

    port = port or VOICE_WS_PORT

    # Mint the first Speech token now (off the event loop) so the first user request isn't
    # delayed by credential discovery.
    try:
        await asyncio.get_event_loop().run_in_executor(None, prewarm_speech_auth)
    except Exception:  # noqa: BLE001 - non-fatal
        pass

    async def handler(websocket: Any) -> None:
        peer = getattr(websocket, "remote_address", None)
        logger.info("voice: client connected %s", peer)

        async def send_text(obj: dict) -> None:
            await websocket.send(json.dumps(obj))

        async def send_bytes(data: bytes) -> None:
            await websocket.send(data)

        try:
            await drive_connection(
                agent,
                send_text=send_text,
                send_bytes=send_bytes,
                incoming=websocket,
            )
        except Exception:  # noqa: BLE001
            logger.info("voice: connection closed (%s)", peer)

    logger.info("voice: WebSocket server listening on ws://%s:%d%s", host, port, VOICE_WS_PATH)
    async with websockets.serve(handler, host, port, max_size=2 * 1024 * 1024):
        await asyncio.Future()  # run until cancelled
