/**
 * Globe-local geometry for the mixed-reality tabletop globe.
 *
 * The globe is a unit sphere in its own frame, three.js style (Y up):
 * latitude 0 / longitude 0 faces +Z, east is +X and north is +Y, so a
 * globe seen from +Z reads north-up with east to the right. Everything here
 * is plain math with no renderer state, so the node unit suite covers it.
 */

export const EARTH_RADIUS_M = 6_371_008.8;

const DEG = Math.PI / 180;

/** Clamp a number into [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Unit-sphere direction for a latitude/longitude in degrees, scaled by
 * `radius`. Writes into `out` when given, so per-frame callers allocate
 * nothing.
 */
export function latLonToVector(
  latDeg,
  lonDeg,
  radius = 1,
  out = { x: 0, y: 0, z: 0 },
) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const c = Math.cos(lat);
  out.x = radius * c * Math.sin(lon);
  out.y = radius * Math.sin(lat);
  out.z = radius * c * Math.cos(lon);
  return out;
}

/** Latitude/longitude in degrees for a globe-local point (any length). */
export function vectorToLatLon({ x, y, z }) {
  const length = Math.hypot(x, y, z) || 1;
  return {
    lat: Math.asin(clamp(y / length, -1, 1)) / DEG,
    lon: Math.atan2(x, z) / DEG,
  };
}

/**
 * Quaternion (x, y, z, w) turning the globe so `latDeg, lonDeg` faces +Z
 * with north up: a yaw by -longitude, then a pitch by +latitude.
 */
export function facingQuaternion(latDeg, lonDeg) {
  const yaw = (-lonDeg * DEG) / 2;
  const pitch = (latDeg * DEG) / 2;
  // q = qX(pitch) * qY(yaw)
  const ax = Math.sin(pitch);
  const aw = Math.cos(pitch);
  const by = Math.sin(yaw);
  const bw = Math.cos(yaw);
  return { x: ax * bw, y: aw * by, z: ax * by, w: aw * bw };
}

// Heights on a 25 cm globe are invisible at true scale (a cruising airliner
// sits 0.4 mm up), so each kind of contact gets a lift that keeps it readable
// and keeps the kinds apart: ships on the water, aircraft in a thin shell
// whose height still orders them by altitude, satellites further out.
export const LIFT = Object.freeze({
  surface: 0.004,
  vessel: 0.006,
  aircraftBase: 0.012,
  aircraftSpan: 0.03,
  aircraftCeilingM: 15_000,
  // Low orbits are drawn at true scale; above this the height is compressed
  // so geostationary objects stay within arm's length of the globe.
  orbitTrueScaleKm: 2_000,
  orbitCompression: 0.35,
});

/** Globe radius (surface = 1) at which an aircraft at `altitudeM` is drawn. */
export function aircraftRadius(altitudeM) {
  const altitude = Number.isFinite(altitudeM) ? altitudeM : 0;
  const share =
    clamp(altitude, 0, LIFT.aircraftCeilingM) / LIFT.aircraftCeilingM;
  return 1 + LIFT.aircraftBase + share * LIFT.aircraftSpan;
}

/** Globe radius (surface = 1) at which a satellite at `altitudeKm` is drawn. */
export function orbitRadius(altitudeKm) {
  const h =
    Math.max(0, Number.isFinite(altitudeKm) ? altitudeKm : 0) /
    (EARTH_RADIUS_M / 1000);
  const knee = LIFT.orbitTrueScaleKm / (EARTH_RADIUS_M / 1000);
  if (h <= knee) return 1 + Math.max(h, LIFT.aircraftBase + LIFT.aircraftSpan);
  return 1 + knee + Math.log1p(h - knee) * LIFT.orbitCompression;
}

/** Globe radius (surface = 1) for one normalized contact. */
export function contactRadius(contact) {
  if (contact.kind === 'aircraft' || contact.kind === 'military')
    return aircraftRadius(contact.altitudeM);
  if (contact.kind === 'satellite') return orbitRadius(contact.altitudeKm);
  if (contact.kind === 'vessel') return 1 + LIFT.vessel;
  return 1 + LIFT.surface;
}

/**
 * Unit vector of the Sun in globe-local space at `date` (low-precision solar
 * position, good to a fraction of a degree), used for the day/night
 * terminator.
 */
export function sunDirection(date = new Date()) {
  const days = date.getTime() / 86_400_000 - 10_957.5; // days since J2000.0
  const meanLongitude = (280.46 + 0.9856474 * days) % 360;
  const meanAnomaly = ((357.528 + 0.9856003 * days) % 360) * DEG;
  const eclipticLongitude =
    (meanLongitude +
      1.915 * Math.sin(meanAnomaly) +
      0.02 * Math.sin(2 * meanAnomaly)) *
    DEG;
  const obliquity = (23.439 - 0.0000004 * days) * DEG;
  const declination = Math.asin(
    Math.sin(obliquity) * Math.sin(eclipticLongitude),
  );
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );
  // Greenwich mean sidereal time, in degrees.
  const gmst = (280.46061837 + 360.98564736629 * days) % 360;
  const subsolarLon =
    ((((rightAscension / DEG - gmst) % 360) + 540) % 360) - 180;
  return latLonToVector(declination / DEG, subsolarLon);
}

/**
 * Where the globe first faces: `?lat=&lon=` from the page URL (the main app
 * passes its camera position), else a guess from the clock's time zone so
 * the user's own side of the world comes up first without asking for
 * location permission.
 */
export function startFocus(search = '', timezoneOffsetMinutes = 0) {
  const params = new URLSearchParams(search);
  const lat = Number.parseFloat(params.get('lat'));
  const lon = Number.parseFloat(params.get('lon'));
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  ) {
    return { lat, lon, fromUrl: true };
  }
  const guessed = clamp(-timezoneOffsetMinutes / 4, -180, 180);
  return {
    lat: 30,
    lon: Number.isFinite(guessed) ? guessed : 0,
    fromUrl: false,
  };
}
