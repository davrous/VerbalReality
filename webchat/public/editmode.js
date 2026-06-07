// Direct-manipulation EDIT MODE for the Babylon.js scene.
//
// While edit mode is ON the user can pick an object and transform it with a single
// bounding-box gizmo: drag the object to MOVE it, drag the corner cubes to SCALE it, and
// drag the sphere handles to ROTATE it. One clean widget does all three, and it works
// both on the desktop (mouse) and inside a WebXR/VR session (controller laser).
//
// Controls:
//   Desktop keyboard:  E = enable edit mode,  D = disable.
//   VR right controller: A button = enable,   B button = disable.
//
// Manual edits are NOT streamed to the agent. Instead the final transform of every mesh
// the user touched is recorded, and `consumePendingEdits()` formats them into a single
// `[scene context]` note that app.js prepends to the user's NEXT chat message — so the
// agent learns the object's current position/rotation/scale without any per-drag chatter.
//
// Public API (global `EditMode`):
//   attach(scene, camera, engine, hooks)  — (re)bind to a freshly (re)built scene.
//   enable() / disable()                  — toggle edit mode programmatically.
//   isEnabled()                           — current edit-mode state.
//   consumePendingEdits()                 — return + clear the queued `[scene context]`
//                                           note (empty string when nothing changed).
window.EditMode = (function () {
  "use strict";

  let scene = null;
  let camera = null;
  let gizmoManager = null;
  let xrHelper = null;
  let editEnabled = false;
  let keyboardBound = false;

  // name -> { position:{x,y,z}, rotation:{x,y,z} (deg), scaling:{x,y,z} }
  const pendingEdits = new Map();

  // --- selectability -------------------------------------------------------
  // Mirror the helper/ground/sky exclusions used by scenefit.js so the gizmos only ever
  // attach to genuine user content.
  function isHelper(node) {
    return !!node && typeof node.name === "string" && node.name.indexOf("__") === 0;
  }

  function isGroundOrSky(mesh) {
    const name = (mesh.name || "").toLowerCase();
    if (/ground|sky|skybox|skydome/.test(name)) return true;
    if (mesh.infiniteDistance) return true;
    return false;
  }

  function isSelectable(mesh) {
    if (!mesh) return false;
    if (mesh.isPickable === false) return false;
    if (isHelper(mesh)) return false;
    if (isGroundOrSky(mesh)) return false;
    return true;
  }

  // --- edit tracking -------------------------------------------------------
  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  // Record the attached mesh's current transform (last write per mesh wins).
  function recordEdit(mesh) {
    if (!mesh || !mesh.name) return;
    const e = mesh.rotationQuaternion
      ? mesh.rotationQuaternion.toEulerAngles()
      : mesh.rotation;
    const toDeg = 180 / Math.PI;
    pendingEdits.set(mesh.name, {
      position: { x: round(mesh.position.x), y: round(mesh.position.y), z: round(mesh.position.z) },
      rotation: { x: round(e.x * toDeg), y: round(e.y * toDeg), z: round(e.z * toDeg) },
      scaling: { x: round(mesh.scaling.x), y: round(mesh.scaling.y), z: round(mesh.scaling.z) },
    });
  }

  // Build the `[scene context]` note describing every edited mesh, then clear the queue.
  function consumePendingEdits() {
    if (pendingEdits.size === 0) return "";
    const lines = [];
    pendingEdits.forEach((t, name) => {
      lines.push(
        '- "' +
          name +
          '": position (x=' +
          t.position.x +
          ", y=" +
          t.position.y +
          ", z=" +
          t.position.z +
          "), rotation in degrees (x=" +
          t.rotation.x +
          ", y=" +
          t.rotation.y +
          ", z=" +
          t.rotation.z +
          "), scale (x=" +
          t.scaling.x +
          ", y=" +
          t.scaling.y +
          ", z=" +
          t.scaling.z +
          ")"
      );
    });
    pendingEdits.clear();
    return (
      "[scene context] Since the last message the user manually edited the following " +
      "object(s) in the scene using the on-screen gizmos. These are their CURRENT " +
      "transforms — treat them as the up-to-date state and prefer relative changes so " +
      "the manual edits are preserved:\n" +
      lines.join("\n")
    );
  }

  // --- gizmo wiring --------------------------------------------------------
  // A six-DoF drag behaviour added to the selected mesh lets the user MOVE it by
  // dragging the object itself (works with mouse and with the VR controller laser).
  // The bounding-box gizmo handles SCALE (corner cubes) and ROTATE (sphere handles).
  let dragBehavior = null;
  let dragMesh = null;

  function detachDrag() {
    if (dragBehavior && dragMesh) {
      try {
        dragMesh.removeBehavior(dragBehavior);
      } catch (_) {
        /* ignore */
      }
    }
    dragBehavior = null;
    dragMesh = null;
  }

  function attachDrag(mesh) {
    if (!BABYLON.SixDofDragBehavior) return;
    detachDrag();
    dragBehavior = new BABYLON.SixDofDragBehavior();
    // Translation only — rotation is done with the bounding-box sphere handles, so the
    // object shouldn't tumble while being moved (important for VR comfort).
    dragBehavior.rotateDraggedObject = false;
    mesh.addBehavior(dragBehavior);
    dragBehavior.onDragEndObservable.add(() => recordEdit(mesh));
    dragMesh = mesh;
  }

  // Wire the bounding-box gizmo's scale/rotate drag-end events to record the transform.
  // Guarded with a flag so each freshly created gizmo instance is only wired once.
  function wireBoundingBox() {
    const bb = gizmoManager && gizmoManager.gizmos && gizmoManager.gizmos.boundingBoxGizmo;
    if (!bb || bb._editWired) return;
    bb._editWired = true;
    const rec = () => {
      const mesh = gizmoManager && gizmoManager.attachedMesh;
      if (mesh) recordEdit(mesh);
    };
    if (bb.onScaleBoxDragEndObservable) bb.onScaleBoxDragEndObservable.add(rec);
    if (bb.onRotationSphereDragEndObservable) bb.onRotationSphereDragEndObservable.add(rec);
  }

  function buildGizmoManager() {
    if (gizmoManager) {
      try {
        gizmoManager.dispose();
      } catch (_) {
        /* ignore */
      }
      gizmoManager = null;
    }

    gizmoManager = new BABYLON.GizmoManager(scene);
    // Single bounding-box gizmo (move via drag + scale via corners + rotate via spheres).
    // Start disabled — edit mode is OFF initially.
    gizmoManager.usePointerToAttachGizmos = false;
    gizmoManager.boundingBoxGizmoEnabled = false;

    // When a mesh is (de)selected: reject helpers/ground/sky, and add/remove the move
    // drag behaviour so only the currently selected object is draggable.
    gizmoManager.onAttachedToMeshObservable.add((mesh) => {
      detachDrag();
      if (mesh && !isSelectable(mesh)) {
        gizmoManager.attachToMesh(null);
        return;
      }
      if (mesh && editEnabled) attachDrag(mesh);
    });
  }

  function applyEditState() {
    if (!gizmoManager) return;
    gizmoManager.usePointerToAttachGizmos = editEnabled;
    gizmoManager.boundingBoxGizmoEnabled = editEnabled;
    if (editEnabled) {
      // The gizmo instance is (re)created when enabled — wire its drag-end events now.
      wireBoundingBox();
    } else {
      gizmoManager.attachToMesh(null);
      detachDrag();
    }
  }

  function enable() {
    if (editEnabled) return;
    editEnabled = true;
    applyEditState();
  }

  function disable() {
    if (!editEnabled) return;
    editEnabled = false;
    applyEditState();
  }

  function isEnabled() {
    return editEnabled;
  }

  // --- keyboard (desktop) --------------------------------------------------
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function bindKeyboard() {
    if (keyboardBound) return;
    keyboardBound = true;
    window.addEventListener("keydown", (e) => {
      // Never hijack keys while the user is typing in the chat box / a form field.
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = (e.key || "").toLowerCase();
      if (k === "e") {
        enable();
      } else if (k === "d") {
        disable();
      }
    });
  }

  // --- WebXR / VR controllers ----------------------------------------------
  function wireXRController(controller) {
    controller.onMotionControllerInitObservable.add((motionController) => {
      // A/B buttons live on the RIGHT-hand controller.
      if (motionController.handedness && motionController.handedness !== "right") return;
      const aButton = motionController.getComponent("a-button");
      const bButton = motionController.getComponent("b-button");
      if (aButton) {
        aButton.onButtonStateChangedObservable.add((c) => {
          if (c.changes.pressed && c.pressed) enable();
        });
      }
      if (bButton) {
        bButton.onButtonStateChangedObservable.add((c) => {
          if (c.changes.pressed && c.pressed) disable();
        });
      }
    });
  }

  async function initXR() {
    if (!scene || !scene.createDefaultXRExperienceAsync) return;
    try {
      xrHelper = await scene.createDefaultXRExperienceAsync({});
      if (!xrHelper || !xrHelper.input) return;
      xrHelper.input.controllers.forEach(wireXRController);
      xrHelper.input.onControllerAddedObservable.add(wireXRController);
    } catch (err) {
      // WebXR may be unavailable (no headset / insecure context) — edit mode still works
      // on the desktop with the keyboard, so this is non-fatal.
      console.info("WebXR not initialised for edit mode:", err && err.message);
    }
  }

  // --- lifecycle -----------------------------------------------------------
  function attach(newScene, newCamera /*, engine, hooks */) {
    scene = newScene;
    camera = newCamera;
    editEnabled = false;
    pendingEdits.clear();

    if (!window.BABYLON || !BABYLON.GizmoManager) {
      console.warn("EditMode: BABYLON.GizmoManager unavailable; edit mode disabled.");
      return;
    }

    buildGizmoManager();
    bindKeyboard();
    // Kick off XR setup; safe to run async and lag slightly behind scene build.
    initXR();
  }

  return {
    attach: attach,
    enable: enable,
    disable: disable,
    isEnabled: isEnabled,
    consumePendingEdits: consumePendingEdits,
  };
})();
