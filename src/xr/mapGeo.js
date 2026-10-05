/**
 * Geography for the tabletop map: a local east-north-up frame in metres, and
 * Web Mercator slippy-tile maths. Pure, so the node unit suite covers it.
 *
 * Scene axes follow three.js and the map view: x is east, y is up and z is
 * south. Tiles are addressed `{ z, x, y }` with y growing southward, the XYZ
 * scheme Esri World Imagery and the AWS terrain tiles serve.
 */

export const M_PER_DEG_LAT = 111_320;
const EARTH_CIRCUMFERENCE = 40_075_016.686;
const RADIANS = Math.PI / 180;

/**
 * A local frame around `lon0, lat0`. Equirectangular: exact at the origin
 * and good to a fraction of a percent across the widest map view, which is
 * why the map recentres its frame when the view wanders far from it.
 */
export function createFrame(lon0, lat0) {
  if (!Number.isFinite(lon0) || !Number.isFinite(lat0) || Math.abs(lat0) > 85)
    throw new Error(`Invalid map origin: ${lon0}, ${lat0}`);
  const mLon = M_PER_DEG_LAT * Math.cos(lat0 * RADIANS);
  return Object.freeze({
    lon0,
    lat0,
    mLon,
    /** Scene `{ x, z }` for a longitude/latitude in degrees. */
    toScene(lon, lat) {
      let dLon = lon - lon0;
      // The short way round the antimeridian.
      if (dLon > 180) dLon -= 360;
      else if (dLon < -180) dLon += 360;
      return { x: dLon * mLon, z: -(lat - lat0) * M_PER_DEG_LAT };
    },
    /** Longitude/latitude in degrees for a scene `x, z`. */
    fromScene(x, z) {
      let lon = lon0 + x / mLon;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;
      return { lon, lat: lat0 - z / M_PER_DEG_LAT };
    },
  });
}

/** Fractional tile coordinates of a point at zoom `z`. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const latRad = Math.min(85.0511, Math.max(-85.0511, lat)) * RADIANS;
  return {
    x: ((lon + 180) / 360) * n,
    y:
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) *
      n,
  };
}

/** Longitude/latitude of a tile corner (fractional coordinates allowed). */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  return {
    lon: (x / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RADIANS,
  };
}

export const tileKey = ({ z, x, y }) => `${z}/${x}/${y}`;

/** Ground width of one tile at a latitude, in metres. */
export const tileSizeMeters = (lat, z) =>
  (EARTH_CIRCUMFERENCE * Math.cos(lat * RADIANS)) / 2 ** z;

/**
 * The zoom at which `tilesAcross` tiles span `spanMeters`, rounded toward the
 * finer level so imagery is never stretched past its resolution.
 */
export function zoomForSpan(
  lat,
  spanMeters,
  { tilesAcross = 3, min = 2, max = 17 } = {},
) {
  const z = Math.ceil(
    Math.log2(
      (EARTH_CIRCUMFERENCE * Math.cos(lat * RADIANS) * tilesAcross) /
        Math.max(spanMeters, 1),
    ),
  );
  return Math.min(max, Math.max(min, z));
}

/**
 * Every tile at zoom `z` touching the square of half-width `radius` metres
 * around a scene point, nearest first so a loader fills the middle first.
 * Wraps across the antimeridian.
 */
export function coverTiles(frame, x, z, radius, zoom) {
  const nw = frame.fromScene(x - radius, z - radius);
  const se = frame.fromScene(x + radius, z + radius);
  const middle = frame.fromScene(x, z);
  const n = 2 ** zoom;
  const a = lonLatToTile(nw.lon, nw.lat, zoom);
  const b = lonLatToTile(se.lon, se.lat, zoom);
  const c = lonLatToTile(middle.lon, middle.lat, zoom);
  // Across the antimeridian the east edge's tile is numbered below the west's;
  // distances are measured unwrapped, from the west edge eastward.
  const x1 = b.x < a.x ? b.x + n : b.x;
  const cx = c.x < a.x ? c.x + n : c.x;
  const tiles = [];
  for (let tx = Math.floor(a.x); tx <= Math.floor(x1); tx++)
    for (
      let ty = Math.max(0, Math.floor(a.y));
      ty <= Math.min(n - 1, Math.floor(b.y));
      ty++
    ) {
      tiles.push({
        z: zoom,
        x: ((tx % n) + n) % n,
        y: ty,
        d: Math.hypot(tx + 0.5 - cx, ty + 0.5 - c.y),
      });
    }
  return tiles
    .sort((p, q) => p.d - q.d)
    .map(({ z: tz, x: tx, y: ty }) => ({ z: tz, x: tx, y: ty }));
}

/** Terrarium elevation encoding (AWS Open Data terrain tiles), in metres. */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;
