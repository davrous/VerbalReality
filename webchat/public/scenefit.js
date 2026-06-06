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

  // Padding (world units) kept between an object's footprint and its neighbours so they
  // never touch. A fraction of TARGET_SIZE keeps the gap proportional to normalized size.
  const PLACEMENT_PAD = TARGET_SIZE * 0.2;

  // Collect the top-level nodes of each existing object so we can measure one footprint
  // per object. Walks up from every real content mesh (non-helper, non-ground, with
  // geometry) to its highest ancestor and dedupes — this correctly treats models already
  // grouped under a `__fit_N` TransformNode (from earlier turns) as a single object.
  // Nodes whose uniqueId (or whose top ancestor's uniqueId) is in `excludeIds` are skipped.
  function contentRootMeshes(scene, excludeIds) {
    const seen = new Set();
    const out = [];
    for (const m of scene.meshes) {
      if (isHelper(m) || isGroundOrSky(m)) continue;
      if (m.getTotalVertices && m.getTotalVertices() === 0) continue;
      // Walk to the top-most ancestor (the per-object grouping node, if any).
      let top = m;
      while (top.parent && top.parent.getClassName && /Mesh|TransformNode/.test(top.parent.getClassName())) {
        top = top.parent;
      }
      if (seen.has(top.uniqueId)) continue;
      if (excludeIds && (excludeIds.has(top.uniqueId) || excludeIds.has(m.uniqueId))) continue;
      seen.add(top.uniqueId);
      out.push(top);
    }
    return out;
  }

  // X/Z footprint (axis-aligned) of a node's world-space hierarchy bounding box.
  function footprintXZ(node) {
    node.computeWorldMatrix(true);
    const b = node.getHierarchyBoundingVectors(true);
    return { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
  }

  // 2D axis-aligned overlap test on the X/Z plane, expanded by `pad` on every side so
  // footprints that merely touch (or sit within the gap) still count as colliding.
  function overlaps2D(a, b, pad) {
    return (
      a.minX - pad < b.maxX &&
      a.maxX + pad > b.minX &&
      a.minZ - pad < b.maxZ &&
      a.maxZ + pad > b.minZ
    );
  }

  // Find an (dx, dz) translation that moves `newFp` so it no longer overlaps any footprint
  // in `existing`. Searches outward in expanding rings (a coarse spiral) from the object's
  // current spot; ring 0 is the unshifted position, so an empty scene keeps the object put.
  function findFreeOffset(newFp, existing, pad) {
    const fits = (dx, dz) => {
      const shifted = {
        minX: newFp.minX + dx,
        maxX: newFp.maxX + dx,
        minZ: newFp.minZ + dz,
        maxZ: newFp.maxZ + dz,
      };
      for (const e of existing) {
        if (overlaps2D(shifted, e, pad)) return false;
      }
      return true;
    };

    if (!existing.length || fits(0, 0)) return { dx: 0, dz: 0 };

    // Step size scaled to the new object's footprint so each ring clears its own size.
    const width = newFp.maxX - newFp.minX;
    const depth = newFp.maxZ - newFp.minZ;
    const step = Math.max(width, depth, TARGET_SIZE) + pad;

    const MAX_RINGS = 24;
    for (let ring = 1; ring <= MAX_RINGS; ring++) {
      const radius = ring * step;
      // More candidate angles on outer rings to keep angular spacing roughly even.
      const samples = Math.max(8, ring * 8);
      for (let i = 0; i < samples; i++) {
        const angle = (i / samples) * Math.PI * 2;
        const dx = Math.cos(angle) * radius;
        const dz = Math.sin(angle) * radius;
        if (fits(dx, dz)) return { dx, dz };
      }
    }
    // Exhausted: drop it just past the ring search so it's at least clearly separated.
    return { dx: (MAX_RINGS + 1) * step, dz: 0 };
  }

  // Frame the ArcRotateCamera so every piece of content currently in the scene is visible.
  function frameAllContent(scene, camera) {
    const nodes = contentRootMeshes(scene, null);
    if (nodes.length) frameCamera(camera, nodes);
  }

  // Shift `node` (a TransformNode grouping this turn's new content) along X/Z so its
  // footprint no longer overlaps any pre-existing content. Y (ground rest) is preserved.
  function placeWithoutOverlap(scene, node) {
    // Exclude the node itself and its descendants from the "existing content" set.
    const excludeIds = new Set([node.uniqueId]);
    for (const child of node.getChildMeshes(false)) excludeIds.add(child.uniqueId);

    const existing = contentRootMeshes(scene, excludeIds).map(footprintXZ);
    if (!existing.length) return;

    const newFp = footprintXZ(node);
    const { dx, dz } = findFreeOffset(newFp, existing, PLACEMENT_PAD);
    if (dx === 0 && dz === 0) return;
    node.position = node.position.add(new BABYLON.Vector3(dx, 0, dz));
    node.computeWorldMatrix(true);
  }

  // Reparent `roots` under a fresh TransformNode and return it. setParent(node, true)
  // preserves each mesh's current world transform so nothing visually jumps.
  function groupUnderNode(scene, roots) {
    const node = new BABYLON.TransformNode("__fit_" + fitCounter++, scene);
    for (const r of roots) r.setParent(node);
    return node;
  }

  // Dissolve a temporary `__fit_N` grouping node after it has been scaled/positioned:
  // unparent each direct child back to the top level (setParent(null) bakes the node's
  // world transform into each child's own local transform) and dispose the now-empty node.
  // This is what makes later LLM edits behave: the named meshes end up top-level, so
  // `mesh.position = (x,y,z)` and position animations are world-space, not multiplied by
  // a hidden normalization scale on a parent wrapper.
  function bakeToWorld(node) {
    const children = node.getChildren(undefined, true).slice();
    for (const child of children) child.setParent(null);
    node.dispose();
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
    // If the scene already had content, slide this turn's additions to a free X/Z spot
    // so they don't land on top of what's already there.
    if (!recenter) placeWithoutOverlap(scene, node);
    // Bake the normalization (scale + ground + placement) into the meshes themselves and
    // remove the temporary grouping node, so the subject meshes stay top-level. This keeps
    // later turns' edits (mesh.position, position animations) in plain world units instead
    // of being multiplied by a hidden scale on a parent wrapper.
    bakeToWorld(node);
    frameAllContent(scene, camera);
  }

  // Normalize a single imported GLB root mesh. `userScale` (default 1) lets the caller
  // ask for a deliberately bigger/smaller model on top of the canonical size.
  function fitImportedModel(scene, camera, root, userScale) {
    if (!root) return;
    const scale = typeof userScale === "number" && userScale > 0 ? userScale : 1;

    // Detach the imported root to the top level. The glTF loader parents content under a
    // `__root__` node that carries the right-handed→left-handed conversion; setParent(null)
    // bakes that conversion into `root`'s own transform so its LOCAL frame equals WORLD.
    // We then normalize `root` directly (no scaled wrapper), so the named mesh stays
    // top-level and later edits to its `position`/`scaling` (and position animations) are
    // in plain world units rather than multiplied by a hidden parent scale.
    if (root.parent) root.setParent(null);
    root.computeWorldMatrix(true);
    const bounds = root.getHierarchyBoundingVectors(true);
    // Fold the requested user scale into the target dimension.
    const sizeX = bounds.max.x - bounds.min.x;
    const sizeY = bounds.max.y - bounds.min.y;
    const sizeZ = bounds.max.z - bounds.min.z;
    const maxDim = Math.max(sizeX, sizeY, sizeZ);
    if (maxDim > 0) {
      const factor = clampScale((TARGET_SIZE * scale) / maxDim);
      root.scaling = root.scaling.scale(factor);
      root.computeWorldMatrix(true);
      const scaled = root.getHierarchyBoundingVectors(true);
      // Imported models always self-center on the ground.
      const dx = -(scaled.min.x + scaled.max.x) / 2;
      const dz = -(scaled.min.z + scaled.max.z) / 2;
      const dy = -scaled.min.y;
      root.position = root.position.add(new BABYLON.Vector3(dx, dy, dz));
      root.computeWorldMatrix(true);
    }
    // Move the freshly centered model aside if it would overlap existing content.
    placeWithoutOverlap(scene, root);
    frameAllContent(scene, camera);
  }

  window.SceneFit = {
    TARGET_SIZE,
    snapshot,
    fitNewContent,
    fitImportedModel,
  };
})();
