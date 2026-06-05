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
//   PORT            web server port (default 3000)
//   AGENT_ENDPOINT  agent Responses API URL (default http://localhost:8088/responses)
//   AGENT_MODEL     model field sent in the request (default gpt-4.1)

const path = require("path");
const express = require("express");

const PORT = process.env.PORT || 3000;
const AGENT_ENDPOINT =
  process.env.AGENT_ENDPOINT || "http://localhost:8088/responses";
const AGENT_MODEL = process.env.AGENT_MODEL || "gpt-4.1";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// In-memory map of sessionId -> last response id, to preserve conversation context
// (so the cumulative 3D scene history is kept on the agent side).
const sessions = new Map();

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
function handleUpstreamEvent(evt, res, sessionId, state) {
  if (!evt || typeof evt !== "object") return null;
  const type = evt.type || "";

  // Capture the response id as early as possible for multi-turn continuity.
  if (evt.response && evt.response.id) sessions.set(sessionId, evt.response.id);

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
  if (typeof message !== "string" || message.trim() === "") {
    return res.status(400).json({ error: "Empty message." });
  }

  // Respond as a Server-Sent Events stream so the browser can render live activity
  // (tool calls, progress) while the agent works.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const body = {
    model: AGENT_MODEL,
    input: message,
    stream: true,
  };
  const previousResponseId = sessions.get(sessionId);
  if (previousResponseId) body.previous_response_id = previousResponseId;

  const state = { text: "", errored: false, seenToolItems: new Set() };

  try {
    const upstream = await fetch(AGENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });

    if (!upstream.ok) {
      const raw = await upstream.text();
      sendEvent(res, {
        type: "error",
        error: `Agent error (${upstream.status}): ${raw}`,
      });
      return res.end();
    }

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
      if (payload.id) sessions.set(sessionId, payload.id);
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
        const maybeReply = handleUpstreamEvent(evt, res, sessionId, state);
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
});

// Reset only clears the local conversation context. The browser clears its own canvas.
app.post("/api/reset", (req, res) => {
  const sessionId = (req.body && req.body.sessionId) || "default";
  sessions.delete(sessionId);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Web chat on http://localhost:${PORT}  ->  agent ${AGENT_ENDPOINT}`);
});
