/**
 * The globe-to-tabletop zoom model, as plain math.
 *
 * One number drives everything: the radius `R` of the Earth sphere in metres.
 * A small sphere floats over the glass base and reads as a desk globe. As it
 * grows it sinks into the base and only the part inside the base's rim stays
 * visible, so the dome flattens; once `R` is large the visible patch is flat
 * to a fraction of a millimetre and reads as a map lying on the table. Panning
 * the map is turning the sphere, so the hand maths of the globe carries over.
 *
 * `flatness(R)` is the morph from globe (0) to tabletop (1). Everything that
 * changes with it — where the sphere sits, which way its focus faces, how
 * large a window is clipped, how tall contacts stand — is derived here.
 */

import { EARTH_RADIUS_M, clamp } from './geo.js';

export const ZOOM = Object.freeze({
  minRadius: 0.12,
  // A regional map: at this size the 0.6 m table spans about 9 km.
  maxRadius: 400,
  // Flatness runs from 0 at `globeMax` to 1 at `flatFrom`.
  globeMax: 0.42,
  flatFrom: 3,
  // Height of the map surface above the real table once flat.
  mapHeight: 0.03,
  // Imagery pixel pitch on the table, in metres, used to choose a tile zoom.
  pixelPitch: 0.001,
  minTileZoom: 3,
  maxTileZoom: 13,
});

const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Sphere radius clamped to the zoom range. */
export function clampRadius(radius) {
  return clamp(radius, ZOOM.minRadius, ZOOM.maxRadius);
}

/** 0 for a floating globe, 1 for a flat tabletop map, smooth between. */
export function flatness(radius) {
  return smoothstep(
    Math.log(ZOOM.globeMax),
    Math.log(ZOOM.flatFrom),
    Math.log(radius),
  );
}

/** Ground metres per table metre at the equator. */
export function groundScale(radius) {
  return EARTH_RADIUS_M / radius;
}

/** Fractional slippy-map zoom whose tiles are ~`pixelPitch` per pixel. */
export function detailZoom(radius, latDeg = 0) {
  const cosLat = Math.max(0.2, Math.cos((latDeg * Math.PI) / 180));
  return Math.log2(
    (2 * Math.PI * radius * cosLat) / (256 * ZOOM.pixelPitch),
  );
}

/** The whole tile zoom to fetch for a sphere radius and latitude. */
export function tileZoomFor(radius, latDeg = 0) {
  return clamp(
    Math.round(detailZoom(radius, latDeg)),
    ZOOM.minTileZoom,
    ZOOM.maxTileZoom,
  );
}

/**
 * Where the sphere sits for radius `radius` and eye elevation `elevation`
 * (radians above the globe's equator plane toward the viewer, used while the
 * globe is round). Table frame: +Y up, +Z toward the viewer. Returns
 *
 *   center     sphere centre
 *   normal     unit direction from the centre to the focus point
 *   elevation  the blended elevation of that direction
 *   clipRadius lateral radius of the visible window about the table axis
 *
 * The focus point (the surface point facing the viewer when round, the point
 * under the table's centre when flat) moves smoothly from the round pose to
 * the map pose, so a held focus never jumps.
 */
export function tablePose(radius, elevation, clearance, baseRadius) {
  const u = flatness(radius);
  const e = elevation + (Math.PI / 2 - elevation) * u;
  const normal = { x: 0, y: Math.sin(e), z: Math.cos(e) };
  // Round pose: sphere centred above the glass; focus on its viewer side.
  const roundNormal = {
    x: 0,
    y: Math.sin(elevation),
    z: Math.cos(elevation),
  };
  const round = {
    x: 0,
    y: clearance + radius + radius * roundNormal.y,
    z: radius * roundNormal.z,
  };
  const flat = { x: 0, y: ZOOM.mapHeight, z: 0 };
  const focusPoint = {
    x: 0,
    y: round.y + (flat.y - round.y) * u,
    z: round.z + (flat.z - round.z) * u,
  };
  return {
    flatness: u,
    elevation: e,
    normal,
    center: {
      x: 0,
      y: focusPoint.y - radius * normal.y,
      z: focusPoint.z - radius * normal.z,
    },
    clipRadius: radius * 1.1 + (baseRadius - radius * 1.1) * u,
  };
}

/**
 * Physical height in metres above the surface at which a contact is drawn.
 * Round: the thin lifts of the globe. Flat: a stack tall enough to read
 * altitude (a few centimetres), since a true-scale airliner sits on the map.
 */
export function contactHeight(kind, altitudeM, u) {
  const alt = Number.isFinite(altitudeM) ? Math.max(0, altitudeM) : 0;
  const share = clamp(alt / 15_000, 0, 1);
  const lerp = (a, b) => a + (b - a) * u;
  if (kind === 'aircraft' || kind === 'military')
    return lerp(0.0029 + share * 0.0072, 0.006 + share * 0.05);
  if (kind === 'vessel') return lerp(0.0014, 0.003);
  return lerp(0.001, 0.002);
}
