/**
 * Crisp in-scene panels. A canvas-textured plane drawn by three.js is
 * rasterised into the eye buffer at the eye buffer's resolution and then
 * resampled again by the lens warp, so its text goes soft. A compositor
 * layer is sampled once, at display resolution, so it stays sharp. This
 * gives a panel that treatment without losing depth occlusion:
 *
 *  - the headset composites the panel's canvas as a world-locked quad layer
 *    UNDER the scene (quadLayers.js);
 *  - the panel still renders in the scene, in its normal place in the draw
 *    order, but as a hole: colour scaled by (1 - alpha), alpha 0, so the
 *    compositor shows the layer through it;
 *  - anything in front of the panel wins the depth test and stays opaque,
 *    so a hand or the globe still covers it. Anything drawn over it later
 *    (hover highlights, the pointer ray) blends over the layer.
 *
 * The mesh falls back to ordinary rendering, frame by frame, whenever the
 * layer cannot match it: not presenting, no layer support, seen from
 * behind, fading, in fog, or over the layer budget. Only a PlaneGeometry
 * with an unrotated, unrepeated canvas map qualifies.
 *
 * Adapted from a sharp-UI helper for a native Quest runtime; here the
 * backend is the browser's WebXR Layers API.
 */

import * as THREE from 'three';

const HOLE = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendEquationAlpha: THREE.AddEquation,
  blendSrc: THREE.ZeroFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.ZeroFactor,
};
const KEYS = Object.keys(HOLE);
// While a layer stands in for a panel, the mesh draws through one opaque
// texel rather than its canvas: the hole needs only the outline, and binding
// the canvas would upload all of it each time it changes.
let holeMask = null;
const hole = () =>
  (holeMask ??= Object.assign(
    new THREE.DataTexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      THREE.RGBAFormat,
    ),
    {
      needsUpdate: true,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
      generateMipmaps: false,
    },
  ));
const WHITE = new THREE.Color(1, 1, 1);
const rel = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const normal = new THREE.Vector3();
let serial = 0;

/** Whether this kind of mesh can ever be shown as a layer. */
export function qualifies(mesh) {
  return !!(
    mesh?.isMesh &&
    mesh.geometry?.type === 'PlaneGeometry' &&
    mesh.material?.isMeshBasicMaterial
  );
}

/**
 * Whether the material, as it is now, draws exactly the canvas a layer
 * would show. Checked every frame: a panel replaces its texture when it
 * grows.
 */
export function drawsCanvas(material) {
  const map = material.map;
  return !!(
    map?.image?.width &&
    map.image.height &&
    map.flipY &&
    map.rotation === 0 &&
    map.offset.x === 0 &&
    map.offset.y === 0 &&
    map.repeat.x === 1 &&
    map.repeat.y === 1 &&
    !material.vertexColors &&
    !material.alphaMap &&
    material.color.equals(WHITE) &&
    material.opacity >= 0.999
  );
}

/**
 * Whether a plane mesh faces the eye: a layer has no back face to match,
 * and a mirrored mesh cannot be matched either.
 */
export function facesEye(mesh, eye) {
  rel.copy(eye.matrixWorld).invert().multiply(mesh.matrixWorld);
  if (rel.determinant() <= 0) return false;
  rel.decompose(position, quaternion, scale);
  normal.set(0, 0, 1).applyQuaternion(quaternion);
  return normal.dot(position) < 0;
}

/** A plane mesh's size in metres. */
export function planeSize(mesh) {
  mesh.matrixWorld.decompose(position, quaternion, scale);
  const { width = 1, height = 1 } = mesh.geometry.parameters ?? {};
  return { width: width * scale.x, height: height * scale.y };
}

function fogged(scene, material) {
  return !!(scene?.fog && material.fog);
}

// Every layer in use, so one call before a frame is drawn can upload what
// changed in all of them: pixels never travel in the middle of the
// eye-buffer pass.
const layers = new Set();
export function prepareSharpLayers(renderer, scene) {
  for (const layer of layers) {
    try {
      layer.prepare(renderer, scene);
    } catch (error) {
      console.warn('[sharp-layer]', error?.message || error);
    }
  }
}
const shown = (mesh) => {
  for (let o = mesh; o; o = o.parent) if (!o.visible) return false;
  return true;
};

const INACTIVE = Object.freeze({
  active: false,
  prepare() {},
  dispose() {},
});

/**
 * Show `mesh` as a compositor layer whenever it can be.
 * @param {THREE.Mesh} mesh a canvas-textured plane
 * @param {{ backend: { submit: Function, release: Function } | null }} options
 *   `backend.submit(id, request)` returns 0 (cannot: draw normally), 1 (the
 *   layer shows it), 2 (the layer lost its pixels: send them again), or 3
 *   (pixels taken, shown from the next frame: draw normally for now).
 */
export function sharpLayer(mesh, { backend } = {}) {
  if (!backend || !qualifies(mesh)) return INACTIVE;
  const id = ++serial;
  const material = mesh.material;
  // Fully transparent texels draw nothing either way; discarding them keeps
  // the hole to the texture's shape, so a rounded corner does not cut the
  // scene behind it out to passthrough.
  material.alphaTest = Math.max(material.alphaTest, 1 / 255);
  const saved = {};
  const previousBefore = mesh.onBeforeRender;
  const previousAfter = mesh.onAfterRender;
  let frame = -1;
  let active = false;
  let sentMap = null;
  let sentVersion = -1;

  function submit(renderer, scene) {
    if (
      !renderer.xr?.isPresenting ||
      mesh.material !== material ||
      !drawsCanvas(material) ||
      fogged(scene, material)
    )
      return false;
    const eye = renderer.xr.getCamera().cameras?.[0];
    if (!eye || !facesEye(mesh, eye)) return false;
    const map = material.map;
    const fresh = map !== sentMap || map.version !== sentVersion;
    const { width, height } = planeSize(mesh);
    const request = (image) => ({
      image,
      matrixWorld: mesh.matrixWorld,
      width,
      height,
    });
    let code = backend.submit(id, request(fresh ? map.image : null));
    // The layer was recreated or its pixels were dropped.
    if (code === 2) code = backend.submit(id, request(map.image));
    if ((code === 1 || code === 3) && fresh) {
      sentMap = map;
      sentVersion = map.version;
    }
    return code === 1;
  }

  mesh.onBeforeRender = function (
    renderer,
    scene,
    camera,
    geometry,
    mat,
    group,
  ) {
    previousBefore.call(this, renderer, scene, camera, geometry, mat, group);
    // Once per frame: each eye renders the mesh, and the layer serves both.
    const f = renderer.info.render.frame;
    if (f !== frame) {
      frame = f;
      try {
        active = submit(renderer, scene);
      } catch (error) {
        active = false;
        console.warn('[sharp-layer]', error?.message || error);
      }
    }
    // While the layer stands in, the canvas texture is not bound, so three
    // skips its upload; its version still moved, so a fallback frame uploads
    // what was painted.
    if (active) {
      for (const key of KEYS) {
        saved[key] = material[key];
        material[key] = HOLE[key];
      }
      saved.map = material.map;
      material.map = hole();
    }
  };
  mesh.onAfterRender = function (...args) {
    if (active) {
      for (const key of KEYS) material[key] = saved[key];
      material.map = saved.map;
    }
    previousAfter.apply(this, args);
  };

  const layer = {
    get active() {
      return active;
    },
    /** Send what changed before the frame is drawn. */
    prepare(renderer, scene) {
      if (!renderer.xr?.isPresenting || !shown(mesh) || !material.map) return;
      if (material.map === sentMap && material.map.version === sentVersion)
        return;
      mesh.updateWorldMatrix(true, false);
      submit(renderer, scene);
    },
    dispose() {
      layers.delete(layer);
      mesh.onBeforeRender = previousBefore;
      mesh.onAfterRender = previousAfter;
      backend.release(id);
    },
  };
  layers.add(layer);
  return layer;
}
