// Thin web-chat backend.
//
// Serves the static front-end (full-screen Babylon.js canvas + chat panel) and proxies
// chat messages to the Babylon3DAgent hosted agent via its OpenAI Responses API.
//
// This server is intentionally UNAWARE of any code-validation logic: validation happens
// inside the agent (which may call the Node.js NullEngine tool). The web client only
// sends a prompt and receives the agent's text reply, from which the browser extracts
// and runs the ```javascript code block.
//
// Env:
//   PORT                   web server port (default 3000)
//   LOCAL_AGENT_ENDPOINT   local agent Responses API URL
//                          (default http://localhost:8088/responses; AGENT_ENDPOINT is
//                          accepted as a legacy alias)
//   REMOTE_AGENT_PROJECT_ENDPOINT  Foundry project endpoint, shape:
//                          https://<resource>.services.ai.azure.com/api/projects/<project>
//                          (falls back to PROJECT_ENDPOINT, shared with the Python agent)
//   REMOTE_AGENT_NAME      deployed hosted agent name (from agent.yaml, e.g. verbalreality)
//   REMOTE_AGENT_API_VERSION  data-plane api-version (default 2025-11-15-preview)
//   REMOTE_AGENT_ENDPOINT  optional explicit override of the full Responses URL. When set,
//                          it wins over the project-endpoint + name composition above.
//                          When the remote target is configured, the backend attaches an
//                          Azure AD bearer token to upstream requests.
//   REMOTE_AGENT_SCOPE     token scope for the remote agent
//                          (default https://ai.azure.com/.default)
//   AGENT_MODEL            model field sent in the request (default gpt-4.1)

const path = require("path");
const express = require("express");
const { DefaultAzureCredential } = require("@azure/identity");
const WebSocket = require("ws");
const { URL } = require("url");

// Load the repo-root .env (shared with the Python agent) so values like
// REMOTE_AGENT_ENDPOINT are picked up. Existing process env vars win over the file.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const PORT = process.env.PORT || 3000;
const LOCAL_AGENT_ENDPOINT =
  process.env.LOCAL_AGENT_ENDPOINT ||
  process.env.AGENT_ENDPOINT ||
  "http://localhost:8088/responses";

// Remote (Foundry hosted) agent: prefer specifying the project endpoint + agent name and
// let us compose the Responses URL, rather than hand-building the long data-plane URL.
// REMOTE_AGENT_ENDPOINT (a full Responses URL) is still honored as an explicit override.
const REMOTE_AGENT_PROJECT_ENDPOINT = (
  process.env.REMOTE_AGENT_PROJECT_ENDPOINT ||
  process.env.PROJECT_ENDPOINT ||
  ""
)
  .trim()
  .replace(/\/+$/, "");
const REMOTE_AGENT_NAME = (process.env.REMOTE_AGENT_NAME || "").trim();
const REMOTE_AGENT_API_VERSION = (
  process.env.REMOTE_AGENT_API_VERSION || "2025-11-15-preview"
).trim();

// Build the hosted-agent Responses URL from its parts:
//   <project-endpoint>/agents/<name>/endpoint/protocols/openai/responses?api-version=<ver>
function buildRemoteResponsesUrl(projectEndpoint, agentName, apiVersion) {
  if (!projectEndpoint || !agentName) return "";
  return (
    `${projectEndpoint}/agents/${encodeURIComponent(agentName)}` +
    `/endpoint/protocols/openai/responses?api-version=${encodeURIComponent(apiVersion)}`
  );
}

const REMOTE_AGENT_ENDPOINT = (
  process.env.REMOTE_AGENT_ENDPOINT ||
  buildRemoteResponsesUrl(
    REMOTE_AGENT_PROJECT_ENDPOINT,
    REMOTE_AGENT_NAME,
    REMOTE_AGENT_API_VERSION
  )
).trim();
const REMOTE_AGENT_SCOPE =
  process.env.REMOTE_AGENT_SCOPE || "https://ai.azure.com/.default";
const AGENT_MODEL = process.env.AGENT_MODEL || "gpt-4.1";

// --- Voice (real-time invocations_ws relay) ---------------------------------------
// The browser cannot set an Authorization header on a WebSocket upgrade, so the chat
// backend relays the browser's voice socket to the upstream voice endpoint, injecting
// the bearer token for the remote (Foundry) target. For the local agent the voice
// WebSocket is reached directly (no auth).
//   LOCAL_VOICE_WS_URL   local agent voice socket (default ws://localhost:8089/invocations_ws)
//   VOICE_FOUNDRY_FEATURES  preview gate for the hosted-agent invocations_ws protocol
const LOCAL_VOICE_WS_URL =
  process.env.LOCAL_VOICE_WS_URL || "ws://localhost:8089/invocations_ws";
const VOICE_FOUNDRY_FEATURES =
  process.env.VOICE_FOUNDRY_FEATURES || "HostedAgents=V1Preview";

// Build the remote (Foundry hosted) voice WebSocket URL from the project endpoint:
//   wss://<account>/api/projects/agents/endpoint/protocols/invocations_ws
//        ?project_name=<project>&agent_name=<name>&agent_session_id=<sid>
//        &foundry_features=HostedAgents=V1Preview
// invocations_ws is preview + currently North Central US only.
function buildRemoteVoiceWsUrl(sessionId) {
  if (!REMOTE_AGENT_PROJECT_ENDPOINT || !REMOTE_AGENT_NAME) return "";
  let parsed;
  try {
    parsed = new URL(REMOTE_AGENT_PROJECT_ENDPOINT);
  } catch (_) {
    return "";
  }
  const project = parsed.pathname.replace(/\/+$/, "").split("/").pop() || "";
  const sid = sessionId || "default";
  const qs = new URLSearchParams({
    project_name: project,
    agent_name: REMOTE_AGENT_NAME,
    agent_session_id: sid,
    foundry_features: VOICE_FOUNDRY_FEATURES,
  });
  return `wss://${parsed.host}/api/projects/agents/endpoint/protocols/invocations_ws?${qs.toString()}`;
}

function voiceAvailableForTarget(target) {
  return target === "remote"
    ? Boolean(REMOTE_AGENT_PROJECT_ENDPOINT && REMOTE_AGENT_NAME)
    : Boolean(LOCAL_VOICE_WS_URL);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Resolve the upstream agent endpoint for a request target ("local" | "remote").
function endpointForTarget(target) {
  return target === "remote" ? REMOTE_AGENT_ENDPOINT : LOCAL_AGENT_ENDPOINT;
}

// ---------------------------------------------------------------------------
// Remote (Foundry hosted) agent auth — mint and cache an Azure AD bearer token
// via DefaultAzureCredential (same auth the Python agent uses). The credential is
// created lazily so local-only usage never touches Azure identity.
// ---------------------------------------------------------------------------
let credential = null;
let cachedToken = null; // { token, expiresOnTimestamp }

async function getRemoteAuthHeader() {
  if (!credential) credential = new DefaultAzureCredential();
  const now = Date.now();
  // Refresh ~5 minutes before expiry to avoid using a token that lapses mid-request.
  if (
    !cachedToken ||
    !cachedToken.expiresOnTimestamp ||
    cachedToken.expiresOnTimestamp - now < 5 * 60 * 1000
  ) {
    const result = await credential.getToken(REMOTE_AGENT_SCOPE);
    if (!result || !result.token) {
      throw new Error("DefaultAzureCredential returned no token.");
    }
    cachedToken = {
      token: result.token,
      expiresOnTimestamp: result.expiresOnTimestamp,
    };
  }
  return `Bearer ${cachedToken.token}`;
}

// In-memory map of `${sessionId}::${target}` -> last response id, to preserve
// conversation context (so the cumulative 3D scene history is kept on the agent side).
// Local and remote agents keep SEPARATE threads: a previous_response_id from one is not
// valid for the other, so the target is part of the key.
const sessions = new Map();

function sessionKey(sessionId, target) {
  return `${sessionId}::${target === "remote" ? "remote" : "local"}`;
}

// Per-session promise chain so two `/api/chat` calls for the same session+target never
// run concurrently. Without this, a follow-up (e.g. a silent "model loaded" note fired
// the instant a gallery thumbnail is clicked) can be sent while the previous turn is
// still streaming — chaining off a `previous_response_id` Foundry hasn't persisted yet,
// which returns a transient 404. Serializing guarantees we only ever chain off a
// completed, committed response.
const sessionChains = new Map();

function serialize(sKey, task) {
  const prev = sessionChains.get(sKey) || Promise.resolve();
  const result = prev.then(() => task());
  // Advance the chain regardless of whether this task succeeds or fails.
  const chain = result.then(
    () => {},
    () => {}
  );
  sessionChains.set(sKey, chain);
  // Drop the entry once this is the last task in the chain, to avoid unbounded growth.
  chain.then(() => {
    if (sessionChains.get(sKey) === chain) sessionChains.delete(sKey);
  });
  return result;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// True when an upstream 404 is specifically about the chained previous_response_id not
// being found (Foundry hasn't finished persisting it yet) — the recoverable case.
function isMissingPreviousResponse(status, raw, previousResponseId) {
  if (status !== 404 || !previousResponseId) return false;
  return /not[_ ]?found/i.test(raw || "");
}

// Extract plain text from an OpenAI Responses API payload across known shapes.
function extractText(payload) {
  if (!payload) return "";
  if (typeof payload.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }
  const parts = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (!c) continue;
      if (typeof c.text === "string") parts.push(c.text);
      else if (c.text && typeof c.text.value === "string") parts.push(c.text.value);
    }
  }
  return parts.join("\n").trim();
}

// Write one Server-Sent Event (a single JSON object) to the browser.
function sendEvent(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// Dispatch one parsed upstream Responses-API event to our simplified browser protocol.
// Returns the reply text if this event completed the response, otherwise null.
function handleUpstreamEvent(evt, res, sKey, state) {
  if (!evt || typeof evt !== "object") return null;
  const type = evt.type || "";

  // Track the response id as it appears, but DON'T commit it to the session yet: a
  // follow-up that chains off an id Foundry hasn't finished persisting gets a transient
  // 404. We only commit once the response is finalized (see response.completed below).
  if (evt.response && evt.response.id) state.responseId = evt.response.id;

  if (type.endsWith("output_text.delta") && typeof evt.delta === "string") {
    state.text += evt.delta;
    sendEvent(res, { type: "delta", text: evt.delta });
    return null;
  }

  if (type === "response.output_item.done") {
    const item = evt.item;
    if (item && item.type === "function_call" && item.name) {
      // Emit the tool indicator ONLY when the function_call item is complete. That is the
      // moment the host actually invokes the tool (the validator is pinged). The matching
      // "response.output_item.added" fires earlier, while the model is still writing the
      // code — surfacing it would show "Validating…" prematurely and make a single
      // validation look like a retry. The Set guards against any duplicate "done" event.
      const itemKey = item.id || item.call_id || item.name;
      if (!state.seenToolItems.has(itemKey)) {
        state.seenToolItems.add(itemKey);
        sendEvent(res, { type: "tool", name: item.name });
      }
    }
    return null;
  }

  if (type === "response.completed" || type === "response.incomplete") {
    // The response is now persisted on Foundry's side, so it's safe to chain the next
    // turn off it. Commit the id captured during streaming.
    if (state.responseId) sessions.set(sKey, state.responseId);
    const reply = (evt.response && extractText(evt.response)) || state.text || "";
    return reply;
  }

  if (type === "response.failed" || type === "error") {
    const error =
      (evt.response && evt.response.error && evt.response.error.message) ||
      evt.message ||
      "Agent reported a failure.";
    sendEvent(res, { type: "error", error });
    state.errored = true;
    return null;
  }

  return null;
}

app.post("/api/chat", async (req, res) => {
  const message = req.body && req.body.message;
  const sessionId = (req.body && req.body.sessionId) || "default";
  const target = req.body && req.body.target === "remote" ? "remote" : "local";
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Empty message." });
  }

  const endpoint = endpointForTarget(target);
  if (!endpoint) {
    return res.status(400).json({
      error:
        "Remote agent is not configured. Set REMOTE_AGENT_PROJECT_ENDPOINT (or PROJECT_ENDPOINT) and REMOTE_AGENT_NAME to use the deployed Foundry agent.",
    });
  }

  // Respond as a Server-Sent Events stream so the browser can render live activity
  // (tool calls, progress) while the agent works.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sKey = sessionKey(sessionId, target);

  // Serialize turns for this session so a follow-up never chains off an in-flight,
  // not-yet-persisted previous_response_id (the cause of transient Foundry 404s).
  return serialize(sKey, () =>
    runChatTurn({ res, endpoint, target, sKey, message })
  );
});

// Issue one POST /responses to the upstream agent, retrying when the chained
// previous_response_id is briefly missing on Foundry's side, then stream the SSE
// response back to the browser. Resolves when the turn is fully handled (res.end called).
async function runChatTurn({ res, endpoint, target, sKey, message }) {
  const state = { text: "", errored: false, seenToolItems: new Set(), responseId: null };

  let headers;
  try {
    headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    // The deployed Foundry hosted agent requires an Azure AD bearer token; the local
    // agent needs none.
    if (target === "remote") {
      headers.Authorization = await getRemoteAuthHeader();
    }
  } catch (authErr) {
    sendEvent(res, {
      type: "error",
      error: `Could not authenticate to the remote agent: ${
        authErr.message || authErr
      }. Run 'az login' or check REMOTE_AGENT_SCOPE.`,
    });
    return res.end();
  }

  // Backoff schedule (ms) for retrying the SAME chained id when Foundry returns a
  // transient "previous response not found" 404. After these, we retry once WITHOUT the
  // chain so the user still gets a reply instead of an error bubble.
  const RETRY_BACKOFFS = [400, 800];
  let previousResponseId = sessions.get(sKey);

  let upstream;
  try {
    for (let attempt = 0; ; attempt++) {
      const body = { model: AGENT_MODEL, input: message, stream: true };
      if (previousResponseId) body.previous_response_id = previousResponseId;

      upstream = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (upstream.ok) break;

      const raw = await upstream.text();
      if (isMissingPreviousResponse(upstream.status, raw, previousResponseId)) {
        if (attempt < RETRY_BACKOFFS.length) {
          await delay(RETRY_BACKOFFS[attempt]);
          continue; // retry with the same previous_response_id
        }
        // Still not found after backing off: drop the chain and try once more fresh.
        previousResponseId = null;
        continue;
      }

      // Non-recoverable upstream error.
      sendEvent(res, {
        type: "error",
        error: `Agent error (${upstream.status}): ${raw}`,
      });
      return res.end();
    }
  } catch (err) {
    sendEvent(res, {
      type: "error",
      error: `Could not reach agent: ${err.message || err}`,
    });
    return res.end();
  }

  try {
    const contentType = upstream.headers.get("content-type") || "";

    // Fallback: the agent answered with a single JSON payload instead of a stream.
    if (!contentType.includes("text/event-stream") || !upstream.body) {
      const raw = await upstream.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (_) {
        sendEvent(res, { type: "error", error: `Invalid agent response: ${raw}` });
        return res.end();
      }
      if (payload.id) sessions.set(sKey, payload.id);
      sendEvent(res, { type: "done", reply: extractText(payload) });
      return res.end();
    }

    // Parse the upstream SSE stream and re-emit our simplified events.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let reply = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim());
        if (!dataLines.length) continue;

        const data = dataLines.join("\n");
        if (data === "[DONE]") continue;

        let evt;
        try {
          evt = JSON.parse(data);
        } catch (_) {
          continue;
        }
        const maybeReply = handleUpstreamEvent(evt, res, sKey, state);
        if (maybeReply !== null) reply = maybeReply;
      }
    }

    if (!state.errored) {
      sendEvent(res, { type: "done", reply: reply != null ? reply : state.text });
    }
    return res.end();
  } catch (err) {
    sendEvent(res, {
      type: "error",
      error: `Could not reach agent: ${err.message || err}`,
    });
    return res.end();
  }
}


// Tell the front-end which targets are available so it can enable/disable the switch.
app.get("/api/config", (req, res) => {
  res.json({
    localConfigured: Boolean(LOCAL_AGENT_ENDPOINT),
    remoteConfigured: Boolean(REMOTE_AGENT_ENDPOINT),
    voiceLocalAvailable: voiceAvailableForTarget("local"),
    voiceRemoteAvailable: voiceAvailableForTarget("remote"),
  });
});

// Reset clears the conversation context for BOTH targets of this session. The browser
// clears its own canvas.
app.post("/api/reset", (req, res) => {
  const sessionId = (req.body && req.body.sessionId) || "default";
  sessions.delete(sessionKey(sessionId, "local"));
  sessions.delete(sessionKey(sessionId, "remote"));
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`Web chat on http://localhost:${PORT}`);
  console.log(`  local  agent -> ${LOCAL_AGENT_ENDPOINT}`);
  console.log(
    `  remote agent -> ${REMOTE_AGENT_ENDPOINT || "(not configured)"}`
  );
});

// ---------------------------------------------------------------------------
// Voice WebSocket relay: browser <-> this backend <-> upstream invocations_ws.
// The browser opens ws://<webchat>/api/voice?target=local|remote&sessionId=<id>. We
// open the matching upstream voice socket (adding the Foundry bearer token for the
// remote target) and pipe text + binary frames in both directions. The Azure token
// stays server-side; the browser never handles credentials.
// ---------------------------------------------------------------------------
const voiceWss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
  } catch (_) {
    pathname = "";
  }
  if (pathname !== "/api/voice") {
    socket.destroy();
    return;
  }
  voiceWss.handleUpgrade(req, socket, head, (client) => {
    voiceWss.emit("connection", client, req);
  });
});

voiceWss.on("connection", async (client, req) => {
  let target = "local";
  let sessionId = "default";
  try {
    const q = new URL(req.url, `http://${req.headers.host}`).searchParams;
    target = q.get("target") === "remote" ? "remote" : "local";
    sessionId = q.get("sessionId") || "default";
  } catch (_) {
    /* keep defaults */
  }

  if (!voiceAvailableForTarget(target)) {
    safeCloseVoice(client, 1011, `Voice is not configured for the ${target} agent.`);
    return;
  }

  let upstreamUrl = "";
  const upstreamOptions = {};
  try {
    if (target === "remote") {
      upstreamUrl = buildRemoteVoiceWsUrl(sessionId);
      const auth = await getRemoteAuthHeader();
      upstreamOptions.headers = {
        Authorization: auth,
        "Foundry-Features": VOICE_FOUNDRY_FEATURES,
      };
    } else {
      upstreamUrl = LOCAL_VOICE_WS_URL;
    }
  } catch (authErr) {
    safeCloseVoice(
      client,
      1011,
      `Could not authenticate voice to the remote agent: ${authErr.message || authErr}`
    );
    return;
  }

  if (!upstreamUrl) {
    safeCloseVoice(client, 1011, "Could not resolve the upstream voice endpoint.");
    return;
  }

  const upstream = new WebSocket(upstreamUrl, upstreamOptions);
  // Buffer browser frames that arrive before the upstream socket is open.
  const pending = [];
  let upstreamOpen = false;

  // Shared conversation key: voice and typed turns chain on the SAME previous_response_id
  // (stored in `sessions`), so they form one cumulative conversation. The relay injects the
  // current id before each voice turn and captures the new id from the "done" frame.
  const sKey = sessionKey(sessionId, target);

  const sendUpstream = (frame) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(frame);
    else pending.push(frame);
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const frame of pending.splice(0)) upstream.send(frame);
  });
  upstream.on("message", (data, isBinary) => {
    // Capture the new response id from the container's "done" frame so the NEXT turn
    // (voice OR typed) continues the same conversation.
    if (!isBinary) {
      try {
        const evt = JSON.parse(data.toString());
        if (evt && evt.type === "done" && evt.response_id) {
          sessions.set(sKey, evt.response_id);
        }
      } catch (_) {
        /* not JSON; ignore */
      }
    }
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });
  upstream.on("close", (code, reason) => safeCloseVoice(client, normalizeWsCode(code), reason));
  upstream.on("error", (err) => {
    console.error("voice upstream error:", err && err.message ? err.message : err);
    safeCloseVoice(client, 1011, "Voice upstream error.");
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      sendUpstream(data);
      return;
    }
    const text = data.toString();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      /* not JSON */
    }
    // Before a turn runs, hand the container the shared previous_response_id so the voice
    // turn chains onto whatever the typed chat (or a prior voice turn) last produced.
    if (parsed && parsed.type === "commit") {
      const prev = sessions.get(sKey) || null;
      sendUpstream(JSON.stringify({ type: "context", previous_response_id: prev }));
    }
    sendUpstream(text);
  });
  client.on("close", () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
  client.on("error", () => {
    try {
      upstream.close();
    } catch (_) {
      /* ignore */
    }
  });
});

// Close codes outside the valid application range (or absent) are normalized so the
// browser doesn't receive an invalid frame.
function normalizeWsCode(code) {
  return typeof code === "number" && code >= 1000 && code <= 4999 ? code : 1011;
}

function safeCloseVoice(client, code, reason) {
  try {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(normalizeWsCode(code), typeof reason === "string" ? reason.slice(0, 120) : undefined);
    }
  } catch (_) {
    /* ignore */
  }
}
