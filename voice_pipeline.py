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
# 24 kHz PCM16 mono follows the Voice Live best-practices guidance for browser/app capture
# (24 kHz native — avoids resampling round-trips) and yields noticeably more natural HD-voice
# prosody than 16 kHz. Telephony bridges would use 16 kHz, but this app captures from the
# browser, so 24 kHz is the right default.
SAMPLE_RATE = int(os.environ.get("VOICE_SAMPLE_RATE", "24000"))
BITS_PER_SAMPLE = 16
CHANNELS = 1
# ~20 ms of audio per frame so the browser starts playing quickly and barge-in can interrupt
# promptly: 24 kHz × 16-bit × 1ch × 20 ms = 960 bytes.
TTS_FRAME_BYTES = int(SAMPLE_RATE * (BITS_PER_SAMPLE // 8) * CHANNELS * 0.02)


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
# HD neural voice for a more natural spoken reply. `…MultilingualNeuralHD` voices are the
# HD tier available in North Central US (our region). The marquee `DragonHD` voices are NOT
# available in NCUS, so this default is the best HD option here; override with
# SPEECH_VOICE_NAME if your Speech resource lives in a DragonHD region (SEA/IN/SW/WE/EUS/
# EUS2/WUS2). If the configured voice is unsupported, synthesis falls back to SPEECH_VOICE_FALLBACK.
SPEECH_VOICE_NAME = os.environ.get("SPEECH_VOICE_NAME", "en-US-NovaMultilingualNeuralHD")
SPEECH_VOICE_FALLBACK = os.environ.get("SPEECH_VOICE_FALLBACK", "en-US-AvaMultilingualNeural")
# Spoken-progress cadence (Voice Live "interim response" pattern). Two silent gaps exist in a
# code-gen turn: before the agent emits any prose, and the long stretch while it streams the
# JavaScript. We narrate progress to fill BOTH: a quick first acknowledgement, then a calmer
# repeated gap-fill while the agent keeps working — but only ever when there's a genuine gap
# (nothing queued and nothing being synthesized), so real prose is never delayed or talked over.
PROGRESS_FIRST_MS = int(os.environ.get("VOICE_PROGRESS_FIRST_MS", "900"))
PROGRESS_INTERVAL_MS = int(os.environ.get("VOICE_PROGRESS_INTERVAL_MS", "4500"))
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


# Spoken progress phrases that fill the two silent gaps of a turn: (1) before the agent has
# produced any prose, and (2) the longer stretch while it streams the JavaScript code (the
# prose streamer is silent then). They're varied and keyword-aware so the agent feels like
# it's narrating its work rather than repeating one canned line. The SAME text is sent to the
# browser as a {"type":"progress"} frame so the in-canvas HUD shows exactly what's spoken.
#
# OPENERS: a quick acknowledgement spoken first ("I'm on it") so the user isn't left waiting.
PROGRESS_OPENERS = (
    "Okay, let me build that.",
    "Sure — working on it now.",
    "Got it. Putting that together.",
    "On it. Give me a moment.",
    "Alright, creating that for you.",
    "Let me set that up.",
)
# WORKING: spoken while the agent is still generating, themed on a keyword from the request.
PROGRESS_WORKING_KW = (
    "Still shaping the {kw}…",
    "Adding the finishing touches to the {kw}…",
    "Wiring up the {kw} now…",
    "Almost there with the {kw}…",
    "Placing the {kw} into the scene…",
    "Tuning the materials for the {kw}…",
    "Just a moment more on the {kw}…",
    "Building the {kw} as we speak…",
)
# WORKING (generic): used when no good keyword can be extracted from the request.
PROGRESS_WORKING_GENERIC = (
    "Still working on it…",
    "Almost done…",
    "Putting the pieces together…",
    "Just a moment more…",
    "Bringing it to life…",
    "Nearly there…",
    "Hang tight, finishing up…",
)

_KW_STOPWORDS = frozenset(
    {
        "the", "and", "with", "that", "this", "create", "make", "build", "add",
        "please", "scene", "into", "from", "your", "some", "a", "an", "of", "to",
        "for", "on", "in", "it", "me", "show", "give", "above", "below", "around",
        "can", "you", "could", "would", "want", "need", "put", "place", "let",
        "us", "then", "now", "here", "there", "one", "two", "three", "new",
    }
)


def _extract_keyword(text: str | None) -> str:
    """Pick a short, speakable noun-ish keyword from the user's request (mirrors the
    in-canvas HUD's keyword theming). Falls back to '' when nothing meaningful is found."""
    if not text:
        return ""
    words = re.findall(r"[a-zA-Z][a-zA-Z\-]{2,}", text.lower())
    for w in reversed(words):  # last meaningful noun is usually the object ("a red car")
        if w not in _KW_STOPWORDS:
            return w
    return ""


def _speakable_prose(text: str) -> str:
    """Prose safe to speak NOW: complete fenced blocks removed, and any *unclosed* trailing
    fence dropped (we can't yet tell whether it's code), so we never read code aloud."""
    if not text:
        return ""
    prose = _FENCE_RE.sub(" ", text)
    # An opening ``` with no closing fence yet → drop from it to the end until it completes.
    open_idx = prose.rfind("```")
    if open_idx != -1:
        prose = prose[:open_idx]
    return prose


# True when the reply contains a runnable ```javascript / ```js block (i.e. the scene will
# actually change) — used to decide whether to speak a "there's your castle" closer.
_CODE_FENCE_RE = re.compile(r"```(?:javascript|js)?\s*\n", re.IGNORECASE)

# Markdown → speech normalization so TTS reads naturally instead of "dash backtick castle
# underscore keep backtick". Applied to every chunk just before synthesis.
_MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]+\)")  # [label](url) -> label
_MD_TICK_RE = re.compile(r"`([^`]*)`")  # `castle_keep` -> castle keep
_MD_EMPH_RE = re.compile(r"[*_]{1,3}([^*_]+)[*_]{1,3}")  # **bold** / _em_ -> text


def _normalize_for_speech(text: str | None) -> str:
    """Strip markdown so spoken output sounds natural (no 'backtick'/'asterisk'/'dash')."""
    if not text:
        return ""
    t = _MD_LINK_RE.sub(r"\1", str(text))
    t = _MD_TICK_RE.sub(lambda m: m.group(1).replace("_", " "), t)
    t = _MD_EMPH_RE.sub(r"\1", t)
    t = re.sub(r"^\s*[-*+]\s+", "", t, flags=re.MULTILINE)  # leading bullet markers
    t = re.sub(r"^\s*#{1,6}\s+", "", t, flags=re.MULTILINE)  # heading hashes
    t = t.replace("`", "").replace("*", "").replace("#", "")
    return re.sub(r"[ \t]+", " ", t).strip()


# Context-aware closing line spoken once the scene has actually been updated (the reply
# contained runnable code), so a voice turn ends on a satisfying "there it is" beat.
PROGRESS_CLOSERS_KW = (
    "There you go — your {kw} should be in view now.",
    "All set. Your {kw} is in the scene.",
    "Done! Take a look at your {kw}.",
    "And there's your {kw}.",
    "Your {kw} is ready on screen.",
    "There it is — your {kw} is in the scene.",
)
PROGRESS_CLOSERS_GENERIC = (
    "There you go — take a look.",
    "All done. Take a look at the scene.",
    "Done — the scene is updated.",
    "And there it is on screen.",
)


# Sentence boundary: punctuation (optionally followed by a quote/paren) then whitespace, OR a
# newline. Used to flush complete sentences to TTS as the reply streams in.
_SENTENCE_RE = re.compile(r".*?(?:[.!?:](?=[\s\"')\]]|$)|\n)", re.DOTALL)


class _ProseSentenceStreamer:
    """Feeds reply text deltas and yields complete, speakable sentences as they form.

    Strips fenced code incrementally so the agent's confirmation ("Done — I added three
    cubes…") can be spoken while the long code block is still being generated.
    """

    def __init__(self) -> None:
        self._reply = ""
        self._spoken = 0  # chars of speakable prose already emitted

    def feed(self, delta: str) -> list[str]:
        self._reply += delta
        prose = _speakable_prose(self._reply)
        if len(prose) <= self._spoken:
            return []
        pending = prose[self._spoken :]
        sentences: list[str] = []
        consumed = 0
        for m in _SENTENCE_RE.finditer(pending):
            sentence = m.group(0).strip()
            if sentence:
                sentences.append(sentence)
            consumed = m.end()
        self._spoken += consumed
        return sentences

    def flush(self) -> str:
        """Return any trailing prose with no terminal punctuation (end of turn)."""
        prose = _speakable_prose(self._reply).rstrip()
        tail = prose[self._spoken :].strip()
        self._spoken = len(prose)
        return tail


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

        # Optional per-turn note carried on the {"type":"commit"} frame when the page is in
        # default (manual) mode, so the spoken request is built with raw world-unit
        # coordinates (no auto-scale / camera framing). Cleared after each turn.
        self._pending_scene_note: str = ""

        # Barge-in flag: set while we are streaming TTS so a new utterance can stop it.
        self._cancel_speech = asyncio.Event()
        self._speaking = False
        self._synthesizer: Any = None

        # Streaming TTS: sentences are queued as the reply streams in and a background
        # worker synthesizes + streams them one at a time, so the first audio is heard
        # within ~1 s instead of after the whole (often long, code-heavy) reply.
        self._tts_queue: asyncio.Queue = asyncio.Queue()
        self._tts_worker_task: Any = None
        self._active_voice = SPEECH_VOICE_NAME

        # Spoken-progress state (narrating work to fill silent gaps during a turn).
        self._synthesizing = False  # True only while actively streaming a synthesized chunk
        self._last_speech_ts = 0.0  # monotonic time of the last queued/spoken audio
        self._progress_idx = 0  # round-robin index so progress phrases don't repeat

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
        # Raw 24 kHz PCM out so we can frame it straight to the browser's Web Audio queue.
        config.set_speech_synthesis_output_format(
            speechsdk.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm
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
            self._pending_scene_note = (message or {}).get("scene_note") or ""
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
        #
        # TTS is STREAMED: as the reply streams in, complete prose sentences are queued and
        # spoken immediately (the agent's "Done — I added three cubes…" is heard while the
        # long code block is still being generated). A spoken-progress loop narrates the work
        # to fill any genuine silence — both before the first prose and during the long code
        # stream — and mirrors the same text to the in-canvas HUD via {"type":"progress"}.
        import time  # noqa: PLC0415
        import httpx  # noqa: PLC0415

        reply = ""
        seen_tools: set[str] = set()
        new_response_id: str | None = None
        errored = False

        self._start_tts_worker()
        prose = _ProseSentenceStreamer()
        self._last_speech_ts = time.monotonic()
        # "emitted" counts everything queued (progress + prose); "prose" counts ONLY real
        # reply sentences, so we can detect a turn that produced no speakable prose and still
        # guarantee the agent speaks back after a voice request.
        state = {"done": False, "emitted": 0, "prose": 0, "kw": _extract_keyword(transcript)}
        progress_task = asyncio.ensure_future(self._progress_loop(state))

        def _end_progress() -> None:
            state["done"] = True
            progress_task.cancel()

        async def queue_sentences(sentences: list[str]) -> None:
            for s in sentences:
                state["emitted"] += 1
                state["prose"] += 1
                self._last_speech_ts = time.monotonic()
                await self._tts_queue.put(s)

        # In default (manual) mode the browser sends a scene note on the commit frame; feed
        # it to the agent (but NOT to the user transcript/TTS), then clear it for next turn.
        agent_input = transcript
        if self._pending_scene_note:
            agent_input = self._pending_scene_note + "\n\n" + transcript
        self._pending_scene_note = ""

        body: dict = {"model": AGENT_MODEL, "input": agent_input, "stream": True}
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
                            await queue_sentences(prose.feed(evt["delta"]))
                        elif etype == "response.output_item.done":
                            item = evt.get("item") or {}
                            if item.get("type") == "function_call" and item.get("name"):
                                key = item.get("id") or item.get("call_id") or item["name"]
                                if key not in seen_tools:
                                    seen_tools.add(key)
                                    await self._send_text({"type": "tool", "name": item["name"]})
                        elif etype in ("response.completed", "response.incomplete"):
                            txt = _extract_responses_text(r)
                            if txt and not reply:
                                # Non-streamed payload: feed it through the prose streamer too.
                                reply = txt
                                await queue_sentences(prose.feed(txt))
                        elif etype in ("response.failed", "error"):
                            msg = None
                            if isinstance(r, dict):
                                msg = (r.get("error") or {}).get("message")
                            msg = msg or evt.get("message") or "Agent reported a failure."
                            await self._send_text({"type": "error", "error": msg})
                            errored = True
        except Exception as err:  # noqa: BLE001
            logger.exception("voice: agent turn failed")
            _end_progress()
            await self._finish_tts_worker()
            await self._send_text({"type": "error", "error": str(err) or "Agent error."})
            return

        if errored:
            _end_progress()
            await self._finish_tts_worker()
            return

        if new_response_id:
            self._previous_response_id = new_response_id

        # Echo the new response id so the webchat relay keeps the shared chain in sync, and
        # the browser runs the returned code immediately (independent of the spoken audio).
        await self._send_text({"type": "done", "reply": reply, "response_id": new_response_id})

        # Speak any trailing prose (final sentence without terminal punctuation).
        tail = prose.flush()
        if tail:
            await queue_sentences([tail])

        # ALWAYS speak back after a voice request: if the streamer queued no prose at all
        # (e.g. a short markdown-only clarifying question), speak the whole reply now so the
        # user is never left with a silent text-only answer.
        if state["prose"] == 0:
            fallback = _speakable_prose(reply).strip()
            if fallback:
                await queue_sentences([fallback])

        # Context-aware closing line once the scene was actually updated (reply had runnable
        # code): a satisfying "there's your castle" beat themed on the request keyword.
        if _CODE_FENCE_RE.search(reply or ""):
            import random  # noqa: PLC0415

            kw = state.get("kw")
            closer = (
                random.choice(PROGRESS_CLOSERS_KW).format(kw=kw)
                if kw
                else random.choice(PROGRESS_CLOSERS_GENERIC)
            )
            await self._send_text({"type": "progress", "text": closer})  # mirror to HUD
            await self._tts_queue.put(closer)

        _end_progress()
        await self._finish_tts_worker()

    # --- streaming TTS -------------------------------------------------------------
    def _start_tts_worker(self) -> None:
        """Begin a fresh streaming-TTS turn: clear cancel + queue and spawn the worker."""
        self._cancel_speech.clear()
        # Drain any stale items from a previous turn.
        try:
            while True:
                self._tts_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        if self._tts_worker_task is None or self._tts_worker_task.done():
            self._tts_worker_task = asyncio.ensure_future(self._tts_worker_loop())

    async def _finish_tts_worker(self) -> None:
        """Signal end-of-turn and wait for queued audio to finish streaming."""
        await self._tts_queue.put(None)  # sentinel
        task = self._tts_worker_task
        if task is not None:
            try:
                await task
            except Exception:  # noqa: BLE001
                pass
        self._tts_worker_task = None

    async def _tts_worker_loop(self) -> None:
        """Pull sentences off the queue and synthesize + stream each one in order.

        A SINGLE SpeechSynthesizer is reused for the whole turn: creating a fresh one per
        sentence (as we did before) caused transient `Canceled` results when a reply had
        many short sentences — e.g. a bulleted clarifying question — which silently dropped
        most of the audio. Reuse + a one-shot retry makes every queued sentence actually speak.
        """
        started = False
        synth = self._make_synthesizer()
        try:
            while True:
                item = await self._tts_queue.get()
                if item is None:  # end-of-turn sentinel
                    break
                if self._cancel_speech.is_set():
                    continue  # barged-in: drain the rest quietly
                text = _normalize_for_speech(item)
                if not text:
                    continue  # was only markdown / punctuation
                if not started:
                    started = True
                    self._speaking = True
                    await self._send_text({"type": "speaking_start"})
                synth = await self._synthesize_and_stream(synth, text)
        finally:
            self._synthesizer = None
            if started:
                self._speaking = False
                await self._send_text({"type": "speaking_end"})

    def _make_synthesizer(self) -> Any:
        synth = self._speechsdk.SpeechSynthesizer(
            speech_config=self._speech_config, audio_config=None
        )
        self._synthesizer = synth
        return synth

    async def _synthesize_and_stream(self, synth: Any, text: str, _retry: int = 0) -> Any:
        """Synthesize one sentence on the reused synthesizer and stream its PCM frames.

        Returns the synthesizer to use for the NEXT sentence (a fresh one is created if we
        had to recreate it for a retry or voice fallback). Never raises.
        """
        speechsdk = self._speechsdk
        self._synthesizer = synth
        self._synthesizing = True
        try:
            result = await self._loop.run_in_executor(
                None, lambda: synth.speak_text_async(text).get()
            )
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                audio = result.audio_data or b""
                for i in range(0, len(audio), TTS_FRAME_BYTES):
                    if self._cancel_speech.is_set():
                        break
                    await self._send_bytes(audio[i : i + TTS_FRAME_BYTES])
                    await asyncio.sleep(0)  # yield so cancel is processed between frames
            elif result.reason == speechsdk.ResultReason.Canceled:
                details = result.cancellation_details
                err = str(getattr(details, "error_details", details) or "")
                logger.warning("voice: TTS canceled (%s): %s", self._active_voice, err)
                err_l = err.lower()
                is_unsupported = "unsupported voice" in err_l
                # HD neural voices (…NeuralHD / DragonHD) have a LOW concurrent-request quota
                # and throttle (error 4429) under back-to-back synthesis. Retrying on the same
                # HD voice just compounds the throttle, so on either an unsupported voice OR a
                # throttle we switch to the high-concurrency standard fallback voice for the
                # REST of the session and retry on it — the agent never goes silent.
                is_throttle = (
                    "4429" in err
                    or "throttl" in err_l
                    or "concurrent request limit" in err_l
                )
                if (is_unsupported or is_throttle) and self._active_voice != SPEECH_VOICE_FALLBACK:
                    logger.info(
                        "voice: switching to fallback voice %s (%s)",
                        SPEECH_VOICE_FALLBACK,
                        "unsupported" if is_unsupported else "throttled",
                    )
                    self._active_voice = SPEECH_VOICE_FALLBACK
                    self._speech_config.speech_synthesis_voice_name = SPEECH_VOICE_FALLBACK
                    await asyncio.sleep(0.15)
                    return await self._synthesize_and_stream(self._make_synthesizer(), text)
                # Other transient cancel (a connection blip): retry up to twice with backoff.
                if _retry < 2 and not self._cancel_speech.is_set():
                    await asyncio.sleep(0.3 * (_retry + 1))
                    return await self._synthesize_and_stream(self._make_synthesizer(), text, _retry + 1)
        except Exception:  # noqa: BLE001 - speech failure must not kill the connection
            logger.exception("voice: synthesis failed")
        finally:
            import time  # noqa: PLC0415

            self._synthesizing = False
            self._last_speech_ts = time.monotonic()
        return synth

    # --- spoken progress narration -------------------------------------------------
    async def _progress_loop(self, state: dict) -> None:
        """Narrate the agent's work to fill genuine silence during a turn.

        Speaks a quick acknowledgement first (PROGRESS_FIRST_MS), then repeats a calmer,
        keyword-aware bridge every PROGRESS_INTERVAL_MS — but ONLY when there is a true gap
        (queue empty + not mid-synthesis), so real prose is never delayed or talked over.
        Each phrase is also mirrored to the browser as {"type":"progress"} for the HUD.
        """
        import time  # noqa: PLC0415

        try:
            while not state["done"]:
                await asyncio.sleep(0.35)
                if state["done"] or self._cancel_speech.is_set():
                    break
                if not self._tts_queue.empty() or self._synthesizing:
                    continue  # something is already being / about to be spoken
                needed_ms = PROGRESS_FIRST_MS if state["emitted"] == 0 else PROGRESS_INTERVAL_MS
                if (time.monotonic() - self._last_speech_ts) * 1000.0 < needed_ms:
                    continue
                phrase = self._next_progress_phrase(state)
                state["emitted"] += 1
                self._last_speech_ts = time.monotonic()
                # Mirror to the in-canvas HUD, then speak it.
                await self._send_text({"type": "progress", "text": phrase})
                await self._tts_queue.put(phrase)
        except asyncio.CancelledError:
            return

    def _next_progress_phrase(self, state: dict) -> str:
        if state["emitted"] == 0:
            pool = PROGRESS_OPENERS
        elif state.get("kw"):
            pool = tuple(p.format(kw=state["kw"]) for p in PROGRESS_WORKING_KW)
        else:
            pool = PROGRESS_WORKING_GENERIC
        self._progress_idx = (self._progress_idx + 1) % len(pool)
        return pool[self._progress_idx]

    async def _barge_in(self) -> None:
        # Cancel any in-flight speech and drop everything still queued to be spoken.
        self._cancel_speech.set()
        try:
            while True:
                self._tts_queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        synth = self._synthesizer
        if synth is not None:
            try:
                await self._loop.run_in_executor(None, lambda: synth.stop_speaking_async().get())
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        await self._barge_in()
        # Release the TTS worker if it's still waiting on the queue.
        if self._tts_worker_task is not None and not self._tts_worker_task.done():
            await self._finish_tts_worker()
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
