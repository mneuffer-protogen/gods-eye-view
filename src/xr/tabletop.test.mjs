import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZOOM,
  contactHeight,
  detailZoom,
  flatness,
  tablePose,
  tileZoomFor,
} from './tabletop.js';
import {
  chooseWindow,
  lonLatToTile,
  needsRecentre,
  tilesByDistance,
  windowTiles,
} from './tileWindow.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`,
  );

test('flatness is 0 for a desk globe, 1 for a map, and rises monotonically', () => {
  assert.equal(flatness(0.24), 0);
  assert.equal(flatness(ZOOM.globeMax), 0);
  assert.equal(flatness(ZOOM.flatFrom), 1);
  assert.equal(flatness(400), 1);
  let last = 0;
  for (let r = 0.3; r < 5; r *= 1.05) {
    const u = flatness(r);
    assert.ok(u >= last, `monotonic at ${r}`);
    last = u;
  }
});

test('the focus point moves continuously as the sphere grows', () => {
  const elevation = 0.5;
  let previous = null;
  for (let r = 0.2; r < 8; r *= 1.01) {
    const pose = tablePose(r, elevation, 0.09, 0.32);
    const focus = {
      y: pose.center.y + r * pose.normal.y,
      z: pose.center.z + r * pose.normal.z,
    };
    if (previous)
      assert.ok(
        Math.hypot(focus.y - previous.y, focus.z - previous.z) < 0.03,
        `no jump at ${r}`,
      );
    previous = focus;
  }
});

test('a flat map has its focus under the table centre, facing up', () => {
  const pose = tablePose(50, 0.5, 0.09, 0.32);
  close(pose.normal.y, 1, 1e-9, 'normal is up');
  close(pose.center.y + 50, ZOOM.mapHeight, 1e-9, 'surface at map height');
  close(pose.center.z, 0, 1e-9, 'centred on the axis');
  close(pose.clipRadius, 0.32, 1e-9, 'clipped to the base');
});

test('a round globe keeps the pose the globe table always had', () => {
  const pose = tablePose(0.24, 0.3, 0.09, 0.32);
  close(pose.center.y, 0.09 + 0.24, 1e-9, 'floats over the glass');
  close(pose.center.z, 0, 1e-9, 'on the axis');
  close(pose.elevation, 0.3, 1e-9, 'view elevation untouched');
});

test('tile zoom follows the sphere size and the cosine of latitude', () => {
  assert.equal(tileZoomFor(0.12), ZOOM.minTileZoom);
  assert.equal(tileZoomFor(400), ZOOM.maxTileZoom);
  assert.ok(detailZoom(10, 0) > detailZoom(10, 70));
  assert.ok(detailZoom(20) > detailZoom(10));
  close(detailZoom(20) - detailZoom(10), 1, 1e-9, 'doubling adds one level');
});

test('aircraft stand taller on a map and still order by altitude', () => {
  for (const u of [0, 1]) {
    assert.ok(contactHeight('aircraft', 11_000, u) > contactHeight('aircraft', 500, u));
  }
  assert.ok(contactHeight('aircraft', 11_000, 1) > 0.03);
  assert.ok(contactHeight('aircraft', 11_000, 1) < 0.07);
});

test('lon/lat map to the standard slippy-map tile', () => {
  const origin = lonLatToTile(0, 0, 1);
  close(origin.x, 1, 1e-9, 'x');
  close(origin.y, 1, 1e-9, 'y');
  // Austin, TX at z10: x = (180 - 97.7431) / 360 * 1024 = 233.98, and
  // y = (1 - asinh(tan 30.2672 deg) / pi) / 2 * 1024 = 421.8.
  const austin = lonLatToTile(30.2672, -97.7431, 10);
  assert.equal(Math.floor(austin.x), 233);
  assert.equal(Math.floor(austin.y), 421);
});

test('a window is centred, kept off the poles, and wraps the antimeridian', () => {
  const w = chooseWindow(30.27, -97.74, 10);
  assert.equal(w.size, 6);
  assert.equal(windowTiles(w).length, 36);
  const polar = chooseWindow(84, 10, 5);
  assert.ok(polar.y0 >= 0);
  const wrap = chooseWindow(0, 179.9, 4);
  const columns = windowTiles(wrap).map((t) => t.x);
  assert.ok(columns.every((x) => x >= 0 && x < 16));
  assert.ok(columns.includes(15) && columns.includes(0));
  assert.equal(chooseWindow(0, 0, 1).size, 2);
});

test('a window is recentred only when the focus nears its edge or the zoom moves', () => {
  const w = chooseWindow(30.27, -97.74, 10);
  assert.equal(needsRecentre(w, 30.27, -97.74, 10), false);
  assert.equal(needsRecentre(w, 30.27, -97.74, 11), true);
  assert.equal(needsRecentre(w, 30.27, -95, 10), true);
  assert.equal(needsRecentre(null, 0, 0, 3), true);
});

test('tiles come nearest the centre first', () => {
  const ordered = tilesByDistance(chooseWindow(10, 10, 6));
  const mid = 2.5;
  const d = (t) => Math.hypot(t.col - mid, t.row - mid);
  for (let i = 1; i < ordered.length; i++)
    assert.ok(d(ordered[i]) >= d(ordered[i - 1]) - 1e-9);
});
