// Headless Babylon.js NullEngine validation service.
//
// Exposes:
//   POST /validate  { code }  -> { ok: true } | { ok: false, error: "<message>" }
//   POST /reset                -> { ok: true }   (rebuilds a fresh scene)
//   GET  /health               -> { ok: true }
//
// The scene is PERSISTENT and CUMULATIVE across /validate calls so that it mirrors the
// browser scene state: LLM code is incremental and may reference meshes created in
// previous turns by name. It is rebuilt only on /reset (or process restart).
//
// The same `scene`, `engine`, `BABYLON` and `camera` bindings exposed here mirror the
// ones the web client injects, so a snippet that validates here will run in the browser.

import express from "express";
import * as BABYLON from "@babylonjs/core";

const PORT = process.env.PORT || 8087;

// ---------------------------------------------------------------------------
// Lightweight terminal tracing (no extra dependencies).
// ---------------------------------------------------------------------------
function log(...args) {
  console.log(`[validator ${new Date().toISOString()}]`, ...args);
}

function logError(...args) {
  console.error(`[validator ${new Date().toISOString()}]`, ...args);
}

let engine;
let scene;
let camera;

function createScene() {
  // NullEngine: a headless Babylon engine with no WebGL / DOM. See
  // https://doc.babylonjs.com/setup/support/serverSide
  engine = new BABYLON.NullEngine();
  scene = new BABYLON.Scene(engine);

  // Mirror the client's default camera + light so generated code sees the same context.
  camera = new BABYLON.ArcRotateCamera(
    "camera",
    -Math.PI / 2,
    Math.PI / 2.5,
    10,
    BABYLON.Vector3.Zero(),
    scene
  );
  new BABYLON.HemisphericLight("light", new BABYLON.Vector3(0, 1, 0), scene);
}

createScene();

const app = express();
app.use(express.json({ limit: "1mb" }));

// Request tracing: log every incoming request and its outcome + duration.
app.use((req, res, next) => {
  const start = Date.now();
  log(`--> ${req.method} ${req.url}`);
  res.on("finish", () => {
    log(`<-- ${req.method} ${req.url} ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/reset", (_req, res) => {
  try {
    if (scene) scene.dispose();
    if (engine) engine.dispose();
  } catch (_) {
    /* ignore disposal errors */
  }
  createScene();
  log("reset: fresh NullEngine scene created");
  res.json({ ok: true });
});

app.post("/validate", (req, res) => {
  const code = req.body && req.body.code;
  if (typeof code !== "string" || code.trim() === "") {
    log("validate: rejected (no code provided)");
    return res.status(400).json({ ok: false, error: "No code provided." });
  }

  const preview = code.replace(/\s+/g, " ").trim().slice(0, 80);
  log(
    `validate: ${code.length} chars | "${preview}${code.length > 80 ? "\u2026" : ""}"`
  );

  try {
    // Execute the snippet with the same bindings the browser exposes.
    // `camera.attachControl` requires a DOM element and is stubbed server-side so that
    // snippets calling it do not crash validation.
    const safeCamera = camera;
    const originalAttach = safeCamera.attachControl;
    safeCamera.attachControl = function () {};

    const runner = new Function(
      "BABYLON",
      "scene",
      "engine",
      "camera",
      `"use strict";\n${code}`
    );
    runner(BABYLON, scene, engine, safeCamera);

    // Render a frame so deferred errors (materials, observers wired this turn) surface.
    scene.render();

    safeCamera.attachControl = originalAttach;

    log("validate: OK");
    return res.json({ ok: true });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logError("validate: ERROR -", message);
    return res.json({ ok: false, error: message });
  }
});

app.listen(PORT, () => {
  log(`Validator listening on http://localhost:${PORT}`);
});
