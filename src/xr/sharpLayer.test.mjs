import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { qualifies, sharpLayer } from './sharpLayer.js';
import {
  MAX_QUAD_LAYERS,
  createQuadLayerBackend,
  layersSupported,
  mipLevelsFor,
} from './quadLayers.js';

const near = (a, b, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ≉ ${b}`);
// A canvas stand-in: only its size is read, and it is handed on.
const canvas = (width = 512, height = 256) => ({ width, height });

function panel({ width = 0.6, height = 0.3 } = {}) {
  const texture = new THREE.Texture(canvas());
  texture.needsUpdate = true;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true }),
  );
  mesh.scale.set(width, height, 1);
  mesh.position.set(0, 1.4, -1);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Just enough of a renderer presenting a stereo session. */
function renderer({ presenting = true } = {}) {
  const eye = new THREE.PerspectiveCamera();
  eye.position.set(-0.03, 1.6, 0);
  eye.updateMatrixWorld(true);
  return {
    info: { render: { frame: 1 } },
    xr: { isPresenting: presenting, getCamera: () => ({ cameras: [eye, eye] }) },
    eye,
  };
}

function backend(reply = () => 1) {
  const calls = [];
  const released = [];
  return {
    calls,
    released,
    submit(id, request) {
      calls.push({ id, ...request });
      return reply(calls.length);
    },
    release(id) {
      released.push(id);
    },
  };
}

const draw = (mesh, r, scene = new THREE.Scene()) => {
  mesh.onBeforeRender(r, scene, r.eye, mesh.geometry, mesh.material, null);
  const during = {
    blending: mesh.material.blending,
    blendDst: mesh.material.blendDst,
    blendDstAlpha: mesh.material.blendDstAlpha,
    map: mesh.material.map,
  };
  mesh.onAfterRender(r, scene, r.eye, mesh.geometry, mesh.material, null);
  return during;
};

test('without a backend a panel is left alone', () => {
  const mesh = panel();
  const before = mesh.onBeforeRender;
  const sharp = sharpLayer(mesh, { backend: null });
  assert.equal(mesh.onBeforeRender, before);
  assert.equal(sharp.active, false);
  assert.equal(
    qualifies(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial())),
    false,
  );
});

test('a shown panel goes to its layer and draws as a hole that keeps depth order', () => {
  const mesh = panel();
  const b = backend();
  const sharp = sharpLayer(mesh, { backend: b });
  const map = mesh.material.map;
  const during = draw(mesh, renderer());
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].image, map.image, 'first sight sends the canvas');
  near(b.calls[0].width, 0.6);
  near(b.calls[0].height, 0.3);
  assert.equal(during.blending, THREE.CustomBlending);
  assert.equal(during.blendDst, THREE.OneMinusSrcAlphaFactor);
  assert.equal(during.blendDstAlpha, THREE.ZeroFactor);
  assert.notEqual(during.map, map, 'the hole draws through one texel');
  assert.equal(mesh.material.blending, THREE.NormalBlending, 'restored after');
  assert.equal(mesh.material.map, map);
  assert.ok(mesh.material.alphaTest > 0);
  assert.equal(sharp.active, true);
  sharp.dispose();
  assert.deepEqual(b.released, [b.calls[0].id]);
});

test('pixels travel only when the canvas changes, once per frame for both eyes', () => {
  const mesh = panel();
  const b = backend();
  sharpLayer(mesh, { backend: b });
  const r = renderer();
  draw(mesh, r);
  draw(mesh, r);
  assert.equal(b.calls.length, 1);
  r.info.render.frame++;
  draw(mesh, r);
  assert.equal(b.calls[1].image, null, 'an unchanged canvas is not re-sent');
  mesh.material.map.needsUpdate = true;
  r.info.render.frame++;
  draw(mesh, r);
  assert.equal(b.calls[2].image, mesh.material.map.image, 'a repaint is re-sent');
});

test('pixels taken for a layer not yet listed are not sent again', () => {
  const mesh = panel();
  const b = backend((n) => (n === 1 ? 3 : 1));
  sharpLayer(mesh, { backend: b });
  const r = renderer();
  const first = draw(mesh, r);
  assert.equal(first.blending, THREE.NormalBlending, 'drawn normally meanwhile');
  r.info.render.frame++;
  const second = draw(mesh, r);
  assert.equal(b.calls[1].image, null);
  assert.equal(second.blending, THREE.CustomBlending);
});

test('a layer that lost its pixels gets them again in the same frame', () => {
  const mesh = panel();
  const b = backend((n) => (n === 2 ? 2 : 1));
  sharpLayer(mesh, { backend: b });
  const r = renderer();
  draw(mesh, r);
  r.info.render.frame++;
  draw(mesh, r);
  assert.equal(b.calls.length, 3);
  assert.equal(b.calls[2].image, mesh.material.map.image);
});

test('the panel draws normally whenever a layer cannot stand in for it', () => {
  const cases = {
    'not presenting': () => renderer({ presenting: false }),
    'seen from behind': (mesh) => {
      mesh.rotation.y = Math.PI;
      mesh.updateMatrixWorld(true);
    },
    fading: (mesh) => {
      mesh.material.opacity = 0.5;
    },
    'backend refuses': () => undefined,
  };
  for (const [name, setup] of Object.entries(cases)) {
    const mesh = panel();
    const b = backend(() => (name === 'backend refuses' ? 0 : 1));
    sharpLayer(mesh, { backend: b });
    const r = setup(mesh) || renderer();
    const during = draw(mesh, r);
    assert.equal(during.blending, THREE.NormalBlending, name);
  }
});

// --- the WebXR Layers backend ------------------------------------------------

function fakeXR({ features = ['layers'], projectionLayer = true } = {}) {
  class XRProjectionLayer {}
  class XRRigidTransform {
    constructor(position, orientation) {
      Object.assign(this, { position, orientation });
    }
  }
  const created = [];
  class XRWebGLBinding {
    createQuadLayer(init) {
      const layer = {
        init,
        needsRedraw: false,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      created.push(layer);
      return layer;
    }
    getSubImage() {
      return { colorTexture: { texture: true } };
    }
  }
  const projection = projectionLayer ? new XRProjectionLayer() : {};
  const states = [];
  const session = {
    enabledFeatures: features,
    renderState: { layers: [projection] },
    updateRenderState(state) {
      states.push(state);
    },
    addEventListener() {},
  };
  const gl = new Proxy(
    { calls: [], SRGB8_ALPHA8: 'srgb', TEXTURE_2D: 't2d', RGBA: 'rgba' },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => target.calls.push([key, ...args]);
      },
    },
  );
  const binding = new XRWebGLBinding();
  const renderer = {
    getContext: () => gl,
    xr: {
      getSession: () => session,
      getBinding: () => binding,
      getFrame: () => ({}),
      getReferenceSpace: () => ({ space: true }),
    },
  };
  return {
    globals: { XRWebGLBinding, XRProjectionLayer, XRRigidTransform },
    created,
    states,
    projection,
    renderer,
    gl,
  };
}

const request = (image = canvas()) => {
  const matrixWorld = new THREE.Matrix4().makeTranslation(0.2, 1.4, -1);
  return { image, matrixWorld, width: 0.6, height: 0.3 };
};

test('layers support is read from the browser', () => {
  assert.equal(layersSupported({}), false);
  assert.equal(layersSupported(fakeXR().globals), true);
  assert.equal(mipLevelsFor(1024, 512), 11);
});

test('a quad layer is created, filled and listed under the projection layer', () => {
  const xr = fakeXR();
  const rig = new THREE.Group();
  rig.position.set(0, 0, 0.5);
  rig.updateMatrixWorld(true);
  const quads = createQuadLayerBackend({ renderer: xr.renderer, rig, globals: xr.globals });
  assert.equal(quads.submit(1, request()), 3, 'not listed yet: draw normally');
  const [layer] = xr.created;
  assert.equal(layer.init.colorFormat, 'srgb');
  assert.equal(layer.init.viewPixelWidth, 512);
  assert.ok(xr.gl.calls.some(([name]) => name === 'texSubImage2D'));
  near(layer.width, 0.6);
  near(layer.height, 0.3);
  // In the reference space: the rig is the origin.
  near(layer.transform.position.z, -1.5);
  quads.sync();
  assert.deepEqual(xr.states.at(-1).layers, [layer, xr.projection]);
  assert.equal(quads.submit(1, request(null)), 1, 'listed: cut the hole');
  quads.sync();
  assert.equal(xr.states.length, 1, 'an unchanged list is not re-sent');
  // Not drawn for a frame: it leaves the list.
  quads.sync();
  assert.deepEqual(xr.states.at(-1).layers, [xr.projection]);
});

test('a resized canvas replaces its layer; a lost one asks for pixels', () => {
  const xr = fakeXR();
  const quads = createQuadLayerBackend({ renderer: xr.renderer, rig: new THREE.Group(), globals: xr.globals });
  quads.submit(1, request());
  quads.submit(1, request(canvas(512, 512)));
  assert.equal(xr.created.length, 2);
  assert.equal(xr.created[0].destroyed, true);
  xr.created[1].needsRedraw = true;
  assert.equal(quads.submit(1, request(null)), 2);
});

test('without the layers feature or a projection layer, panels draw as before', () => {
  for (const options of [{ features: [] }, { projectionLayer: false }]) {
    const xr = fakeXR(options);
    const quads = createQuadLayerBackend({ renderer: xr.renderer, rig: new THREE.Group(), globals: xr.globals });
    assert.equal(quads.submit(1, request()), 0);
    assert.equal(xr.created.length, 0);
  }
  const quads = createQuadLayerBackend({
    renderer: { xr: { getSession: () => null } },
    rig: new THREE.Group(),
    globals: {},
  });
  assert.equal(quads.submit(1, request()), 0);
});

test('the layer budget is respected', () => {
  const xr = fakeXR();
  const quads = createQuadLayerBackend({ renderer: xr.renderer, rig: new THREE.Group(), globals: xr.globals });
  for (let id = 1; id <= MAX_QUAD_LAYERS; id++) assert.equal(quads.submit(id, request()), 3);
  assert.equal(quads.submit(MAX_QUAD_LAYERS + 1, request()), 0);
});
