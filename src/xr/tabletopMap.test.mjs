import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIEW_LIMITS,
  clampSpan,
  reliefFor,
  solveGrab,
  toSite,
  toTable,
  zoomAbout,
} from './mapView.js';
import {
  coverTiles,
  createFrame,
  decodeTerrarium,
  lonLatToTile,
  tileToLonLat,
  zoomForSpan,
} from './mapGeo.js';
import { mapContactPose, MAP_MARKERS } from './mapContacts.js';
import { MAP_TABLE, onMapRim } from './mapTable.js';
import { ease, stepAmount } from './viewSwitch.js';
import { formatSpan } from './tabletopView.js';

const WINDOW = 0.8;
const near = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} ≉ ${b}`);

test('table and site coordinates are inverse, at any yaw and span', () => {
  const view = { cx: 1200, cz: -450, span: 30_000, yaw: 0.7 };
  const site = { x: 4100, z: 2300 };
  const back = toSite(view, WINDOW, toTable(view, WINDOW, site));
  near(back.x, site.x, 1e-6);
  near(back.z, site.z, 1e-6);
  const centre = toTable(view, WINDOW, { x: view.cx, z: view.cz });
  near(centre.x, 0);
  near(centre.z, 0);
});

test('one hand pans: the grabbed ground stays under the hand', () => {
  const view = { cx: 0, cz: 0, span: 100_000, yaw: 0.3 };
  const anchor = toSite(view, WINDOW, { x: 0.1, z: 0.05 });
  const hand = { x: -0.15, z: 0.2 };
  const next = solveGrab(view, WINDOW, [{ anchor, hand }]);
  const under = toTable(next, WINDOW, anchor);
  near(under.x, hand.x, 1e-9);
  near(under.z, hand.z, 1e-9);
  assert.equal(next.span, view.span);
  assert.equal(next.yaw, view.yaw);
});

test('two hands zoom and turn with their spread, keeping both anchors under them', () => {
  const view = { cx: 0, cz: 0, span: 100_000, yaw: 0 };
  const a = toSite(view, WINDOW, { x: -0.1, z: 0 });
  const b = toSite(view, WINDOW, { x: 0.1, z: 0 });
  // Pull apart to twice the gap and turn a quarter.
  const holds = [
    { anchor: a, hand: { x: 0, z: -0.2 } },
    { anchor: b, hand: { x: 0, z: 0.2 } },
  ];
  const next = solveGrab(view, WINDOW, holds);
  near(next.span, 50_000, 1e-6);
  for (const { anchor, hand } of holds) {
    const under = toTable(next, WINDOW, anchor);
    near(under.x, hand.x, 1e-9);
    near(under.z, hand.z, 1e-9);
  }
  // Hands together say nothing about spread: the view holds.
  const steady = solveGrab(view, WINDOW, [
    { anchor: a, hand: { x: 0, z: 0 } },
    { anchor: b, hand: { x: 0.01, z: 0 } },
  ]);
  assert.deepEqual(steady, view);
});

test('zoom keeps the ground under the pointer and stays inside the limits', () => {
  const view = { cx: 500, cz: 500, span: 200_000, yaw: 0.4 };
  const point = { x: 0.2, z: -0.1 };
  const before = toSite(view, WINDOW, point);
  const next = zoomAbout(view, WINDOW, point, 0.5);
  near(next.span, 100_000);
  const after = toSite(next, WINDOW, point);
  near(after.x, before.x, 1e-6);
  near(after.z, before.z, 1e-6);
  assert.equal(clampSpan(1), VIEW_LIMITS.minSpan);
  assert.equal(clampSpan(1e12), VIEW_LIMITS.maxSpan);
});

test('relief is true up close and exaggerated, within bounds, as the view widens', () => {
  assert.equal(reliefFor(1000), 1);
  assert.ok(reliefFor(250_000) > 1);
  assert.equal(reliefFor(VIEW_LIMITS.maxSpan), 5);
});

test('the local frame is metres east and south of its origin, and inverts', () => {
  const frame = createFrame(-97.74, 30.27);
  const p = frame.toScene(-97.64, 30.37);
  assert.ok(p.x > 9_000 && p.x < 10_000, 'east is +x');
  near(p.z, -0.1 * 111_320, 1e-6);
  const back = frame.fromScene(p.x, p.z);
  near(back.lon, -97.64, 1e-9);
  near(back.lat, 30.37, 1e-9);
  // Across the antimeridian the short way round.
  const fiji = createFrame(179.9, -17);
  assert.ok(Math.abs(fiji.toScene(-179.9, -17).x) < 30_000);
  near(fiji.fromScene(fiji.toScene(-179.9, -17).x, 0).lon, -179.9, 1e-9);
  assert.throws(() => createFrame(0, 89));
});

test('tile maths round-trips and picks a finer zoom for a narrower span', () => {
  const t = lonLatToTile(-97.7431, 30.2672, 10);
  assert.equal(Math.floor(t.x), 233);
  assert.equal(Math.floor(t.y), 421);
  const corner = tileToLonLat(Math.floor(t.x), Math.floor(t.y), 10);
  assert.ok(corner.lon <= -97.7431 && corner.lat >= 30.2672);
  assert.ok(zoomForSpan(30, 10_000) > zoomForSpan(30, 500_000));
  assert.equal(decodeTerrarium(128, 0, 0), 0);
});

test('tile cover starts in the middle and wraps across the antimeridian', () => {
  const frame = createFrame(-97.74, 30.27);
  const tiles = coverTiles(frame, 0, 0, 20_000, 10);
  const middle = lonLatToTile(-97.74, 30.27, 10);
  assert.deepEqual(
    [tiles[0].x, tiles[0].y],
    [Math.floor(middle.x), Math.floor(middle.y)],
  );
  const fiji = createFrame(179.95, -17);
  const xs = new Set(coverTiles(fiji, 0, 0, 30_000, 8).map((tile) => tile.x));
  assert.ok(xs.has(255) && xs.has(0), 'both sides of the antimeridian');
});

function placement(view = { cx: 0, cz: 0, span: 250_000, yaw: 0 }) {
  return {
    frame: createFrame(-97.74, 30.27),
    view,
    scale: WINDOW / view.span,
    window: WINDOW,
    toTable: (site) => toTable(view, WINDOW, site),
    groundAt: () => 0.001,
    seaLevel: -0.002,
  };
}

test('aircraft stand at their altitude over the ground; ships on the water', () => {
  const map = placement();
  const cruising = mapContactPose(
    { kind: 'aircraft', lat: 30.27, lon: -97.74, altitudeM: 11_000, headingDeg: 90 },
    map,
  );
  const landing = mapContactPose(
    { kind: 'aircraft', lat: 30.27, lon: -97.74, altitudeM: 50 },
    map,
  );
  assert.ok(cruising.y > landing.y, 'higher aircraft stand higher');
  assert.ok(cruising.y <= map.seaLevel + MAP_MARKERS.airCeiling + 1e-9);
  assert.ok(landing.y >= map.groundAt() + MAP_MARKERS.airFloor - 1e-9);
  const ship = mapContactPose({ kind: 'vessel', lat: 30.27, lon: -97.74 }, map);
  near(ship.y, Math.max(map.groundAt(), map.seaLevel) + 0.002);
  // Heading east on a north-up map points the arrow's tip (+Z) along +X.
  near(Math.sin(cruising.turn), 1, 1e-9);
});

test('contacts off the window are not drawn', () => {
  const far = mapContactPose(
    { kind: 'vessel', lat: 35, lon: -97.74 },
    placement(),
  );
  assert.equal(far, null);
});

test('the rim, not the map, carries the table', () => {
  const edge = MAP_TABLE.window / 2;
  assert.equal(onMapRim({ x: edge + 0.05, y: 0, z: 0 }), true);
  assert.equal(onMapRim({ x: 0.1, y: 0, z: 0 }), false);
  assert.equal(onMapRim({ x: edge + MAP_TABLE.rim + 0.2, y: 0, z: 0 }), false);
});

test('the view switch eases and steps toward its target', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  near(ease(0.5), 0.5);
  assert.equal(stepAmount(0, 'tabletop', 10), 1);
  assert.equal(stepAmount(1, 'globe', 10), 0);
  const halfway = stepAmount(0, 'tabletop', 0.35, 0.7);
  near(halfway, 0.5);
});

test('spans read in km or m', () => {
  assert.equal(formatSpan(250_000), '250 km');
  assert.equal(formatSpan(2_500), '2.5 km');
  assert.equal(formatSpan(800), '800 m');
});
