// Front-end: sets up the Babylon.js scene, talks to the chat backend, and executes the
// Babylon.js code blocks the agent returns inside the live canvas.

(() => {
  "use strict";

  const sessionId =
    "s_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // ---------------------------------------------------------------------------
  // Babylon.js scene setup — these bindings (scene/engine/camera/BABYLON) mirror
  // what the agent's validation sandbox exposes, so validated code runs here too.
  // ---------------------------------------------------------------------------
  const canvas = document.getElementById("renderCanvas");
  let engine, scene, camera;

  function buildScene() {
    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.043, 0.063, 0.125, 1);

    camera = new BABYLON.ArcRotateCamera(
      "camera",
      -Math.PI / 2,
      Math.PI / 2.5,
      10,
      BABYLON.Vector3.Zero(),
      scene
    );
    camera.attachControl(canvas, true);
    camera.wheelPrecision = 30;

    new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);

    // Bind the in-canvas activity indicators to the (re)built scene.
    if (window.ActivityIndicators) {
      window.ActivityIndicators.attach(scene, camera);
    }
    return scene;
  }

  engine = new BABYLON.Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  buildScene();

  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // ---------------------------------------------------------------------------
  // Resizable chat panel — drag the divider on the chat's left border.
  // ---------------------------------------------------------------------------
  const appEl = document.getElementById("app");
  const resizer = document.getElementById("chat-resizer");

  if (resizer && appEl) {
    const MIN_CHAT = 280; // px
    const minCanvas = 320; // keep the canvas usable

    let dragging = false;

    const applyWidth = (px) => {
      const maxChat = window.innerWidth - minCanvas - resizer.offsetWidth;
      const width = Math.max(MIN_CHAT, Math.min(px, maxChat));
      appEl.style.setProperty("--chat-width", width + "px");
      engine.resize();
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      // Chat width = distance from the pointer to the right edge of the window.
      applyWidth(window.innerWidth - e.clientX);
    };

    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("dragging");
      document.body.classList.remove("resizing");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      resizer.classList.add("dragging");
      document.body.classList.add("resizing");
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    // Keep the chat width within bounds when the window itself is resized.
    window.addEventListener("resize", () => {
      const current = parseFloat(getComputedStyle(document.getElementById("chat-pane")).width);
      if (!Number.isNaN(current)) applyWidth(current);
    });
  }

  function resetScene() {
    scene.dispose();
    buildScene();
  }

  // Execute one Babylon.js snippet against the live scene. Errors are caught so a bad
  // snippet never breaks the render loop or the page.
  function executeCode(code) {
    try {
      const runner = new Function("BABYLON", "scene", "engine", "camera", code);
      runner(BABYLON, scene, engine, camera);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  // Extract ```javascript / ```js fenced code blocks (falls back to any fenced block).
  function extractCodeBlocks(text) {
    const blocks = [];
    const re = /```(?:javascript|js)?\s*\n([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const code = m[1].trim();
      if (code) blocks.push(code);
    }
    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Chat UI
  // ---------------------------------------------------------------------------
  const messagesEl = document.getElementById("messages");
  const form = document.getElementById("chat-form");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const statusDot = document.getElementById("status-dot");

  function setStatus(state) {
    statusDot.className = state || "";
  }

  // (Re)fill a message element's content: prose plus any extracted code blocks.
  function fillMessage(el, text, codeBlocks) {
    el.textContent = "";
    if (codeBlocks && codeBlocks.length) {
      const prose = text.replace(/```(?:javascript|js)?\s*\n[\s\S]*?```/gi, "").trim();
      if (prose) {
        const p = document.createElement("div");
        p.textContent = prose;
        el.appendChild(p);
      }
      for (const code of codeBlocks) {
        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = code;
        pre.appendChild(codeEl);
        el.appendChild(pre);
      }
    } else {
      el.textContent = text;
    }
  }

  let activityEl = null;

  // Live activity pill (matches the Blender agent UX): a single pulsing badge that
  // shows the agent's current step and is replaced/removed as the turn progresses.
  function setActivity(text) {
    if (!activityEl) {
      activityEl = document.createElement("div");
      activityEl.className = "activity-pill";
      const sp = document.createElement("span");
      sp.className = "spinner";
      const tx = document.createElement("span");
      tx.className = "activity-text";
      activityEl.appendChild(sp);
      activityEl.appendChild(tx);
    }
    activityEl.querySelector(".activity-text").textContent = text;
    messagesEl.appendChild(activityEl); // always keep it at the bottom
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function clearActivity() {
    if (activityEl && activityEl.parentNode) activityEl.parentNode.removeChild(activityEl);
    activityEl = null;
  }

  // The agent validates each snippet and fixes-and-retries up to this many times
  // (see VALIDATION_INSTRUCTIONS in agent.py).
  const MAX_VALIDATION_ATTEMPTS = 3;

  const TOOL_LABELS = {
    validate_babylon_code: "Validating the Babylon.js code…",
  };
  function friendlyTool(name, attempt) {
    const base = TOOL_LABELS[name] || "Calling " + (name || "a tool") + "…";
    // On the first attempt show the plain label; from the second one onward make it
    // clear this is a retry and how many attempts have been made.
    if (attempt && attempt > 1) {
      return base + " (attempt " + attempt + " of " + MAX_VALIDATION_ATTEMPTS + ")";
    }
    return base;
  }

  function addMessage(role, text, { codeBlocks } = {}) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    fillMessage(el, text, codeBlocks);
    messagesEl.appendChild(el);
    // Keep the live activity pill pinned below the latest message.
    if (activityEl && activityEl.parentNode === messagesEl) {
      messagesEl.appendChild(activityEl);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  async function sendMessage(message) {
    addMessage("user", message);
    setStatus("busy");
    sendBtn.disabled = true;
    if (window.ActivityIndicators) window.ActivityIndicators.start(message);
    setActivity("\uD83E\uDDE0 Generating the Babylon.js code…");

    let reply = "";
    let errored = false;
    let agentEl = null;
    // Per-turn count of validate_babylon_code calls, so retries can be surfaced.
    const toolAttempts = Object.create(null);

    try {
      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message, sessionId }),
      });

      if (!resp.ok || !resp.body) {
        let errText = "Agent request failed.";
        try {
          const d = await resp.json();
          errText = d.error || errText;
        } catch (_) {
          /* keep default */
        }
        addMessage("error", errText);
        setStatus("error");
        return;
      }

      // Consume the Server-Sent Events stream: tool calls drive in-canvas indicators,
      // text deltas accumulate the reply, and a final "done" carries the full reply.
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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

          let evt;
          try {
            evt = JSON.parse(dataLines.join("\n"));
          } catch (_) {
            continue;
          }

          if (evt.type === "tool") {
            const attempt = (toolAttempts[evt.name] = (toolAttempts[evt.name] || 0) + 1);
            setActivity("\uD83D\uDD27 " + friendlyTool(evt.name, attempt));
            if (window.ActivityIndicators) window.ActivityIndicators.notifyTool(evt.name, attempt);
          } else if (evt.type === "delta") {
            reply += evt.text || "";
            setActivity("\u270D\uFE0F Writing the Babylon.js scene…");
            // Stream the agent's text live into the chat window.
            if (!agentEl) agentEl = addMessage("agent", reply);
            else {
              fillMessage(agentEl, reply);
              messagesEl.scrollTop = messagesEl.scrollHeight;
            }
          } else if (evt.type === "done") {
            if (typeof evt.reply === "string" && evt.reply) reply = evt.reply;
          } else if (evt.type === "error") {
            addMessage("error", evt.error || "Agent error.");
            setStatus("error");
            errored = true;
          }
        }
      }

      if (errored) return;

      reply = reply || "(no reply)";
      const codeBlocks = extractCodeBlocks(reply);

      // Clear the indicators before running generated code so the canvas is clean.
      if (window.ActivityIndicators) window.ActivityIndicators.stop();

      // Finalize the streamed bubble (separating prose from code), or add a fresh one
      // if the agent returned everything in a single non-streamed payload.
      if (agentEl) fillMessage(agentEl, reply, codeBlocks);
      else addMessage("agent", reply, { codeBlocks });
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Run each returned snippet in the live canvas.
      if (codeBlocks.length) setActivity("⚙️ Running the generated code in the canvas…");
      for (const code of codeBlocks) {
        const result = executeCode(code);
        if (!result.ok) {
          addMessage(
            "error",
            "⚠️ The returned code threw while running in the canvas: " + result.error
          );
        }
      }
      setStatus("");
    } catch (err) {
      addMessage("error", "Network error: " + ((err && err.message) || err));
      setStatus("error");
    } finally {
      clearActivity();
      if (window.ActivityIndicators) window.ActivityIndicators.stop();
      sendBtn.disabled = false;
      input.focus();
    }
  }

  async function handleReset() {
    resetScene();
    try {
      await fetch("/api/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch (_) {
      /* local reset already done; ignore network errors */
    }
    addMessage("system", "Scene and conversation reset.");
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    input.value = "";

    if (message.toLowerCase() === "/reset") {
      handleReset();
      return;
    }
    sendMessage(message);
  });

  // Enter to send, Shift+Enter for newline.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  addMessage(
    "system",
    "Ask me to build a 3D scene — e.g. “create a glossy red sphere floating above a ground plane”."
  );
  input.focus();
})();
