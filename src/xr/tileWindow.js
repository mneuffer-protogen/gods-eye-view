/**
 * A square window of slippy-map tiles around a focus, for the zoomed-in
 * tabletop. The window is drawn into one canvas the earth shader samples
 * wherever it covers the fragment, over the global mosaic.
 */

import { clamp } from './geo.js';

export const WINDOW_TILES = 6;
const MAX_LAT = 85.0511287798;

/** Fractional tile coordinates of a lat/lon at zoom `z` (y grows southward). */
export function lonLatToTile(latDeg, lonDeg, z) {
  const n = 2 ** z;
  const lat = (clamp(latDeg, -MAX_LAT, MAX_LAT) * Math.PI) / 180;
  const x = ((((lonDeg + 180) / 360) % 1) + 1) % 1;
  const y = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
  return { x: x * n, y: clamp(y, 0, 1) * n };
}

/** Window of `size` tiles at zoom `z` centred on a lat/lon. */
export function chooseWindow(latDeg, lonDeg, z, size = WINDOW_TILES) {
  const n = 2 ** z;
  const span = Math.min(size, n);
  const t = lonLatToTile(latDeg, lonDeg, z);
  // x wraps around the antimeridian; y does not, so it is kept inside.
  const x0 = Math.floor(t.x - span / 2);
  const y0 = clamp(Math.floor(t.y - span / 2), 0, n - span);
  return { z, x0, y0, size: span };
}

/**
 * Whether the focus has drifted within `margin` tiles of the window's edge
 * (or the zoom changed), so a new window should be fetched.
 */
export function needsRecentre(window, latDeg, lonDeg, z, margin = 1.5) {
  if (!window || window.z !== z) return true;
  const n = 2 ** z;
  const t = lonLatToTile(latDeg, lonDeg, z);
  let dx = t.x - window.x0;
  dx -= n * Math.floor((dx + n / 2) / n);
  const dy = t.y - window.y0;
  const edge = Math.min(margin, window.size / 2);
  const nearPole = window.y0 === 0 || window.y0 + window.size === n;
  return (
    dx < edge ||
    dx > window.size - edge ||
    (!nearPole && (dy < edge || dy > window.size - edge))
  );
}

/** Every tile of a window with its canvas cell and wrapped column. */
export function windowTiles(window) {
  const n = 2 ** window.z;
  const tiles = [];
  for (let row = 0; row < window.size; row++)
    for (let col = 0; col < window.size; col++)
      tiles.push({
        z: window.z,
        x: (((window.x0 + col) % n) + n) % n,
        y: window.y0 + row,
        col,
        row,
      });
  return tiles;
}

/** Tiles of `window` nearest its centre first, so the focus fills in first. */
export function tilesByDistance(window) {
  const mid = (window.size - 1) / 2;
  return windowTiles(window).sort(
    (a, b) =>
      Math.hypot(a.col - mid, a.row - mid) -
      Math.hypot(b.col - mid, b.row - mid),
  );
}
