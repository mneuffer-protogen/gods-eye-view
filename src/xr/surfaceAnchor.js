/**
 * Setting the globe down on a real surface in mixed reality.
 *
 * Built on the framework's hit-test plumbing (framework/mr-placement.js):
 * a hit-test source from the viewer, so the reticle lands where the user is
 * looking. Only roughly level surfaces are offered, since the base is a
 * disc that has to lie flat. Hit testing is optional (Vision Pro does not
 * expose it), and without it the globe simply stays where it was put.
 */

import * as THREE from 'three';
import {
  HIT_TEST_STATES,
  reticleFromPose,
  requestHitTestSource,
} from './framework/mr-placement.js';

// cos(25 deg): a surface tilted further than this is a wall, not a table.
export const LEVEL_SURFACE = 0.9;

/** Whether a hit pose's surface normal is level enough for the base. */
export function isLevelSurface(quaternion) {
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
  return up.y >= LEVEL_SURFACE;
}

/** Create the reticle and the per-session hit-test source. */
export function createSurfaceAnchor(scene, { color = '#00d4ff' } = {}) {
  const reticle = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.29, 0.32, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color,
      toneMapped: false,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    }),
  );
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.012, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
  );
  reticle.add(ring, dot);
  reticle.visible = false;
  scene.add(reticle);

  let source = null;
  let state = HIT_TEST_STATES.unavailable;
  let last = null;

  return {
    reticle,
    get state() {
      return state;
    },
    /** The last level surface pose `{ position, quaternion }`, or null. */
    get surface() {
      return last;
    },
    async start(session, mixedReality) {
      this.stop();
      if (!mixedReality) return state;
      state = HIT_TEST_STATES.requested;
      const result = await requestHitTestSource(session);
      source = result.source;
      state = result.state;
      return state;
    },
    stop() {
      source?.cancel?.();
      source = null;
      last = null;
      reticle.visible = false;
      state = HIT_TEST_STATES.unavailable;
    },
    /** Read this frame's hit; `show` draws the reticle while placing. */
    update(frame, referenceSpace, show) {
      last = null;
      if (!source || !frame || !referenceSpace) {
        reticle.visible = false;
        return null;
      }
      const pose = frame.getHitTestResults(source)[0]?.getPose(referenceSpace);
      const transform = pose ? reticleFromPose(pose.transform.matrix) : null;
      if (transform && isLevelSurface(transform.quaternion)) last = transform;
      reticle.visible = !!(show && last);
      if (reticle.visible) reticle.position.copy(last.position);
      return last;
    },
  };
}
