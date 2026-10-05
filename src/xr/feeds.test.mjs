import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_ORDER,
  aircraftContacts,
  createFeedHub,
  describeFeed,
  earthquakeContacts,
  propagateSatellite,
  satelliteCatalog,
  satelliteContact,
  vesselContacts,
} from './feeds.js';

// ISS element set (any valid TLE propagates; the epoch only shifts accuracy).
const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   24170.50000000  .00016717  00000-0  30306-3 0  9993
2 25544  51.6400 208.9163 0006317  69.9862 290.1795 15.49815168458451`;

test('airborne aircraft become contacts; grounded and positionless ones do not', () => {
  const contacts = aircraftContacts([
    {
      id: 'abc123',
      callsign: 'UAL1 ',
      latitude: 30,
      longitude: -97,
      baroAltitudeM: 10_000,
      speedMps: 230,
      courseDeg: 91,
    },
    { id: 'def456', latitude: 31, longitude: -98, onGround: true },
    { id: 'ghi789', latitude: null, longitude: -98 },
  ]);
  assert.equal(contacts.length, 1);
  const [plane] = contacts;
  assert.equal(plane.id, 'aircraft:abc123');
  assert.equal(plane.label, 'UAL1');
  assert.equal(plane.altitudeM, 10_000);
  assert.equal(plane.headingDeg, 91);
  assert.deepEqual(plane.details[0], ['Altitude', '32,808 ft']);
  assert.deepEqual(plane.details[1], ['Speed', '447 kt']);
});

test('military aircraft keep their own kind and fall back to the hex as a label', () => {
  const [jet] = aircraftContacts(
    [{ id: 'ae1234', latitude: 1, longitude: 2, ellipsoidAltitudeM: 500 }],
    'military',
  );
  assert.equal(jet.kind, 'military');
  assert.equal(jet.label, 'AE1234');
  assert.equal(jet.altitudeM, 500);
});

test('vessels prefer the true heading and name themselves', () => {
  const [ship] = vesselContacts([
    {
      id: 366999000,
      name: 'EVER GIVEN',
      latitude: 30,
      longitude: 32.5,
      courseDeg: 10,
      headingDeg: 12,
      speedMps: 5,
      destination: 'ROTTERDAM',
    },
  ]);
  assert.equal(ship.headingDeg, 12);
  assert.equal(ship.label, 'EVER GIVEN');
  assert.ok(
    ship.details.some(
      ([label, value]) => label === 'Destination' && value === 'ROTTERDAM',
    ),
  );
});

test('earthquakes carry magnitude and a relative time', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const [quake] = earthquakeContacts(
    [
      {
        stableId: 'us7000',
        lat: 35,
        lon: 139,
        depthKm: 10,
        mag: 5.4,
        place: 'near Tokyo',
        time: now - 30 * 60_000,
      },
    ],
    now,
  );
  assert.equal(quake.magnitude, 5.4);
  assert.equal(quake.label, 'M5.4 near Tokyo');
  assert.deepEqual(quake.details[2], ['When', '30 min ago']);
});

test('satellite catalogues de-duplicate by catalogue number and propagate', () => {
  const catalog = satelliteCatalog([ISS_TLE, ISS_TLE]);
  assert.equal(catalog.length, 1);
  const position = propagateSatellite(
    catalog[0],
    new Date('2024-06-18T12:00:00Z'),
  );
  assert.ok(position, 'SGP4 produced a position');
  assert.ok(
    position.altitudeKm > 350 && position.altitudeKm < 450,
    `ISS height ${position.altitudeKm}`,
  );
  assert.ok(Math.abs(position.lat) <= 51.7, 'within the orbit inclination');
  const contact = satelliteContact(catalog[0], position);
  assert.equal(contact.iss, true);
  assert.equal(contact.kind, 'satellite');
});

test('a malformed element set is skipped rather than thrown', () => {
  assert.deepEqual(satelliteCatalog(['NOT A TLE\n1 x\n2 y']), []);
});

function fakeSources(overrides = {}) {
  return {
    flights: {
      getSnapshot: async () => ({
        records: [{ id: 'a', latitude: 1, longitude: 2, baroAltitudeM: 1000 }],
      }),
    },
    military: { getSnapshot: async () => ({ records: [] }) },
    vessels: {
      getSnapshot: async () => {
        throw new Error('AISSTREAM_API_KEY not set');
      },
    },
    satellites: {
      readGroup: async () => ({ ok: true, text: ISS_TLE, stale: false }),
    },
    earthquakes: { getSnapshot: async () => [] },
    ...overrides,
  };
}

test('the hub reports live feeds, keeps going past an unconfigured one, and stops cleanly', async () => {
  const contacts = {};
  let catalog = null;
  let statuses = [];
  const timers = [];
  const hub = createFeedHub({
    sources: fakeSources(),
    onContacts: (id, list) => (contacts[id] = list),
    onCatalog: (list) => (catalog = list),
    onStatus: (list) => (statuses = list),
    setTimer: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearTimer: () => {},
  });
  hub.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(contacts.aircraft.length, 1);
  assert.equal(catalog.length, 1);
  const byId = Object.fromEntries(statuses.map((state) => [state.id, state]));
  assert.equal(byId.aircraft.status, 'live');
  assert.equal(byId.vessels.status, 'unavailable');
  assert.equal(describeFeed(byId.vessels), 'AISSTREAM_API_KEY not set');
  assert.equal(describeFeed(byId.aircraft), '1 live');
  assert.equal(
    timers.length,
    FEED_ORDER.length,
    'every feed scheduled its next poll',
  );
  hub.setEnabled('aircraft', false);
  assert.deepEqual(contacts.aircraft, [], 'turning a feed off clears it');
  assert.equal(describeFeed(hub.states.aircraft), 'off');
  hub.stop();
});

test('a failed refresh keeps the last good contacts and marks them stale', async () => {
  let fail = false;
  let contacts = null;
  const hub = createFeedHub({
    sources: fakeSources({
      flights: {
        getSnapshot: async () => {
          if (fail) throw new Error('HTTP 429');
          return { records: [{ id: 'a', latitude: 1, longitude: 2 }] };
        },
      },
    }),
    onContacts: (id, list) => {
      if (id === 'aircraft') contacts = list;
    },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  hub.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  fail = true;
  hub.refresh('aircraft');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(contacts.length, 1, 'the last good snapshot is kept');
  assert.equal(hub.states.aircraft.status, 'stale');
  hub.stop();
});
