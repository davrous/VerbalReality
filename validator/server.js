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
import HavokPhysics from "@babylonjs/havok";
import { createRequire } from "module";
import { readFileSync } from "fs";
import { dirname, join } from "path";

const PORT = process.env.PORT || 8087;

// Gravity used when enabling physics. Mirrors the browser (webchat/public/app.js).
const GRAVITY = new BABYLON.Vector3(0, -9.81, 0);

// The Havok wasm instance is expensive to create, so it is initialized once and
// reused across scene rebuilds (/reset). A fresh HavokPlugin is created per scene.
let havokInstance = null;

async function initHavok() {
  if (!havokInstance) {
    // The Havok wasm loader uses `fetch()` to pull the .wasm file, which is not
    // supported for the file:// scheme under Node. Read the wasm bytes from the
    // installed package and pass them in as `wasmBinary` so no fetch is attempted.
    const require = createRequire(import.meta.url);
    const havokEntry = require.resolve("@babylonjs/havok");
    const wasmBinary = readFileSync(join(dirname(havokEntry), "HavokPhysics.wasm"));
    havokInstance = await HavokPhysics({ wasmBinary });
    log("Havok physics engine initialized");
  }
  return havokInstance;
}

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

  // Pre-enable Havok physics so snippets that add PhysicsAggregate / PhysicsBody
  // validate, mirroring the browser scene (webchat/public/app.js). initHavok()
  // must have run already (it is awaited on startup and in /reset).
  if (havokInstance && !scene.getPhysicsEngine()) {
    scene.enablePhysics(GRAVITY, new BABYLON.HavokPlugin(true, havokInstance));
  }
}

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

// Register a mesh that was loaded into the BROWSER scene outside of validated code
// (e.g. when the user clicks a gallery thumbnail, the web client imports the GLB
// client-side and never sends that code here). Without this, the cumulative validation
// scene has no such mesh, so a later snippet that references it by name fails with
// `Mesh "<name>" not found` even though the model is visible in the browser.
//
// We create a lightweight empty stub mesh with the given name — no glTF fetch needed.
// `scene.getMeshByName(name)` / `scene.getNodeByName(name)` then resolve it, which is
// all the validator needs to let animation/transform snippets validate. Idempotent.
app.post("/register-mesh", (req, res) => {
  const name = req.body && req.body.name;
  if (typeof name !== "string" || name.trim() === "") {
    log("register-mesh: rejected (no name provided)");
    return res.status(400).json({ ok: false, error: "No mesh name provided." });
  }
  try {
    const existing = scene.getMeshByName(name);
    if (existing) {
      log(`register-mesh: "${name}" already present`);
      return res.json({ ok: true, created: false });
    }
    // An empty BABYLON.Mesh is enough to satisfy name lookups in the sandbox.
    // Give it a rotationQuaternion like a real imported GLB root so the sandbox mirrors
    // browser state: snippets that rotate it must use mesh.rotate(...)/quaternion math,
    // not mesh.rotation.y (which Babylon ignores once a rotationQuaternion is present).
    const stub = new BABYLON.Mesh(name, scene);
    stub.rotationQuaternion = BABYLON.Quaternion.Identity();
    log(`register-mesh: created stub mesh "${name}"`);
    return res.json({ ok: true, created: true });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    logError("register-mesh: ERROR -", message);
    return res.json({ ok: false, error: message });
  }
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

// Initialize Havok once, build the first scene, then start accepting requests so
// that /health (which start.sh waits on) only succeeds once physics is ready.
await initHavok();
createScene();

app.listen(PORT, () => {
  log(`Validator listening on http://localhost:${PORT}`);
});
