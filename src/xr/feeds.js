/**
 * Live feeds for the mixed-reality globe, from the same portable sources the
 * main app's layers use: the local /api routes for aircraft, military
 * aircraft, vessels and satellite element sets, and USGS for earthquakes.
 * Records are reduced to one small contact shape the globe can draw and the
 * info panel can describe; nothing here touches Cesium or three.js.
 *
 * A feed that is not configured (no AIS key) or not reachable says so in its
 * status instead of drawing nothing silently.
 */

import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import {
  createFlightSource,
  createMilitarySource,
  createVesselSource,
} from '../sources/live/index.js';
import { parseTleText, tleCatalogNumber } from '../sources/tle.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createUsgsEarthquakeSource } from '../layers/earthquakes/source.js';

export const FEED_ORDER = Object.freeze([
  'aircraft',
  'military',
  'vessels',
  'satellites',
  'earthquakes',
]);

export const FEEDS = Object.freeze({
  aircraft: Object.freeze({
    label: 'Aircraft',
    intervalMs: 30_000,
    enabled: true,
  }),
  military: Object.freeze({
    label: 'Military aircraft',
    intervalMs: 15_000,
    enabled: true,
  }),
  vessels: Object.freeze({
    label: 'Vessels',
    intervalMs: 60_000,
    enabled: true,
  }),
  satellites: Object.freeze({
    label: 'Satellites',
    intervalMs: 300_000,
    enabled: true,
  }),
  earthquakes: Object.freeze({
    label: 'Earthquakes',
    intervalMs: 60_000,
    enabled: true,
  }),
});

// The main app's catalogue groups (src/layers/satellites/policy.js), without
// the dense Starlink shell: about a thousand objects a headset can propagate
// comfortably.
export const SATELLITE_GROUPS = Object.freeze([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
]);
export const ISS_CATALOG_NUMBER = 25544;

const KNOTS_PER_MPS = 1.943844;
const FEET_PER_METRE = 3.28084;

const finite = (value) => (Number.isFinite(value) ? value : null);
const round = (value, digits = 0) =>
  value == null ? null : Number(value.toFixed(digits));
const validPosition = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

/** One feed record reduced to the globe's contact shape. */
function contact(kind, id, lat, lon, fields) {
  return { kind, id: `${kind}:${id}`, lat, lon, ...fields };
}

/** Aircraft records (OpenSky or readsb normalized) as contacts. */
export function aircraftContacts(records, kind = 'aircraft') {
  const contacts = [];
  for (const record of records || []) {
    if (
      !record ||
      record.onGround ||
      !validPosition(record.latitude, record.longitude)
    )
      continue;
    const altitudeM =
      finite(record.baroAltitudeM) ?? finite(record.ellipsoidAltitudeM);
    const label =
      String(record.callsign || '').trim() ||
      String(record.id || '').toUpperCase();
    const details = [
      [
        'Altitude',
        altitudeM == null
          ? '—'
          : `${Math.round(altitudeM * FEET_PER_METRE).toLocaleString('en-US')} ft`,
      ],
      [
        'Speed',
        finite(record.speedMps) == null
          ? '—'
          : `${Math.round(record.speedMps * KNOTS_PER_MPS)} kt`,
      ],
      [
        'Heading',
        finite(record.courseDeg) == null
          ? '—'
          : `${Math.round(record.courseDeg)}°`,
      ],
    ];
    if (record.typeCode) details.push(['Type', String(record.typeCode)]);
    if (record.registration)
      details.push(['Registration', String(record.registration)]);
    if (record.originCountry)
      details.push(['Origin', String(record.originCountry)]);
    contacts.push(
      contact(kind, record.id, record.latitude, record.longitude, {
        label,
        altitudeM,
        headingDeg: finite(record.courseDeg),
        details,
      }),
    );
  }
  return contacts;
}

/** Vessel records as contacts. */
export function vesselContacts(records) {
  const contacts = [];
  for (const record of records || []) {
    if (!record || !validPosition(record.latitude, record.longitude)) continue;
    const heading = finite(record.headingDeg) ?? finite(record.courseDeg);
    const details = [
      [
        'Speed',
        finite(record.speedMps) == null
          ? '—'
          : `${round(record.speedMps * KNOTS_PER_MPS, 1)} kt`,
      ],
      [
        'Course',
        finite(record.courseDeg) == null
          ? '—'
          : `${Math.round(record.courseDeg)}°`,
      ],
    ];
    if (record.type != null && record.type !== '')
      details.push(['Type', String(record.type)]);
    if (record.destination)
      details.push(['Destination', String(record.destination)]);
    details.push(['MMSI', String(record.id)]);
    contacts.push(
      contact('vessel', record.id, record.latitude, record.longitude, {
        label: String(record.name || '').trim() || `MMSI ${record.id}`,
        headingDeg: heading,
        details,
      }),
    );
  }
  return contacts;
}

/** USGS earthquake rows (M2.5+) as contacts. */
export function earthquakeContacts(rows, now = Date.now()) {
  const contacts = [];
  for (const row of rows || []) {
    if (!row || !validPosition(row.lat, row.lon)) continue;
    const hoursAgo = Number.isFinite(row.time)
      ? Math.max(0, (now - row.time) / 3_600_000)
      : null;
    contacts.push(
      contact('earthquake', row.stableId, row.lat, row.lon, {
        label: `M${row.mag.toFixed(1)} ${row.place || ''}`.trim(),
        magnitude: row.mag,
        recentMs: Number.isFinite(row.time) ? row.time : null,
        details: [
          ['Magnitude', row.mag.toFixed(1)],
          [
            'Depth',
            Number.isFinite(row.depthKm) ? `${round(row.depthKm, 1)} km` : '—',
          ],
          [
            'When',
            hoursAgo == null
              ? '—'
              : hoursAgo < 1
                ? `${Math.round(hoursAgo * 60)} min ago`
                : `${round(hoursAgo, 1)} h ago`,
          ],
        ],
      }),
    );
  }
  return contacts;
}

/**
 * Parse catalogue texts into satellites with their propagation records,
 * de-duplicated by catalogue number (the first group to list one wins).
 */
export function satelliteCatalog(texts, toSatrec = twoline2satrec) {
  const seen = new Set();
  const catalog = [];
  for (const text of texts) {
    for (const { name, line1, line2 } of parseTleText(text)) {
      const catalogNumber = tleCatalogNumber(line1);
      if (catalogNumber == null || seen.has(catalogNumber)) continue;
      let satrec;
      try {
        satrec = toSatrec(line1, line2);
      } catch {
        continue;
      }
      // twoline2satrec accepts garbage without flagging it; a usable element
      // set has a positive mean motion.
      if (!satrec || satrec.error || !(satrec.no > 0)) continue;
      seen.add(catalogNumber);
      catalog.push({
        id: `satellite:${catalogNumber}`,
        name,
        satrec,
        catalogNumber,
      });
    }
  }
  return catalog;
}

/** Sub-satellite point and height (km) at `date`, or null when SGP4 fails. */
export function propagateSatellite(entry, date) {
  try {
    const state = propagate(entry.satrec, date);
    const position = state?.position;
    if (!position || typeof position === 'boolean') return null;
    const geo = eciToGeodetic(position, gstime(date));
    const lat = degreesLat(geo.latitude);
    const lon = degreesLong(geo.longitude);
    if (!validPosition(lat, lon) || !Number.isFinite(geo.height)) return null;
    return { lat, lon, altitudeKm: geo.height };
  } catch {
    return null;
  }
}

/** A satellite contact at its propagated position. */
export function satelliteContact(entry, position) {
  return {
    kind: 'satellite',
    id: entry.id,
    lat: position.lat,
    lon: position.lon,
    altitudeKm: position.altitudeKm,
    label: entry.name,
    iss: entry.catalogNumber === ISS_CATALOG_NUMBER,
    details: [
      [
        'Altitude',
        `${Math.round(position.altitudeKm).toLocaleString('en-US')} km`,
      ],
      ['NORAD', String(entry.catalogNumber)],
    ],
  };
}

/** A short human status for one feed's state. */
export function describeFeed(state) {
  if (!state.enabled) return 'off';
  if (state.status === 'live')
    return `${state.count.toLocaleString('en-US')} live`;
  if (state.status === 'stale')
    return `${state.count.toLocaleString('en-US')} (stale)`;
  if (state.status === 'loading') return 'loading…';
  if (state.status === 'unavailable') return state.message || 'unavailable';
  return '—';
}

/** The sources a feed hub reads, defaulting to the app's standalone ones. */
export function createDefaultSources(fetchImpl) {
  const options = fetchImpl ? { fetchImpl } : {};
  return {
    flights: createFlightSource(options),
    military: createMilitarySource(options),
    vessels: createVesselSource(options),
    satellites: createSatelliteSource(options),
    earthquakes: createUsgsEarthquakeSource(options),
  };
}

/**
 * Polls every enabled feed on its own interval and reports contacts through
 * `onContacts(feedId, contacts)` and status through `onStatus(states)`.
 * Satellites report their catalogue through `onCatalog(entries)`; the caller
 * propagates them, since their positions change every frame.
 */
export function createFeedHub({
  sources = createDefaultSources(),
  onContacts = () => {},
  onCatalog = () => {},
  onStatus = () => {},
  focus = () => null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const states = Object.fromEntries(
    FEED_ORDER.map((id) => [
      id,
      {
        id,
        label: FEEDS[id].label,
        enabled: FEEDS[id].enabled,
        status: 'idle',
        count: 0,
        message: '',
        updatedAtMs: null,
        source: null,
      },
    ]),
  );
  const timers = new Map();
  const controllers = new Map();
  let running = false;

  const report = () =>
    onStatus(Object.values(states).map((state) => ({ ...state })));

  async function read(id, signal) {
    if (id === 'aircraft') {
      const point = focus();
      const query = point ? { latitude: point.lat, longitude: point.lon } : {};
      const snapshot = await sources.flights.getSnapshot(query, { signal });
      return {
        contacts: aircraftContacts(snapshot.records, 'aircraft'),
        stale: !!snapshot.stale,
        source: snapshot.source,
      };
    }
    if (id === 'military') {
      const snapshot = await sources.military.getSnapshot({}, { signal });
      return {
        contacts: aircraftContacts(snapshot.records, 'military'),
        stale: !!snapshot.stale,
        source: snapshot.source,
      };
    }
    if (id === 'vessels') {
      const snapshot = await sources.vessels.getSnapshot(
        { maxRows: 12_000 },
        { signal },
      );
      return {
        contacts: vesselContacts(snapshot.records),
        stale: !!snapshot.stale,
        source: snapshot.source,
      };
    }
    if (id === 'earthquakes') {
      const rows = await sources.earthquakes.getSnapshot({ signal });
      return {
        contacts: earthquakeContacts(rows, now()),
        stale: false,
        source: 'USGS',
      };
    }
    const results = await Promise.allSettled(
      SATELLITE_GROUPS.map((group) =>
        sources.satellites.readGroup(group, { signal }),
      ),
    );
    signal.throwIfAborted();
    const texts = results
      .filter((r) => r.status === 'fulfilled' && r.value.ok)
      .map((r) => r.value.text);
    if (!texts.length) throw new Error('element sets unavailable');
    const catalog = satelliteCatalog(texts);
    const stale = results.some(
      (r) => r.status === 'fulfilled' && r.value.stale,
    );
    return { catalog, stale, source: 'CelesTrak' };
  }

  async function poll(id) {
    timers.delete(id);
    const state = states[id];
    if (!running || !state.enabled) return;
    controllers.get(id)?.abort();
    const controller = new AbortController();
    controllers.set(id, controller);
    if (!state.count) {
      state.status = 'loading';
      report();
    }
    try {
      const result = await read(id, controller.signal);
      if (controller.signal.aborted || !state.enabled) return;
      if (result.catalog) {
        state.count = result.catalog.length;
        onCatalog(result.catalog);
      } else {
        state.count = result.contacts.length;
        onContacts(id, result.contacts);
      }
      state.status = result.stale ? 'stale' : 'live';
      state.message = '';
      state.source = result.source || null;
      state.updatedAtMs = now();
    } catch (error) {
      if (controller.signal.aborted) return;
      // Keep the last good contacts on screen; only the status changes.
      state.status = state.count ? 'stale' : 'unavailable';
      state.message = String(error?.message || 'unavailable').slice(0, 60);
    } finally {
      if (controllers.get(id) === controller) controllers.delete(id);
    }
    report();
    if (running && state.enabled)
      timers.set(
        id,
        setTimer(() => poll(id), FEEDS[id].intervalMs),
      );
  }

  function cancel(id) {
    if (timers.has(id)) clearTimer(timers.get(id));
    timers.delete(id);
    controllers.get(id)?.abort();
    controllers.delete(id);
  }

  return {
    states,
    /** Begin polling every enabled feed. */
    start() {
      if (running) return;
      running = true;
      for (const id of FEED_ORDER) poll(id);
    },
    /** Stop polling and abort requests in flight. */
    stop() {
      running = false;
      for (const id of FEED_ORDER) cancel(id);
    },
    /** Turn one feed on or off; off clears its contacts. */
    setEnabled(id, enabled) {
      const state = states[id];
      if (!state || state.enabled === enabled) return;
      state.enabled = enabled;
      cancel(id);
      if (!enabled) {
        state.status = 'idle';
        state.count = 0;
        if (id === 'satellites') onCatalog([]);
        else onContacts(id, []);
        report();
      } else if (running) poll(id);
    },
    /** Poll one feed now (for example after the focus point moved). */
    refresh(id) {
      if (!running || !states[id]?.enabled) return;
      cancel(id);
      poll(id);
    },
  };
}
