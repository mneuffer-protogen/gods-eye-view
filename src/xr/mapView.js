/**
 * The tabletop map's view, and the grab maths that moves it. Pure: plain
 * `{ x, z }` points, no three.js, so the node unit suite covers it.
 *
 * A view is the site point at the table's centre (`cx`, `cz` in site metres:
 * x east, z south), the ground distance the round window spans, and a yaw.
 * Site metres map to table metres by
 *   table = R(yaw) * s * (site - c),   s = window / span
 * with R the rotation three.js applies about +Y: a vector's angle is
 * atan2(x, z).
 */

export const VIEW_LIMITS = Object.freeze({
  // A city block at the closest, a region at the widest; past that the
  // flat map's distortion shows and the globe is the better view.
  minSpan: 500,
  maxSpan: 2_000_000,
  // Hands this close together say nothing reliable about spread or angle.
  steadyGap: 0.04,
});

export const scaleOf = (view, window) => window / view.span;

export const clampSpan = (span) =>
  Math.min(VIEW_LIMITS.maxSpan, Math.max(VIEW_LIMITS.minSpan, span));

const rotate = (p, angle) => ({
  x: p.x * Math.cos(angle) + p.z * Math.sin(angle),
  z: -p.x * Math.sin(angle) + p.z * Math.cos(angle),
});

/** A site point `{ x, z }` in table coordinates. */
export function toTable(view, window, p) {
  const s = scaleOf(view, window);
  const r = rotate({ x: p.x - view.cx, z: p.z - view.cz }, view.yaw);
  return { x: r.x * s, z: r.z * s };
}

/** A table point `{ x, z }` in site coordinates. */
export function toSite(view, window, p) {
  const s = scaleOf(view, window);
  const r = rotate({ x: p.x / s, z: p.z / s }, -view.yaw);
  return { x: r.x + view.cx, z: r.z + view.cz };
}

/**
 * One or two hands holding the map. Each hand grabbed a site point (its
 * anchor) and is now at a table point; the view is whatever puts every
 * anchor back under its hand. One hand pans; two also scale and turn, like
 * pulling a photo apart on a phone.
 * @param {{ cx: number, cz: number, span: number, yaw: number }} view
 * @param {number} window the window's diameter in table metres
 * @param {{ anchor: { x: number, z: number }, hand: { x: number, z: number } }[]} holds
 */
export function solveGrab(view, window, holds) {
  if (!holds.length) return view;
  if (holds.length === 1) {
    const [{ anchor, hand }] = holds;
    const s = scaleOf(view, window);
    const back = rotate({ x: hand.x / s, z: hand.z / s }, -view.yaw);
    return { ...view, cx: anchor.x - back.x, cz: anchor.z - back.z };
  }
  const [a, b] = holds;
  const dh = { x: b.hand.x - a.hand.x, z: b.hand.z - a.hand.z };
  const da = { x: b.anchor.x - a.anchor.x, z: b.anchor.z - a.anchor.z };
  const handGap = Math.hypot(dh.x, dh.z);
  const anchorGap = Math.hypot(da.x, da.z);
  if (handGap < VIEW_LIMITS.steadyGap || anchorGap < 1e-6) return view;
  const span = clampSpan((window * anchorGap) / handGap);
  const yaw = Math.atan2(dh.x, dh.z) - Math.atan2(da.x, da.z);
  // A clamped span leaves the hands' midpoint pinned rather than one hand.
  const s = window / span;
  const mid = { x: (a.hand.x + b.hand.x) / 2, z: (a.hand.z + b.hand.z) / 2 };
  const anchorMid = {
    x: (a.anchor.x + b.anchor.x) / 2,
    z: (a.anchor.z + b.anchor.z) / 2,
  };
  const back = rotate({ x: mid.x / s, z: mid.z / s }, -yaw);
  return {
    ...view,
    span,
    yaw: Math.atan2(Math.sin(yaw), Math.cos(yaw)),
    cx: anchorMid.x - back.x,
    cz: anchorMid.z - back.z,
  };
}

/** A wheel or button zoom about a table point, keeping the ground under it. */
export function zoomAbout(view, window, tablePoint, factor) {
  const anchor = toSite(view, window, tablePoint);
  const next = { ...view, span: clampSpan(view.span * factor) };
  return solveGrab(next, window, [{ anchor, hand: tablePoint }]);
}

/**
 * Vertical exaggeration for a span: true relief up close, more as the view
 * widens so mountains still read as mountains on a desk-sized map.
 */
export function reliefFor(span) {
  return Math.min(5, Math.max(1, Math.sqrt(span / 20_000)));
}
