// Real-time VOICE client for the Babylon 3D agent (push-to-talk).
//
// This module is the browser half of the Foundry-native `invocations_ws` voice path. It
// captures the microphone while the user holds a talk control (the `V` key on the
// keyboard, or the VR right-controller B button — see editmode.js), streams 16 kHz PCM
// to the chat backend's /api/voice relay, and plays back the agent's spoken reply.
//
// It deliberately knows NOTHING about how chat messages are rendered or how Babylon code
// is executed: it just forwards control/agent events to the callbacks supplied by app.js
// (which runs the SAME pipeline used for typed turns). The "never speak the code" rule is
// enforced server-side (the container strips fenced blocks before text-to-speech), so the
// returned JavaScript still reaches the canvas via the {type:"done"} event while only the
// prose is ever synthesized to audio.
//
// Frame protocol (mirrors voice_pipeline.py):
//   send  text:   {"type":"start"} | {"type":"commit"} | {"type":"cancel"}
//   send  binary: 16 kHz / 16-bit / mono PCM frames (while talking)
//   recv  text:   {"type":"stt"|"tool"|"delta"|"done"|"error"|"speaking_start"|"speaking_end"}
//   recv  binary: 16 kHz / 16-bit / mono PCM frames (spoken prose)
//
// Public API (global `VoiceControl`):
//   init({ sessionId, getTarget, onUserTranscript, onAgentEvent, onStateChange, onStatus })
//   isSupported()           — Web Audio + getUserMedia + WebSocket available.
//   isEnabled() / setEnabled(bool) / toggle()  — master "voice mode" on/off.
//   startListening()        — push-to-talk DOWN (auto-enables voice mode).
//   stopAndSend()           — push-to-talk UP (commit the utterance).
//   isListening() / isBusy()
window.VoiceControl = (function () {
  "use strict";

  const SAMPLE_RATE = 24000; // STT input + TTS output rate (must match the server).

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  let cfg = {
    sessionId: "default",
    getTarget: () => "local",
    onUserTranscript: () => {},
    onAgentEvent: () => {},
    onProgress: () => {},
    onStateChange: () => {},
    onStatus: () => {},
  };

  let enabled = false; // master voice-mode flag
  let listening = false; // mic actively capturing
  let awaitingReply = false; // commit sent, reply not yet finished

  let ws = null;
  let wsTarget = null; // the target the current socket was opened for
  let wsReady = false;
  const pendingFrames = []; // frames queued before the socket opens

  // Capture graph
  let captureCtx = null;
  let micStream = null;
  let sourceNode = null;
  let processorNode = null;
  let zeroGain = null;

  // Playback graph
  let playbackCtx = null;
  let playbackTime = 0; // next scheduled start time (seconds, playbackCtx clock)
  let speaking = false;

  function isSupported() {
    return Boolean(
      AudioContextClass &&
        navigator.mediaDevices &&
        navigator.mediaDevices.getUserMedia &&
        window.WebSocket
    );
  }

  function init(options) {
    cfg = Object.assign(cfg, options || {});
  }

  function emitState() {
    cfg.onStateChange({ enabled, listening, speaking, busy: awaitingReply });
  }

  // --- master enable/disable ----------------------------------------------------
  function setEnabled(value) {
    const next = Boolean(value);
    if (next === enabled) return;
    enabled = next;
    if (!enabled) {
      stopCapture();
      stopPlayback();
      closeSocket();
      awaitingReply = false;
    }
    emitState();
  }

  function toggle() {
    setEnabled(!enabled);
  }

  function isEnabled() {
    return enabled;
  }
  function isListening() {
    return listening;
  }
  function isBusy() {
    return awaitingReply;
  }

  // --- WebSocket ----------------------------------------------------------------
  function wsUrl() {
    const target = cfg.getTarget ? cfg.getTarget() : "local";
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = new URLSearchParams({
      target: target === "remote" ? "remote" : "local",
      sessionId: cfg.sessionId || "default",
    });
    return `${proto}//${location.host}/api/voice?${qs.toString()}`;
  }

  function ensureSocket() {
    const target = cfg.getTarget ? cfg.getTarget() : "local";
    // Reopen if the target changed since the socket was created.
    if (ws && wsTarget !== target) closeSocket();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    wsTarget = target;
    wsReady = false;
    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      cfg.onStatus("Voice connection failed: " + (err && err.message ? err.message : err));
      ws = null;
      return;
    }
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      wsReady = true;
      for (const f of pendingFrames.splice(0)) {
        try {
          ws.send(f);
        } catch (_) {
          /* ignore */
        }
      }
    });
    ws.addEventListener("message", onSocketMessage);
    ws.addEventListener("close", (evt) => {
      wsReady = false;
      ws = null;
      // If the agent dropped us mid-reply, surface a soft error so the UI recovers.
      if (awaitingReply) {
        awaitingReply = false;
        cfg.onAgentEvent({ type: "error", error: voiceCloseReason(evt) });
        emitState();
      }
    });
    ws.addEventListener("error", () => {
      cfg.onStatus("Voice connection error.");
    });
  }

  function voiceCloseReason(evt) {
    if (evt && evt.reason) return evt.reason;
    if (evt && evt.code === 1006) return "Voice connection lost.";
    return "Voice connection closed.";
  }

  function send(frame) {
    if (ws && wsReady && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(frame);
        return;
      } catch (_) {
        /* fall through to queue */
      }
    }
    pendingFrames.push(frame);
  }

  function sendControl(type, extra) {
    const frame = extra ? Object.assign({ type: type }, extra) : { type: type };
    send(JSON.stringify(frame));
  }

  function closeSocket() {
    pendingFrames.length = 0;
    if (ws) {
      try {
        ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    ws = null;
    wsReady = false;
  }

  function onSocketMessage(evt) {
    if (typeof evt.data === "string") {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (_) {
        return;
      }
      routeTextFrame(msg);
    } else {
      // Binary = a chunk of spoken PCM audio.
      playPcmChunk(evt.data);
    }
  }

  function routeTextFrame(msg) {
    const type = msg && msg.type;
    if (type === "stt") {
      cfg.onUserTranscript(msg.text || "");
      return;
    }
    if (type === "speaking_start") {
      speaking = true;
      emitState();
      return;
    }
    if (type === "speaking_end") {
      speaking = false;
      emitState();
      return;
    }
    if (type === "progress") {
      // Spoken progress narration: mirror the same text to the in-canvas HUD / status.
      cfg.onProgress(msg.text || "");
      return;
    }
    // tool / delta / done / error -> drive the shared chat pipeline in app.js.
    cfg.onAgentEvent(msg);
    if (type === "done" || type === "error") {
      awaitingReply = false;
      emitState();
    }
  }

  // --- microphone capture -------------------------------------------------------
  async function startListening() {
    if (!isSupported()) {
      cfg.onStatus("Voice input is not supported in this browser.");
      return;
    }
    if (!enabled) setEnabled(true); // push-to-talk auto-arms voice mode
    if (listening) return;

    // Barge-in: if the agent is currently speaking, cut it off and tell the server.
    if (speaking) {
      stopPlayback();
      sendControl("cancel");
    }

    ensureSocket();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      cfg.onStatus("Microphone access denied: " + (err && err.message ? err.message : err));
      return;
    }

    captureCtx = new AudioContextClass();
    if (captureCtx.state === "suspended") {
      try {
        await captureCtx.resume();
      } catch (_) {
        /* ignore */
      }
    }
    const inRate = captureCtx.sampleRate; // typically 48000
    sourceNode = captureCtx.createMediaStreamSource(micStream);

    // ScriptProcessorNode is deprecated but universally supported and adequate for
    // push-to-talk; it downsamples each block to 16 kHz PCM16 and ships it over the WS.
    const BUFFER = 4096;
    processorNode = captureCtx.createScriptProcessor(BUFFER, 1, 1);
    processorNode.onaudioprocess = (e) => {
      if (!listening) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = downsampleToPcm16(input, inRate, SAMPLE_RATE);
      if (pcm && pcm.byteLength) send(pcm);
    };
    // A zero-gain sink keeps the processor running without echoing the mic to the speakers.
    zeroGain = captureCtx.createGain();
    zeroGain.gain.value = 0;
    sourceNode.connect(processorNode);
    processorNode.connect(zeroGain);
    zeroGain.connect(captureCtx.destination);

    listening = true;
    sendControl("start");
    emitState();
  }

  function stopAndSend() {
    if (!listening) return;
    listening = false;
    stopCapture();
    // In default (manual) mode, carry the same silent agent note typed turns use so the
    // spoken request is built with raw world-unit coordinates (no auto-scale / framing).
    const sceneNote =
      window.SceneControls && window.SceneControls.agentNote
        ? window.SceneControls.agentNote()
        : "";
    sendControl("commit", sceneNote ? { scene_note: sceneNote } : null);
    awaitingReply = true;
    emitState();
  }

  function stopCapture() {
    if (processorNode) {
      try {
        processorNode.disconnect();
      } catch (_) {
        /* ignore */
      }
      processorNode.onaudioprocess = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    if (zeroGain) {
      try {
        zeroGain.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
    }
    if (captureCtx) {
      try {
        captureCtx.close();
      } catch (_) {
        /* ignore */
      }
    }
    processorNode = null;
    sourceNode = null;
    zeroGain = null;
    micStream = null;
    captureCtx = null;
    listening = false;
  }

  // Linear-interpolation downsample of a Float32 block to 16 kHz, then to Int16 PCM.
  function downsampleToPcm16(input, inRate, outRate) {
    if (!input || !input.length) return null;
    let floats;
    if (outRate === inRate) {
      floats = input;
    } else {
      const ratio = inRate / outRate;
      const outLen = Math.floor(input.length / ratio);
      floats = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, input.length - 1);
        const frac = pos - i0;
        floats[i] = input[i0] * (1 - frac) + input[i1] * frac;
      }
    }
    const pcm = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      let s = Math.max(-1, Math.min(1, floats[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm.buffer;
  }

  // --- playback -----------------------------------------------------------------
  function ensurePlaybackCtx() {
    if (!playbackCtx) {
      playbackCtx = new AudioContextClass();
      playbackTime = playbackCtx.currentTime;
    }
    if (playbackCtx.state === "suspended") {
      playbackCtx.resume().catch(() => {});
    }
  }

  function playPcmChunk(arrayBuffer) {
    if (!enabled) return; // voice mode off -> stay silent
    ensurePlaybackCtx();
    const pcm = new Int16Array(arrayBuffer);
    if (!pcm.length) return;
    const floats = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;

    const buffer = playbackCtx.createBuffer(1, floats.length, SAMPLE_RATE);
    buffer.copyToChannel(floats, 0);
    const src = playbackCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(playbackCtx.destination);

    const now = playbackCtx.currentTime;
    if (playbackTime < now) playbackTime = now;
    src.start(playbackTime);
    playbackTime += buffer.duration;
  }

  function stopPlayback() {
    speaking = false;
    if (playbackCtx) {
      try {
        playbackCtx.close();
      } catch (_) {
        /* ignore */
      }
      playbackCtx = null;
    }
    emitState();
  }

  return {
    init: init,
    isSupported: isSupported,
    isEnabled: isEnabled,
    setEnabled: setEnabled,
    toggle: toggle,
    startListening: startListening,
    stopAndSend: stopAndSend,
    isListening: isListening,
    isBusy: isBusy,
  };
})();
