/**
 * The tabletop map: a round window onto the ground, set in a frosted-glass
 * rim, standing on the same carried table as the globe.
 *
 *   group            sits on the table; the globe's table carries it
 *   ├─ frame         glass rim, compass ring, rim text, earth block
 *   ├─ site          site metres (x east, y up, z south); its transform is
 *   │  └─ terrain    the view: scaled, turned and shifted under the window
 *   └─ contacts      live traffic in table metres (mapContacts.js)
 *
 * The window is cut with clipping planes recomputed from the table's world
 * pose every frame (four straight planes that circleClip.js turns into a
 * circle, and a floor), so the map pans under the rim without spilling off
 * it. The compass ring turns with the map so it always shows north.
 */

import * as THREE from 'three';
import { createGlassWorkspace } from './framework/workspace.js';
import { installCircleClip } from './circleClip.js';
import {
  clampSpan,
  reliefFor,
  scaleOf,
  solveGrab,
  toSite,
  toTable,
  zoomAbout,
} from './mapView.js';

installCircleClip();

export const MAP_TABLE = Object.freeze({
  // The round map's diameter and the glass rim around it, in metres: sized
  // for a real desk rather than a floor-standing table.
  window: 0.8,
  rim: 0.12,
  // The earth block's depth under the map surface.
  depthUnder: 0.06,
  // How far outside the rim a hand still takes hold of it.
  grabReach: 0.07,
  // A hand up to this high over the map reaches it directly.
  reachAbove: 0.3,
  defaultSpan: 250_000,
});

const UP = new THREE.Vector3(0, 1, 0);
const NORTH = '#ff5a6e';

/** Whether a table-local point is on the rim, where a hand carries the table. */
export function onMapRim(p, table = MAP_TABLE) {
  const inner = table.window / 2;
  const r = Math.hypot(p.x, p.z);
  return (
    r >= inner - 0.02 &&
    r <= inner + table.rim + table.grabReach &&
    p.y > -table.depthUnder - table.grabReach &&
    p.y < table.grabReach * 1.6
  );
}

/** Text set along a ring canvas; `near` reads along the viewer's side. */
function arcText(context, text, radius, near, maxArc, font, size) {
  context.font = font(size);
  const width = context.measureText(text).width;
  if (width > maxArc * radius)
    context.font = font(Math.floor((size * maxArc * radius) / width));
  const total = context.measureText(text).width;
  let along = -total / 2;
  for (const character of text) {
    const advance = context.measureText(character).width;
    const angle = near
      ? Math.PI - (along + advance / 2) / radius
      : (along + advance / 2) / radius;
    context.save();
    context.translate(Math.sin(angle) * radius, -Math.cos(angle) * radius);
    context.rotate(near ? angle + Math.PI : angle);
    context.fillText(character, 0, 0);
    context.restore();
    along += advance;
  }
}

/**
 * Build the map table. `brand` supplies colours and fonts.
 */
export function createMapTable({ brand }) {
  const T = MAP_TABLE;
  const group = new THREE.Group();
  group.name = 'Map table';
  // The map surface stands the earth block's depth over the table's glass.
  group.position.y = T.depthUnder + 0.004;
  const frame = new THREE.Group();
  group.add(frame);
  const outer = T.window / 2 + T.rim;
  const base = -T.depthUnder;

  const glass = createGlassWorkspace({
    width: outer * 2,
    depth: outer * 2,
    radius: outer,
    border: 0.05,
    baseAlpha: 0.16,
    borderAlpha: 0.34,
  });
  glass.mesh.name = 'Map glass';
  glass.mesh.position.y = base - 0.002;
  frame.add(glass.mesh);
  const accentRing = new THREE.Mesh(
    new THREE.TorusGeometry(outer - 0.004, 0.0035, 8, 160).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: brand.colors.accent,
      toneMapped: false,
      transparent: true,
      opacity: 0.85,
    }),
  );
  accentRing.position.y = base;
  frame.add(accentRing);

  // The earth block: a floor and one wall round the circle, re-cut to the
  // ground at the window's edge whenever the view changes (updateSides), so
  // the map reads as a slice of land rather than a sheet.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(T.window / 2, 96).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: '#2c241c' }),
  );
  floor.position.y = base;
  frame.add(floor);
  const SAMPLES = 256;
  const wall = (() => {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array((SAMPLES + 1) * 2 * 3);
    const colors = new Float32Array((SAMPLES + 1) * 2 * 3);
    const top = new THREE.Color('#6f5a3f');
    const deep = new THREE.Color('#2a2018');
    for (let i = 0; i <= SAMPLES; i++) {
      top.toArray(colors, i * 6);
      deep.toArray(colors, i * 6 + 3);
    }
    const index = [];
    for (let i = 0; i < SAMPLES; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(index);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
      }),
    );
    mesh.frustumCulled = false;
    frame.add(mesh);
    return mesh;
  })();

  // The compass ring turns with the map; the text ring stays put, with the
  // credits along the near side and the view's place and scale along the far.
  const ringOuter = outer - 0.008;
  const PX = 1024 / ringOuter;
  const font = (px, weight = 500) =>
    `${weight} ${px}px "${brand.fonts.body.family}"`;
  const ringMesh = (name, y) => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(T.window / 2, ringOuter, 160, 1).rotateX(
        -Math.PI / 2,
      ),
      new THREE.MeshBasicMaterial({
        transparent: true,
        toneMapped: false,
        depthWrite: false,
      }),
    );
    mesh.name = name;
    mesh.position.y = y;
    mesh.renderOrder = 2;
    frame.add(mesh);
    return mesh;
  };
  const compass = ringMesh('Compass', base + 0.001);
  const rimText = ringMesh('Rim text', base + 0.0012);
  const newCanvas = () =>
    Object.assign(document.createElement('canvas'), {
      width: 2048,
      height: 2048,
    });
  const setTexture = (mesh, canvas) => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    mesh.material.map?.dispose();
    mesh.material.map = texture;
    mesh.material.needsUpdate = true;
  };
  function drawCompass() {
    const canvas = newCanvas();
    const c = canvas.getContext('2d');
    const R = T.window / 2;
    c.translate(1024, 1024);
    c.lineCap = 'round';
    for (let b = 0; b < 360; b += 5) {
      const long = b % 30 === 0;
      const mid = b % 10 === 0;
      const length = (long ? 0.02 : mid ? 0.012 : 0.007) * PX;
      const r0 = (R + 0.005) * PX;
      c.lineWidth = long ? 4 : 2.5;
      c.strokeStyle = b === 0 ? NORTH : brand.colors.text;
      c.globalAlpha = long || b === 0 ? 0.95 : 0.6;
      c.save();
      c.rotate((b * Math.PI) / 180);
      c.beginPath();
      c.moveTo(0, -r0);
      c.lineTo(0, -r0 - length);
      c.stroke();
      c.restore();
    }
    c.globalAlpha = 1;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let b = 0; b < 360; b += 30) {
      const cardinal = b % 90 === 0;
      c.save();
      c.rotate((b * Math.PI) / 180);
      c.translate(0, -(R + (cardinal ? 0.05 : 0.044)) * PX);
      c.fillStyle = b === 0 ? NORTH : brand.colors.text;
      c.font = font(
        Math.round((cardinal ? 0.03 : 0.018) * PX),
        cardinal ? 700 : 500,
      );
      c.fillText(cardinal ? 'NESW'[b / 90] : String(b), 0, 0);
      c.restore();
    }
    setTexture(compass, canvas);
  }
  const words = { credits: '', note: '' };
  function drawRimText() {
    const canvas = newCanvas();
    const c = canvas.getContext('2d');
    const r = ((T.window / 2 + 0.082 + ringOuter) / 2) * PX;
    c.translate(1024, 1024);
    c.fillStyle = brand.colors.text;
    c.globalAlpha = 0.85;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const size = Math.round(0.014 * PX);
    if (words.credits) arcText(c, words.credits, r, true, 2.6, font, size);
    if (words.note) arcText(c, words.note, r, false, 1.6, font, size);
    setTexture(rimText, canvas);
  }
  drawCompass();
  drawRimText();

  const site = new THREE.Group();
  site.name = 'Site';
  group.add(site);
  const contactRoot = new THREE.Group();
  contactRoot.name = 'Map contacts';
  group.add(contactRoot);

  // Shared by every clipped material; three.js reads them each frame.
  const planes = Array.from({ length: 5 }, () => new THREE.Plane());
  const state = {
    view: { cx: 0, cz: 0, span: T.defaultSpan, yaw: 0 },
    // The site's own ground under the centre, eased so a pan across a hill
    // does not make the whole map bob.
    lift: 0,
  };

  function applyView() {
    const s = scaleOf(state.view, T.window);
    const relief = reliefFor(state.view.span);
    site.scale.set(s, s * relief, s);
    site.rotation.set(0, state.view.yaw, 0);
    compass.rotation.y = state.view.yaw;
    const offset = new THREE.Vector3(
      -state.view.cx * s,
      0,
      -state.view.cz * s,
    ).applyAxisAngle(UP, state.view.yaw);
    site.position.set(offset.x, -state.lift * s * relief, offset.z);
    site.updateMatrix();
  }

  const LOCAL_PLANES = [
    [1, 0, 0, -T.window / 2],
    [-1, 0, 0, -T.window / 2],
    [0, 0, 1, -T.window / 2],
    [0, 0, -1, -T.window / 2],
    [0, 1, 0, -T.depthUnder + 0.004],
  ];
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  function updatePlanes() {
    group.updateMatrixWorld(true);
    LOCAL_PLANES.forEach(([x, y, z, w], i) => {
      // Each normal points inward through its edge: (1,0,0) through x = -h
      // keeps x >= -h.
      normal.set(x, y, z);
      point.copy(normal).multiplyScalar(w);
      planes[i]
        .setFromNormalAndCoplanarPoint(normal, point)
        .applyMatrix4(group.matrixWorld);
    });
  }
  applyView();
  updatePlanes();

  const local = new THREE.Vector3();
  return {
    group,
    frame,
    site,
    contactRoot,
    glass,
    planes,
    get view() {
      return state.view;
    },
    setView(view) {
      state.view = { ...view, span: clampSpan(view.span) };
      applyView();
    },
    /** Table metres per site metre. */
    get scale() {
      return scaleOf(state.view, T.window);
    },
    get relief() {
      return reliefFor(state.view.span);
    },
    /** Site metres around the centre the terrain should cover. */
    get radius() {
      return state.view.span * 0.72;
    },
    /**
     * Table-local height of a site height (metres above the origin's
     * ground), on the same vertical scale as the terrain.
     */
    heightOnTable(siteHeight) {
      const s = scaleOf(state.view, T.window);
      return (siteHeight - state.lift) * s * reliefFor(state.view.span);
    },
    /** Ease the ground under the centre toward `height` (site metres). */
    setGround(height, dt = 1) {
      state.lift += (height - state.lift) * Math.min(1, dt * 3);
      applyView();
    },
    /** A world point in table coordinates `{ x, y, z }`. */
    tablePoint(world) {
      group.updateMatrixWorld(true);
      const p = group.worldToLocal(local.copy(world));
      return { x: p.x, y: p.y, z: p.z };
    },
    toSite(tablePoint) {
      return toSite(state.view, T.window, tablePoint);
    },
    toTable(sitePoint) {
      return toTable(state.view, T.window, sitePoint);
    },
    /** Whether a table point is over the round window. */
    over(tablePoint, margin = 0) {
      return Math.hypot(tablePoint.x, tablePoint.z) <= T.window / 2 + margin;
    },
    /** Whether a world point is on the rim, where a hand carries the table. */
    onRim(world) {
      return onMapRim(this.tablePoint(world));
    },
    /**
     * Where a world ray meets the map surface (table-local y = 0), as a
     * table point, or null when it points away or misses the window.
     */
    rayPoint(origin, direction, margin = 0) {
      group.updateMatrixWorld(true);
      const o = group.worldToLocal(local.copy(origin));
      const end = group.worldToLocal(
        new THREE.Vector3().copy(origin).add(direction),
      );
      const dy = end.y - o.y;
      if (Math.abs(dy) < 1e-6) return null;
      const t = -o.y / dy;
      if (t < 0) return null;
      const hit = {
        x: o.x + (end.x - o.x) * t,
        y: 0,
        z: o.z + (end.z - o.z) * t,
      };
      return this.over(hit, margin) ? hit : null;
    },
    solve(holds) {
      state.view = solveGrab(state.view, T.window, holds);
      applyView();
    },
    zoom(tablePoint, factor) {
      state.view = zoomAbout(state.view, T.window, tablePoint, factor);
      applyView();
    },
    /** Refresh the clipping planes from the table's pose; every frame. */
    update() {
      updatePlanes();
    },
    /**
     * Re-cut the earth wall to the ground at the window's edge.
     * `surface(x, z)` is the table-local height at a table point.
     */
    updateSides(surface) {
      const h = T.window / 2;
      const p = wall.geometry.attributes.position;
      for (let i = 0; i <= SAMPLES; i++) {
        const t = (i / SAMPLES) * Math.PI * 2;
        const x = Math.cos(t) * h;
        const z = Math.sin(t) * h;
        const y = Math.min(0.2, Math.max(base, surface(x, z)));
        p.setXYZ(i * 2, x, y, z);
        p.setXYZ(i * 2 + 1, x, base, z);
      }
      p.needsUpdate = true;
      wall.geometry.computeVertexNormals();
      wall.geometry.computeBoundingSphere();
    },
    setHands(points) {
      glass.setHands(points, group);
    },
    /** The credits the imagery and data terms require, along the near rim. */
    setCredits(text) {
      if ((text || '') === words.credits) return;
      words.credits = text || '';
      drawRimText();
    },
    /** A line along the far rim: where the map is and how wide. */
    setNote(text) {
      if ((text || '') === words.note) return;
      words.note = text || '';
      drawRimText();
    },
  };
}
