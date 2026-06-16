// In-canvas activity indicators rendered entirely with Babylon.js (3D GUI + meshes),
// so they are visible inside a future VR session too — nothing is drawn as a DOM/2D
// overlay.
//
// What it shows:
//   * A "builder" cube that smoothly cycles colour, rotates on several axes and pulses
//     while the agent is generating code.
//   * A prompt-themed "still working…" text panel refreshed every 5s, plus a fun
//     bouncing 3D object spawned on each heartbeat.
//   * A transient text panel for every tool the agent calls, which fades away after 5s.
//
// Public API (global `ActivityIndicators`):
//   attach(scene, camera)  — (re)bind to a freshly built scene.
//   start(prompt)          — begin the "building" animation + heartbeat.
//   notifyTool(name)       — show a tool-call panel that auto-fades after 5s.
//   stop()                 — stop animation and dispose all indicator objects.
window.ActivityIndicators = (function () {
  "use strict";

  const TOOL_TTL = 5.0; // seconds a tool panel stays before it is gone
  const BOUNCER_TTL = 4.6; // seconds a bouncing object lives
  const HEARTBEAT_MS = 10000; // "still working" cadence

  // The whole indicator cluster is parented to the camera so it stays pinned to the
  // top-left of the canvas no matter where the camera looks or moves (VR-friendly HUD).
  const HUD_Z = 6; // distance in front of the camera
  const HUD_LEFT_X = 0.45; // world units inset of the animated cluster from the LEFT edge
  const HUD_TOP_Y = 0.45; // world units inset of the animated cluster from the TOP edge
  const HUD_MARGIN_X = 0.35; // world units of horizontal margin for the message cards (right)
  const HUD_MARGIN_Y = 0.4; // world units of top margin for the message cards
  const HUD_GROUP = 1; // rendering group drawn on top of the scene (depth cleared)
  const WORLD_PER_PX = 0.00225; // texture-pixel → world-unit scale for message cards

  // Lazy-follow HUD (VR comfort): the cluster is NOT rigidly head-locked. A "follower"
  // node smoothly chases the camera's position + orientation, so the HUD lags behind
  // while you move your head and gently re-settles into the corners once you stop —
  // avoiding objects glued to your eyes (a known source of VR discomfort). The smoothing
  // is frame-rate independent (exponential): larger lambda = snappier, smaller = lazier.
  const FOLLOW_POS_LAMBDA = 9; // head translation tracked fairly tightly
  const FOLLOW_ROT_LAMBDA = 4.5; // head rotation followed lazily, then catches up
  const FOLLOW_DEADZONE_RAD = 0.07; // ~4°: ignore micro head-jitter so it stays planted

  const hasGUI = !!(window.BABYLON && BABYLON.GUI && BABYLON.GUI.GUI3DManager);

  const WAIT_MESSAGES = [
    "Sculpting your {kw}…",
    "Summoning a {kw} from the void…",
    "Bending vertices into a {kw}…",
    "Polishing pixels for the {kw}…",
    "Teaching the GPU about {kw}…",
    "Mixing materials for the {kw}…",
    "Arranging photons around your {kw}…",
    "Composing a {kw} in 3D space…",
    "Crafting meshes for the {kw}…",
    "Almost there — wiring up the {kw}…",
    "Laying out the {kw}…",
    "Snapping the {kw} into place…",
    "Rendering the {kw}…",
    "Carving the {kw} from triangles…",
    "Lighting the {kw} just right…",
    "Breathing life into the {kw}…",
    "Tweaking the {kw} a little more…",
    "Stitching the {kw} together…",
  ];

  const STOPWORDS = new Set([
    "the", "and", "with", "that", "this", "create", "make", "build", "add",
    "please", "scene", "into", "from", "your", "some", "a", "an", "of", "to",
    "for", "on", "in", "it", "me", "show", "give", "above", "below", "around",
  ]);

  let scene = null;
  let camera = null;
  let manager = null;
  let observer = null;
  let hudRoot = null;
  let hudRight = null;
  let hudFollower = null; // scene-parented node that lazily follows the camera
  let _fScale = null;
  let _fRot = null;
  let _fPos = null;
  let _followEngaged = false; // hysteresis: once moving, keep following until re-settled

  let cube = null;
  let cubeMat = null;
  let active = false;

  let heartbeat = null;
  let keyword = "scene";

  let waitPanel = null; // plane mesh or null
  const toolPanels = []; // { mesh, born }
  const bouncers = []; // { mesh, born, baseY, ampl }

  let lastTime = nowSec();

  function nowSec() {
    return performance.now() / 1000;
  }

  // -------------------------------------------------------------------------
  function attach(_scene, _camera) {
    detach();
    scene = _scene;
    camera = _camera;
    if (!scene) return;

    // Lazy-follow anchor: parented to the SCENE (not the camera) and smoothly steered
    // toward the camera transform every frame in update(). The HUD clusters hang off it.
    hudFollower = new BABYLON.TransformNode("__activity_hud_follow", scene);
    _fScale = new BABYLON.Vector3();
    _fRot = new BABYLON.Quaternion();
    _fPos = new BABYLON.Vector3();
    camera.computeWorldMatrix(true);
    camera.getWorldMatrix().decompose(_fScale, _fRot, _fPos);
    hudFollower.position = _fPos.clone();
    hudFollower.rotationQuaternion = _fRot.clone();

    // HUD anchors hang off the follower so they inherit its smoothed pose, then sit at
    // the viewport corners via their local offsets (recomputed each frame in update()).
    hudRoot = new BABYLON.TransformNode("__activity_hud", scene); // top-left cluster
    hudRoot.parent = hudFollower;
    hudRight = new BABYLON.TransformNode("__activity_hud_right", scene); // top-right messages
    hudRight.parent = hudFollower;

    cubeMat = new BABYLON.StandardMaterial("__activity_cube_mat", scene);
    cubeMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.08);
    cubeMat.emissiveColor = new BABYLON.Color3(0.2, 0.6, 1);
    cubeMat.specularColor = new BABYLON.Color3(0.4, 0.4, 0.4);

    // ~5x smaller animated builder cube, tucked into the top-left corner.
    cube = BABYLON.MeshBuilder.CreateBox("__activity_cube", { size: 0.18 }, scene);
    cube.material = cubeMat;
    cube.parent = hudRoot;
    cube.position.set(0, 0, 0);
    cube.isPickable = false;
    cube.isVisible = false;
    applyGroup(cube);

    observer = scene.onBeforeRenderObservable.add(update);
  }

  function detach() {
    stop();
    if (observer && scene) {
      scene.onBeforeRenderObservable.remove(observer);
    }
    observer = null;
    if (manager) {
      try {
        manager.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    manager = null;
    if (cube) {
      try {
        cube.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    cube = null;
    cubeMat = null;
    if (hudRight) {
      try {
        hudRight.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    hudRight = null;
    if (hudRoot) {
      try {
        hudRoot.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    hudRoot = null;
    if (hudFollower) {
      try {
        hudFollower.dispose();
      } catch (_) {
        /* ignore */
      }
    }
    hudFollower = null;
    _fScale = null;
    _fRot = null;
    _fPos = null;
    _followEngaged = false;
    scene = null;
    camera = null;
  }

  // -------------------------------------------------------------------------
  function start(prompt) {
    if (!scene) return;
    keyword = extractKeyword(prompt);
    active = true;
    if (cube) cube.isVisible = true;

    showWaitMessage(pickMessage());
    spawnBouncer();

    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      showWaitMessage(pickMessage());
      spawnBouncer();
    }, HEARTBEAT_MS);
  }

  function stop() {
    active = false;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (cube) cube.isVisible = false;

    if (waitPanel) {
      disposePanel(waitPanel);
      waitPanel = null;
    }
    while (toolPanels.length) disposePanel(toolPanels.pop().mesh);
    while (bouncers.length) {
      const b = bouncers.pop();
      try {
        b.mesh.dispose();
      } catch (_) {
        /* ignore */
      }
    }
  }

  // -------------------------------------------------------------------------
  function notifyTool(name, attempt) {
    if (!scene) return;
    const label = "\uD83D\uDD27 " + friendlyToolName(name, attempt);
    const plane = makeTextPanel(label, {
      fontSize: 40,
      accent: "rgba(255,180,90,0.95)",
    });
    if (!plane) return;
    plane.parent = hudRight;
    plane.visibility = 0;

    // Re-validation retries should not stack: replace the existing panel for this tool
    // (so "Validating…" shows once, with an updated attempt count) instead of piling on
    // a new card per call.
    const existing = toolPanels.find((p) => p.name === name);
    if (existing) {
      disposePanel(existing.mesh);
      existing.mesh = plane;
      existing.born = nowSec();
    } else {
      toolPanels.push({ mesh: plane, born: nowSec(), name: name });
    }
    relayoutMessages();
  }

  // -------------------------------------------------------------------------
  function update() {
    const t = nowSec();
    const dt = Math.min(0.1, Math.max(0, t - lastTime));
    lastTime = t;

    // Lazy-follow the camera (VR comfort): smoothly steer the follower toward the
    // camera's current world pose. Position tracks fairly tightly; rotation follows
    // lazily with a small deadzone, so the HUD trails head movement and re-settles into
    // the corners once the head stops instead of being rigidly glued to the view.
    if (hudFollower && camera) {
      camera.getWorldMatrix().decompose(_fScale, _fRot, _fPos);
      if (!hudFollower.rotationQuaternion) {
        hudFollower.rotationQuaternion = _fRot.clone();
      }
      const aPos = 1 - Math.exp(-FOLLOW_POS_LAMBDA * dt);
      BABYLON.Vector3.LerpToRef(hudFollower.position, _fPos, aPos, hudFollower.position);

      const q = hudFollower.rotationQuaternion;
      let dot = q.x * _fRot.x + q.y * _fRot.y + q.z * _fRot.z + q.w * _fRot.w;
      dot = Math.min(1, Math.abs(dot));
      const angle = 2 * Math.acos(dot); // radians between current and target orientation
      // Hysteresis so the HUD always re-settles flush in the corners: the deadzone only
      // decides when to START following. Once engaged we slerp ALL THE WAY back to the
      // camera orientation (angle ~0) before disengaging — otherwise the follower would
      // freeze a few degrees off-target and the corners would never line up again.
      if (angle > FOLLOW_DEADZONE_RAD) {
        _followEngaged = true;
      }
      if (_followEngaged) {
        const aRot = 1 - Math.exp(-FOLLOW_ROT_LAMBDA * dt);
        BABYLON.Quaternion.SlerpToRef(q, _fRot, aRot, q);
        if (angle < 0.0015) {
          // Snap exactly onto the target and stop, so it's perfectly corner-aligned.
          q.copyFrom(_fRot);
          _followEngaged = false;
        }
      }
    }

    // Place the clusters at the corners of the view (handles any aspect ratio and live
    // resizing). These are local offsets within the smoothed follower's space.
    if (hudRoot && camera) {
      const fov = camera.fov || 0.8;
      const aspect = scene.getEngine().getAspectRatio(camera) || 1.6;
      const halfH = HUD_Z * Math.tan(fov / 2);
      const halfW = halfH * aspect;
      hudRoot.position.x = -halfW + HUD_LEFT_X;
      hudRoot.position.y = halfH - HUD_TOP_Y;
      hudRoot.position.z = HUD_Z;
      if (hudRight) {
        hudRight.position.x = halfW - HUD_MARGIN_X;
        hudRight.position.y = halfH - HUD_MARGIN_Y;
        hudRight.position.z = HUD_Z;
      }
    }

    if (active && cube) {
      cube.rotation.y += dt * 0.9;
      cube.rotation.x += dt * 0.6;
      cube.rotation.z += dt * 0.3;
      const hue = (t * 45) % 360;
      cubeMat.emissiveColor = BABYLON.Color3.FromHSV(hue, 0.7, 1);
      const pulse = 1 + 0.12 * Math.sin(t * 4);
      cube.scaling.set(pulse, pulse, pulse);
      cube.position.y = 0.04 * Math.sin(t * 2);
    }

    // Tool panels fade in, hold, then fade out near the end of their life.
    let removed = false;
    for (let i = toolPanels.length - 1; i >= 0; i--) {
      const p = toolPanels[i];
      const age = t - p.born;
      if (age >= TOOL_TTL) {
        disposePanel(p.mesh);
        toolPanels.splice(i, 1);
        removed = true;
        continue;
      }
      const fadeIn = Math.min(1, age / 0.3);
      const fadeOut = age > TOOL_TTL - 1 ? Math.max(0, (TOOL_TTL - age) / 1) : 1;
      p.mesh.visibility = Math.min(fadeIn, fadeOut);
    }
    if (removed) relayoutMessages();

    // Bouncing objects.
    for (let i = bouncers.length - 1; i >= 0; i--) {
      const b = bouncers[i];
      const age = t - b.born;
      if (age >= BOUNCER_TTL) {
        try {
          b.mesh.dispose();
        } catch (_) {
          /* ignore */
        }
        bouncers.splice(i, 1);
        continue;
      }
      b.mesh.position.y = b.baseY + b.ampl * Math.abs(Math.sin(age * 2.2));
      b.mesh.rotation.y += dt * 1.5;
      b.mesh.rotation.x += dt * 1.1;
      const fadeIn = Math.min(1, age / 0.4);
      const fadeOut = age > BOUNCER_TTL - 0.6 ? Math.max(0, (BOUNCER_TTL - age) / 0.6) : 1;
      b.mesh.visibility = Math.min(fadeIn, fadeOut);
    }
  }

  // -------------------------------------------------------------------------
  function spawnBouncer() {
    if (!scene) return;
    const kinds = ["sphere", "torus", "cylinder", "polyhedron", "box"];
    const kind = kinds[(Math.random() * kinds.length) | 0];
    let mesh;
    const s = (0.4 + Math.random() * 0.25) / 5;
    try {
      if (kind === "sphere") {
        mesh = BABYLON.MeshBuilder.CreateSphere("__activity_b", { diameter: s * 1.4 }, scene);
      } else if (kind === "torus") {
        mesh = BABYLON.MeshBuilder.CreateTorus("__activity_b", { diameter: s * 1.6, thickness: s * 0.5 }, scene);
      } else if (kind === "cylinder") {
        mesh = BABYLON.MeshBuilder.CreateCylinder("__activity_b", { height: s * 1.6, diameter: s }, scene);
      } else if (kind === "polyhedron") {
        mesh = BABYLON.MeshBuilder.CreatePolyhedron("__activity_b", { type: (Math.random() * 4) | 0, size: s * 0.8 }, scene);
      } else {
        mesh = BABYLON.MeshBuilder.CreateBox("__activity_b", { size: s }, scene);
      }
    } catch (_) {
      return;
    }

    const mat = new BABYLON.StandardMaterial("__activity_b_mat", scene);
    mat.emissiveColor = BABYLON.Color3.FromHSV(Math.random() * 360, 0.75, 1);
    mat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.08);
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.parent = hudRoot;
    applyGroup(mesh);

    // Local offsets (relative to the HUD anchor) clustered tightly around the cube.
    const x = 0.12 + Math.random() * 0.3;
    const z = -0.15 + Math.random() * 0.3;
    const baseY = -0.28 + Math.random() * 0.2;
    mesh.position.set(x, baseY, z);
    mesh.visibility = 0;

    bouncers.push({ mesh, born: nowSec(), baseY, ampl: (0.5 + Math.random() * 0.6) / 5 });
  }

  // -------------------------------------------------------------------------
  function showWaitMessage(text) {
    if (!scene) return;
    if (waitPanel) {
      disposePanel(waitPanel);
      waitPanel = null;
    }
    const plane = makeTextPanel(text, {
      fontSize: 46,
      accent: "rgba(90,200,255,0.95)",
    });
    if (!plane) return;
    plane.parent = hudRight;
    waitPanel = plane;
    relayoutMessages();
  }

  function makeTextPanel(text, opts) {
    if (!scene) return null;
    opts = opts || {};
    const fontSize = opts.fontSize || 44;
    const padX = 38;
    const padY = 26;
    const wrapAt = opts.maxTextWidth || 560; // px before a soft wrap kicks in
    const accent = opts.accent || "rgba(140,180,255,0.9)";
    const fontSpec =
      "600 " + fontSize + "px 'Segoe UI', system-ui, -apple-system, sans-serif";

    // Measure + wrap so the card grows to fit text of ANY length (never clipped).
    const meas = getMeasureCtx();
    meas.font = fontSpec;
    const lines = wrapText(meas, String(text), wrapAt);
    const lineH = Math.round(fontSize * 1.32);
    let textW = 0;
    for (const l of lines) textW = Math.max(textW, meas.measureText(l).width);

    const W = Math.max(48, Math.ceil(textW + padX * 2));
    const H = Math.max(48, Math.ceil(lines.length * lineH + padY * 2));

    let dt;
    try {
      dt = new BABYLON.DynamicTexture("__activity_dt", { width: W, height: H }, scene, true);
    } catch (_) {
      return null;
    }
    dt.hasAlpha = true;
    const ctx = dt.getContext();
    ctx.clearRect(0, 0, W, H);

    // Rounded, gradient "glass" card.
    roundRectPath(ctx, 2, 2, W - 4, H - 4, 24);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(30,34,54,0.93)");
    grad.addColorStop(1, "rgba(16,18,30,0.93)");
    ctx.fillStyle = grad;
    ctx.fill();

    // Accent strip down the left edge.
    ctx.save();
    roundRectPath(ctx, 2, 2, W - 4, H - 4, 24);
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.fillRect(2, 2, 9, H - 4);
    ctx.restore();

    // Subtle border.
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(150,185,255,0.45)";
    roundRectPath(ctx, 2.5, 2.5, W - 5, H - 5, 22);
    ctx.stroke();

    // Wrapped text, left-aligned next to the accent strip.
    ctx.font = fontSpec;
    ctx.fillStyle = "#eef2ff";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], padX, padY + lineH * (i + 0.5));
    }
    dt.update();

    // A real textured plane (works in VR), sized so on-screen text stays constant
    // whatever the line count: the card grows, the font does not shrink.
    const planeW = W * WORLD_PER_PX;
    const planeH = H * WORLD_PER_PX;
    const plane = BABYLON.MeshBuilder.CreatePlane(
      "__activity_panel",
      { width: planeW, height: planeH },
      scene
    );
    const mat = new BABYLON.StandardMaterial("__activity_panel_mat", scene);
    mat.emissiveTexture = dt;
    mat.opacityTexture = dt;
    mat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    plane.material = mat;
    plane.__dt = dt;
    plane.__w = planeW;
    plane.__h = planeH;
    plane.isPickable = false;
    // No billboarding: the plane is already parented to the camera-anchored HUD, so it
    // faces the viewer naturally and stays rock-steady (billboarding caused drift while
    // the camera moved).
    plane.billboardMode = BABYLON.AbstractMesh.BILLBOARDMODE_NONE;
    plane.renderingGroupId = HUD_GROUP;
    return plane;
  }

  // Stack the wait message + tool panels down the top-right corner, right-aligned
  // so their right edge stays pinned regardless of each panel's width.
  function relayoutMessages() {
    let y = 0;
    if (waitPanel) {
      waitPanel.position.x = -waitPanel.__w / 2;
      waitPanel.position.y = y - waitPanel.__h / 2;
      y -= waitPanel.__h + 0.16;
    }
    for (const p of toolPanels) {
      const m = p.mesh;
      m.position.x = -m.__w / 2;
      m.position.y = y - m.__h / 2;
      y -= m.__h + 0.12;
    }
  }

  const MAX_VALIDATION_ATTEMPTS = 3;
  const TOOL_LABELS = {
    validate_babylon_code: "Validating Babylon.js code\u2026",
  };
  function friendlyToolName(name, attempt) {
    const base = TOOL_LABELS[name] || String(name || "tool");
    if (attempt && attempt > 1) {
      return base + " (attempt " + attempt + " of " + MAX_VALIDATION_ATTEMPTS + ")";
    }
    return base;
  }

  function wrapText(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (line && ctx.measureText(test).width > maxWidth) {
        lines.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  let measureCtx = null;
  function getMeasureCtx() {
    if (!measureCtx) {
      measureCtx = document.createElement("canvas").getContext("2d");
    }
    return measureCtx;
  }

  // -------------------------------------------------------------------------
  function applyGroup(mesh) {
    if (!mesh) return;
    mesh.renderingGroupId = HUD_GROUP;
    if (mesh.getChildMeshes) {
      mesh.getChildMeshes().forEach((m) => {
        m.renderingGroupId = HUD_GROUP;
      });
    }
  }

  function disposePanel(mesh) {
    if (!mesh) return;
    try {
      if (mesh.__dt) mesh.__dt.dispose();
    } catch (_) {
      /* ignore */
    }
    try {
      if (mesh.material) mesh.material.dispose();
    } catch (_) {
      /* ignore */
    }
    try {
      mesh.dispose();
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  function extractKeyword(prompt) {
    const words = String(prompt || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    if (!words.length) return "scene";
    // Prefer the two longest meaningful words for a richer phrase.
    words.sort((a, b) => b.length - a.length);
    return words.slice(0, 2).reverse().join(" ");
  }

  function pickMessage() {
    const tpl = WAIT_MESSAGES[(Math.random() * WAIT_MESSAGES.length) | 0];
    return tpl.replace("{kw}", keyword);
  }

  // Show an explicit progress line pushed from outside (e.g. the agent narrating its work
  // aloud over voice). Reuses the same wait panel + bouncer so it looks consistent, and
  // resets the heartbeat so the auto "still working…" messages don't double up on top of it.
  function showProgress(text) {
    if (!scene || !text) return;
    if (!active) {
      active = true;
      if (cube) cube.isVisible = true;
    }
    showWaitMessage(text);
    spawnBouncer();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      showWaitMessage(pickMessage());
      spawnBouncer();
    }, HEARTBEAT_MS);
  }

  return { attach, detach, start, stop, notifyTool, showProgress };
})();
