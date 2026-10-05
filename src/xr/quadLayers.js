/**
 * The WebXR Layers backend for sharpLayer.js: each sharp panel becomes an
 * XRQuadLayer the headset's compositor draws at display resolution, listed
 * under three.js's projection layer so the scene's holes show it.
 *
 * Needs a session with the 'layers' feature and three rendering through an
 * XRProjectionLayer (three uses one whenever the browser offers it). Where
 * either is missing, every submit answers 0 and panels draw as before.
 *
 * Layer order is a session render state, which takes effect from the next
 * frame, so a panel only cuts its hole once its layer is in that list: the
 * first frame after a panel appears draws it the ordinary way instead of
 * showing an empty hole.
 */

import * as THREE from 'three';

// Quest composites up to 16 layers; the projection layer and the system's
// own need some of them.
export const MAX_QUAD_LAYERS = 12;
// A layer not drawn for this long gives its swapchain back.
const IDLE_MS = 10_000;

const spaceMatrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

/** Whether this browser exposes the parts of WebXR Layers used here. */
export function layersSupported(globals = globalThis) {
  return (
    typeof globals.XRWebGLBinding === 'function' &&
    typeof globals.XRWebGLBinding.prototype?.createQuadLayer === 'function' &&
    typeof globals.XRRigidTransform === 'function'
  );
}

/** Mip levels for a full chain at `width` x `height`. */
export const mipLevelsFor = (width, height) =>
  Math.floor(Math.log2(Math.max(1, width, height))) + 1;

/**
 * @param {object} options
 * @param {THREE.WebGLRenderer} options.renderer
 * @param {THREE.Object3D} options.rig the reference space's origin in the scene
 * @param {object} [options.globals] for tests
 */
export function createQuadLayerBackend({
  renderer,
  rig,
  globals = globalThis,
}) {
  const entries = new Map();
  let session = null;
  let binding = null;
  let projection = null;
  let usable = false;
  let applied = [];
  let seen = new Set();

  function reset() {
    for (const entry of entries.values()) entry.layer.destroy?.();
    entries.clear();
    session = binding = projection = null;
    usable = false;
    applied = [];
    seen = new Set();
  }

  /** Bind to the current session; false when layers cannot be used. */
  function ready() {
    const current = renderer.xr.getSession?.();
    if (!current) {
      if (session) reset();
      return false;
    }
    if (current !== session) {
      reset();
      session = current;
      current.addEventListener?.('end', reset, { once: true });
      const features = current.enabledFeatures;
      usable =
        layersSupported(globals) &&
        (!Array.isArray(features) || features.includes('layers'));
    }
    if (!usable) return false;
    if (!projection) {
      const Projection = globals.XRProjectionLayer;
      projection =
        current.renderState?.layers?.find(
          (layer) =>
            typeof Projection === 'function' && layer instanceof Projection,
        ) ?? null;
      // three fell back to an XRWebGLLayer: quad layers cannot be listed.
      if (!projection) return false;
      projection.blendTextureSourceAlpha = true;
    }
    binding ??= renderer.xr.getBinding?.() ?? null;
    return !!binding && !!renderer.xr.getFrame?.();
  }

  function createLayer(width, height) {
    const gl = renderer.getContext();
    const init = {
      space: renderer.xr.getReferenceSpace(),
      viewPixelWidth: width,
      viewPixelHeight: height,
      layout: 'mono',
      isStatic: false,
      mipLevels: mipLevelsFor(width, height),
    };
    // sRGB storage so the compositor reads the canvas's colours as painted;
    // a browser without it gets plain RGBA.
    try {
      return {
        layer: binding.createQuadLayer({
          ...init,
          colorFormat: gl.SRGB8_ALPHA8,
        }),
        mipLevels: init.mipLevels,
      };
    } catch {
      return {
        layer: binding.createQuadLayer({ ...init, mipLevels: 1 }),
        mipLevels: 1,
      };
    }
  }

  /**
   * Upload a canvas into the layer. Only the texture binding is touched,
   * and restored, so three's state cache stays valid mid-frame.
   */
  function upload(entry, image) {
    const gl = renderer.getContext();
    const sub = binding.getSubImage(entry.layer, renderer.xr.getFrame());
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, sub.colorTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (entry.mipLevels > 1) gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, previous);
    entry.uploaded = true;
  }

  function release(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entry.layer.destroy?.();
    entries.delete(id);
  }

  return {
    /**
     * Show a panel's canvas this frame. `request` is `{ image, matrixWorld,
     * width, height }`; `image` is null when the layer already has it.
     * Returns 0 (draw normally), 1 (the layer shows it), 2 (send pixels),
     * or 3 (pixels taken; the layer shows from the next frame, so draw
     * normally for now).
     */
    submit(id, { image, matrixWorld, width, height }) {
      if (!ready()) return 0;
      let entry = entries.get(id);
      if (
        entry &&
        image &&
        (entry.pixelWidth !== image.width || entry.pixelHeight !== image.height)
      ) {
        release(id);
        entry = null;
      }
      if (!entry) {
        if (!image) return 2;
        if (entries.size >= MAX_QUAD_LAYERS) return 0;
        const created = createLayer(image.width, image.height);
        entry = {
          ...created,
          pixelWidth: image.width,
          pixelHeight: image.height,
          uploaded: false,
          seenAt: 0,
        };
        entries.set(id, entry);
      }
      if (image) upload(entry, image);
      else if (!entry.uploaded || entry.layer.needsRedraw) return 2;
      // The reference space's origin is the rig: a mesh's pose in it is
      // rig^-1 * mesh.
      spaceMatrix.copy(rig.matrixWorld).invert().multiply(matrixWorld);
      spaceMatrix.decompose(position, quaternion, scale);
      entry.layer.transform = new globals.XRRigidTransform(
        { x: position.x, y: position.y, z: position.z },
        { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
      );
      entry.layer.width = width;
      entry.layer.height = height;
      entry.seenAt = performance.now();
      seen.add(id);
      return applied.includes(entry.layer) ? 1 : 3;
    },
    release,
    /**
     * Once per frame, before rendering: list the layers drawn last frame
     * under the projection layer, and free ones idle for a while.
     */
    sync() {
      if (!ready()) {
        seen = new Set();
        return;
      }
      const wanted = [...entries]
        .filter(([id]) => seen.has(id))
        .map(([, entry]) => entry.layer);
      seen = new Set();
      if (
        wanted.length !== applied.length ||
        wanted.some((layer, i) => layer !== applied[i])
      ) {
        session.updateRenderState({ layers: [...wanted, projection] });
        applied = wanted;
      }
      const now = performance.now();
      for (const [id, entry] of entries)
        if (!applied.includes(entry.layer) && now - entry.seenAt > IDLE_MS)
          release(id);
    },
    get count() {
      return applied.length;
    },
  };
}
