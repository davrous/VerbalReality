// SceneFit — keeps newly added 3D content at a consistent on-screen size.
//
// The LLM (and the GLB model library) give no guarantee about absolute scale: the same
// prompt can produce a castle that's 2 units or 200 units tall. This module measures the
// world-space bounding box of whatever was just added during a turn, rescales it so its
// largest dimension matches a canonical TARGET_SIZE, rests it on the ground (min.y = 0),
// and then frames the camera around it. The result: "create a fantasy castle" looks the
// same size every time, whether built from primitives or imported from a GLB.
//
// Exposed as window.SceneFit so app.js (primitives + gallery loads) can call it.
(() => {
  "use strict";

  // Largest dimension a normalized object is scaled to (world units). Chosen to sit
  // comfortably inside the default ArcRotateCamera (radius 10, target origin).
  const TARGET_SIZE = 5;

  // Extra breathing room applied to the camera radius when framing (1 = tight fit).
  const CAMERA_MARGIN = 1.4;

  // Guard rails so a tiny detail mesh isn't blown up absurdly and a huge mesh isn't
  // crushed to a speck if the bounding box is degenerate.
  const MIN_SCALE = 1e-4;
  const MAX_SCALE = 1e6;

  let fitCounter = 0;

  // Meshes the app creates for UI/feedback (activity cube, HUD, and our own fit nodes).
  // They must never be measured or rescaled as if they were user content.
  function isHelper(node) {
    return typeof node.name === "string" && node.name.indexOf("__") === 0;
  }

  // Grounds and skyboxes would dominate (or break) a bounding-box measurement, so they
  // are excluded from sizing/framing — they stay exactly where the author put them.
  function isGroundOrSky(mesh) {
    const name = (mesh.name || "").toLowerCase();
    if (/ground|sky|skybox|skydome/.test(name)) return true;
    if (mesh.infiniteDistance) return true;
    const info = mesh.getBoundingInfo && mesh.getBoundingInfo();
    if (info) {
      const ext = info.boundingBox.extendSizeWorld;
      // Very wide but essentially flat → treat as a ground plane.
      const flat = ext.y < 0.05;
      const wide = ext.x > 25 || ext.z > 25;
      if (flat && wide) return true;
    }
    return false;
  }

  // Capture the meshes present before a turn runs, so we can diff to find new content.
  function snapshot(scene) {
    const set = new Set();
    for (const m of scene.meshes) set.add(m.uniqueId);
    return set;
  }

  // True if any non-helper, non-ground mesh existed before this turn — used to decide
  // whether to recenter horizontally (only the very first object is centered, so later
  // additions keep their authored position next to existing content).
  function hadContentBefore(scene, beforeSet) {
    if (!beforeSet) return false;
    for (const m of scene.meshes) {
      if (!beforeSet.has(m.uniqueId)) continue;
      if (isHelper(m) || isGroundOrSky(m)) continue;
      if (m.getTotalVertices && m.getTotalVertices() > 0) return true;
    }
    return false;
  }

  // Top-level meshes (no mesh parent) added this turn, split into measurable subject
  // meshes and the full set (subjects + grounds) so we can reparent everything together.
  function getNewRoots(scene, beforeSet) {
    const subjects = [];
    const all = [];
    for (const m of scene.meshes) {
      if (beforeSet && beforeSet.has(m.uniqueId)) continue;
      if (isHelper(m)) continue;
      // Only consider roots; children move with their parent automatically.
      const parent = m.parent;
      if (parent && parent.getClassName && /Mesh|TransformNode/.test(parent.getClassName())) {
        // Skip if the parent is itself new content we'll handle as a root.
        if (!beforeSet || !beforeSet.has(parent.uniqueId)) continue;
      }
      all.push(m);
      if (!isGroundOrSky(m)) subjects.push(m);
    }
    return { subjects, all };
  }

  // World-space bounding box covering a node and its descendants.
  function worldBounds(nodes) {
    let min = null;
    let max = null;
    for (const node of nodes) {
      if (!node.getHierarchyBoundingVectors) continue;
      node.computeWorldMatrix(true);
      const b = node.getHierarchyBoundingVectors(true);
      if (!min) {
        min = b.min.clone();
        max = b.max.clone();
      } else {
        min = BABYLON.Vector3.Minimize(min, b.min);
        max = BABYLON.Vector3.Maximize(max, b.max);
      }
    }
    return min && max ? { min, max } : null;
  }

  function clampScale(s) {
    if (!isFinite(s) || s <= 0) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  }

  // Reparent `roots` under a fresh TransformNode and return it. setParent(node, true)
  // preserves each mesh's current world transform so nothing visually jumps.
  function groupUnderNode(scene, roots) {
    const node = new BABYLON.TransformNode("__fit_" + fitCounter++, scene);
    for (const r of roots) r.setParent(node);
    return node;
  }

  // Core normalization: scale `node` so the measured `bounds` largest dimension equals
  // TARGET_SIZE, drop it onto the ground (min.y = 0), and optionally recenter x/z.
  function normalizeNode(node, bounds, recenter) {
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    if (maxDim <= 0) return;

    const factor = clampScale(TARGET_SIZE / maxDim);
    node.scaling = node.scaling.scale(factor);
    node.computeWorldMatrix(true);

    // Re-measure after scaling, then translate to sit on the ground (and center x/z).
    const scaled = node.getHierarchyBoundingVectors(true);
    const dx = recenter ? -(scaled.min.x + scaled.max.x) / 2 : 0;
    const dz = recenter ? -(scaled.min.z + scaled.max.z) / 2 : 0;
    const dy = -scaled.min.y;
    node.position = node.position.add(new BABYLON.Vector3(dx, dy, dz));
    node.computeWorldMatrix(true);
  }

  // Point the ArcRotateCamera at the given nodes and pull back far enough to frame them.
  function frameCamera(camera, nodes) {
    if (!camera || !nodes.length) return;
    const bounds = worldBounds(nodes);
    if (!bounds) return;
    const center = bounds.min.add(bounds.max).scale(0.5);
    const radius = BABYLON.Vector3.Distance(bounds.min, bounds.max) / 2 || TARGET_SIZE;

    if (camera.setTarget) camera.setTarget(center);
    else camera.target = center;

    // Distance so the bounding sphere fits the (smaller of the two) FOV with margin.
    const fov = camera.fov || 0.8;
    const fit = radius / Math.sin(Math.min(fov, fov) / 2);
    camera.radius = fit * CAMERA_MARGIN;
  }

  // Called after a turn's generated code has run. Normalizes the subject meshes created
  // this turn and frames the camera on them. Grounds are left untouched.
  function fitNewContent(scene, camera, beforeSet) {
    const { subjects } = getNewRoots(scene, beforeSet);
    if (!subjects.length) return; // nothing measurable added (e.g. only a ground / animation)

    const recenter = !hadContentBefore(scene, beforeSet);
    const node = groupUnderNode(scene, subjects);
    const bounds = node.getHierarchyBoundingVectors(true);
    normalizeNode(node, bounds, recenter);
    frameCamera(camera, [node]);
  }

  // Normalize a single imported GLB root mesh. `userScale` (default 1) lets the caller
  // ask for a deliberately bigger/smaller model on top of the canonical size.
  function fitImportedModel(scene, camera, root, userScale) {
    if (!root) return;
    const scale = typeof userScale === "number" && userScale > 0 ? userScale : 1;
    const recenter = true; // imported models always self-center on the ground

    const node = groupUnderNode(scene, [root]);
    const bounds = node.getHierarchyBoundingVectors(true);
    // Fold the requested user scale into the target dimension.
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    if (maxDim > 0) {
      const factor = clampScale((TARGET_SIZE * scale) / maxDim);
      node.scaling = node.scaling.scale(factor);
      node.computeWorldMatrix(true);
      const scaled = node.getHierarchyBoundingVectors(true);
      const dx = recenter ? -(scaled.min.x + scaled.max.x) / 2 : 0;
      const dz = recenter ? -(scaled.min.z + scaled.max.z) / 2 : 0;
      const dy = -scaled.min.y;
      node.position = node.position.add(new BABYLON.Vector3(dx, dy, dz));
      node.computeWorldMatrix(true);
    }
    frameCamera(camera, [node]);
  }

  window.SceneFit = {
    TARGET_SIZE,
    snapshot,
    fitNewContent,
    fitImportedModel,
  };
})();
