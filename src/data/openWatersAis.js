/**
 * Keyless live AIS from Open Waters (https://openwaters.io/ais/), used when no
 * AISSTREAM_API_KEY is configured so the vessel layer shows real positions
 * instead of UNAVAILABLE.
 *
 * The snapshot endpoint answers a bounding box only. Anonymous reads are
 * capped at about 100 square degrees of box area (a ~10°×10° window) and
 * refused past that; an optional free personal token raises the cap to about
 * 400. Every feature names its upstream source, and the response carries the
 * attribution each source requires (AISHub, aisstream.io, volunteer stations;
 * the aggregate is ODbL). Free for personal use; commercial use is a paid tier.
 */
export const OPENWATERS_VESSELS_URL = 'https://ais.openwaters.io/v1/vessels';
export const OPENWATERS_CREDIT_URL = 'https://openwaters.io/ais/';

/** Box-area caps by tier, in square degrees, with a margin under the limit. */
export const OPENWATERS_ANON_MAX_AREA_SQ_DEG = 96;
export const OPENWATERS_TOKEN_MAX_AREA_SQ_DEG = 390;

/**
 * Where a keyless snapshot looks before any client has asked for an area:
 * the English Channel and southern North Sea, among the densest AIS coverage.
 */
export const OPENWATERS_DEFAULT_AREA = Object.freeze({
  lat: 51,
  lon: 1.5,
  radiusKm: 450,
});

const KM_PER_DEG_LAT = 111.32;

/**
 * The box to request for a view area `{ lat, lon, radiusKm }`, shrunk about
 * its center to fit `maxAreaSqDeg` and shifted so it never crosses the
 * antimeridian or a pole (Open Waters refuses a box that wraps).
 */
export function bboxForArea(
  { lat, lon, radiusKm } = OPENWATERS_DEFAULT_AREA,
  maxAreaSqDeg = OPENWATERS_ANON_MAX_AREA_SQ_DEG,
) {
  const centerLat = clamp(lat, -89, 89);
  const centerLon = wrapLon(lon);
  const radius = Number.isFinite(radiusKm) && radiusKm > 0 ? radiusKm : 450;
  const cosLat = Math.max(0.05, Math.cos((centerLat * Math.PI) / 180));
  let latHalf = radius / KM_PER_DEG_LAT;
  let lonHalf = radius / (KM_PER_DEG_LAT * cosLat);
  const area = 4 * latHalf * lonHalf;
  if (area > maxAreaSqDeg) {
    const scale = Math.sqrt(maxAreaSqDeg / area);
    latHalf *= scale;
    lonHalf *= scale;
  }
  latHalf = Math.min(latHalf, 89);
  lonHalf = Math.min(lonHalf, 179);
  const [minLat, maxLat] = shiftInside(centerLat, latHalf, -90, 90);
  const [minLon, maxLon] = shiftInside(centerLon, lonHalf, -180, 180);
  return { minLat, minLon, maxLat, maxLon };
}

/** `minLat,minLon,maxLat,maxLon`, the order Open Waters expects. */
export function formatOpenWatersBbox({ minLat, minLon, maxLat, maxLon }) {
  return [minLat, minLon, maxLat, maxLon]
    .map((value) => Number(value.toFixed(3)))
    .join(',');
}

/**
 * Open Waters GeoJSON to the row shape the AISStream store serves, so the
 * client sees one vessel contract whichever feed answered. Keeps vessels
 * only (base stations, aids to navigation and SAR aircraft share the feed),
 * drops fixes older than `maxAgeMs`, de-duplicates by MMSI and orders rows
 * newest first.
 */
export function normalizeOpenWatersCollection(
  payload,
  { now = Date.now(), maxAgeMs = Infinity } = {},
) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  /** @type {Map<string, object>} newest fix per MMSI */
  const rows = new Map();
  for (const feature of features) {
    const row = normalizeOpenWatersFeature(feature);
    if (!row) continue;
    if (now - row.last_position_epoch * 1000 > maxAgeMs) continue;
    const held = rows.get(row.mmsi);
    if (!held || row.last_position_epoch > held.last_position_epoch)
      rows.set(row.mmsi, row);
  }
  return [...rows.values()].sort(
    (a, b) => b.last_position_epoch - a.last_position_epoch,
  );
}

/** The distinct attribution lines a response asks its displayer to carry. */
export function openWatersAttribution(payload) {
  const attribution = payload?.attribution;
  if (!attribution || typeof attribution !== 'object') return [];
  return [...new Set(Object.values(attribution).map(String))].filter(Boolean);
}

function normalizeOpenWatersFeature(feature) {
  const coords = feature?.geometry?.coordinates;
  const lon = Number(Array.isArray(coords) ? coords[0] : NaN);
  const lat = Number(Array.isArray(coords) ? coords[1] : NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const props =
    feature?.properties && typeof feature.properties === 'object'
      ? feature.properties
      : {};
  const kind = String(props.kind || 'vessel');
  if (kind !== 'vessel') return null;
  const mmsi = String(props.mmsi ?? feature?.id ?? '').trim();
  if (!/^\d{5,10}$/.test(mmsi)) return null;
  const epochMs = Date.parse(String(props.seen || ''));
  if (!Number.isFinite(epochMs)) return null;
  return {
    lat,
    lon,
    name: String(props.name || '').trim() || `MMSI ${mmsi}`,
    mmsi,
    imo: String(props.imo ?? '').trim(),
    type: props.type == null ? '' : String(props.type),
    destination: String(props.destination || '').trim(),
    // AIS "not available" codes: SOG 102.3, COG 360, heading 511.
    speed: inRange(props.sog, 0, 102.3),
    course: inRange(props.cog, 0, 360),
    heading: inRange(props.heading, 0, 360.0001),
    last_position_UTC: new Date(epochMs).toISOString(),
    last_position_epoch: Math.floor(epochMs / 1000),
  };
}

/** A finite number in [min, max), else null. */
function inRange(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number < max
    ? number
    : null;
}

function shiftInside(center, half, min, max) {
  let low = center - half;
  let high = center + half;
  if (low < min) [low, high] = [min, min + 2 * half];
  if (high > max) [low, high] = [max - 2 * half, max];
  return [Math.max(min, low), Math.min(max, high)];
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(max, Math.max(min, number));
}

function wrapLon(value) {
  const lon = Number(value);
  if (!Number.isFinite(lon)) return 0;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
