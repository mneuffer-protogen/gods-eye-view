import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENWATERS_ANON_MAX_AREA_SQ_DEG,
  OPENWATERS_TOKEN_MAX_AREA_SQ_DEG,
  bboxForArea,
  formatOpenWatersBbox,
  normalizeOpenWatersCollection,
  openWatersAttribution,
} from './openWatersAis.js';

const area = ({ minLat, minLon, maxLat, maxLon }) =>
  (maxLat - minLat) * (maxLon - minLon);

test('a small view area is served as asked', () => {
  const box = bboxForArea({ lat: 50, lon: 0, radiusKm: 50 });
  assert.ok(Math.abs(box.maxLat - box.minLat - (100 / 111.32)) < 1e-9);
  assert.ok(box.minLon < 0 && box.maxLon > 0);
});

test('a wide view shrinks about its center to the tier cap', () => {
  const anon = bboxForArea({ lat: 10, lon: 120, radiusKm: 450 });
  assert.ok(area(anon) <= OPENWATERS_ANON_MAX_AREA_SQ_DEG + 1e-9);
  assert.ok(Math.abs((anon.minLat + anon.maxLat) / 2 - 10) < 1e-9);
  assert.ok(Math.abs((anon.minLon + anon.maxLon) / 2 - 120) < 1e-9);
  const token = bboxForArea(
    { lat: 10, lon: 120, radiusKm: 2000 },
    OPENWATERS_TOKEN_MAX_AREA_SQ_DEG,
  );
  assert.ok(area(token) <= OPENWATERS_TOKEN_MAX_AREA_SQ_DEG + 1e-9);
  assert.ok(area(token) > OPENWATERS_ANON_MAX_AREA_SQ_DEG);
});

test('a box near the antimeridian or a pole shifts instead of wrapping', () => {
  const dateLine = bboxForArea({ lat: -17, lon: 179, radiusKm: 300 });
  assert.equal(dateLine.maxLon, 180);
  assert.ok(dateLine.minLon < dateLine.maxLon);
  const west = bboxForArea({ lat: -17, lon: -179.5, radiusKm: 300 });
  assert.equal(west.minLon, -180);
  const arctic = bboxForArea({ lat: 88, lon: 10, radiusKm: 300 });
  assert.ok(arctic.maxLat <= 90 && arctic.minLat < 88 && arctic.maxLat > 88);
  assert.ok(area(arctic) <= OPENWATERS_ANON_MAX_AREA_SQ_DEG + 1e-9);
});

test('the bbox query is minLat,minLon,maxLat,maxLon', () => {
  assert.equal(
    formatOpenWatersBbox({ minLat: 49.12345, minLon: -2, maxLat: 53, maxLon: 3 }),
    '49.123,-2,53,3',
  );
});

const NOW = Date.parse('2026-10-05T14:20:00Z');
const feature = (properties, coordinates = [-1.85, 49.74]) => ({
  type: 'Feature',
  id: properties.mmsi,
  geometry: { type: 'Point', coordinates },
  properties,
});

test('features normalize to the AISStream row shape, vessels only, newest first', () => {
  const rows = normalizeOpenWatersCollection(
    {
      type: 'FeatureCollection',
      features: [
        feature({
          mmsi: 227965180,
          name: 'LOS NINOS',
          kind: 'vessel',
          type: 36,
          sog: 5.6,
          cog: 109.3,
          seen: '2026-10-05T14:17:43Z',
          source: 'aishub',
        }),
        feature({
          mmsi: 235000001,
          kind: 'vessel',
          sog: 102.3,
          cog: 360,
          heading: 511,
          seen: '2026-10-05T14:19:00Z',
        }),
        feature({ mmsi: 2275200, kind: 'base', seen: '2026-10-05T14:19:30Z' }),
        feature({ mmsi: 992271001, kind: 'aton', seen: '2026-10-05T14:19:30Z' }),
        feature({ mmsi: 227965180, kind: 'vessel', seen: '2026-10-05T14:10:00Z' }),
        feature({ mmsi: 244000002, kind: 'vessel', seen: '2026-10-05T01:00:00Z' }),
        feature({ mmsi: 244000003, kind: 'vessel', seen: 'not a time' }),
        feature({ mmsi: 244000004, seen: '2026-10-05T14:00:00Z' }, [200, 10]),
      ],
    },
    { now: NOW, maxAgeMs: 30 * 60_000 },
  );
  assert.deepEqual(
    rows.map((row) => row.mmsi),
    ['235000001', '227965180'],
  );
  assert.deepEqual(rows[1], {
    lat: 49.74,
    lon: -1.85,
    name: 'LOS NINOS',
    mmsi: '227965180',
    imo: '',
    type: '36',
    destination: '',
    speed: 5.6,
    course: 109.3,
    heading: null,
    last_position_UTC: '2026-10-05T14:17:43.000Z',
    last_position_epoch: Date.parse('2026-10-05T14:17:43Z') / 1000,
  });
  // AIS "not available" codes are absences, not readings.
  assert.equal(rows[0].speed, null);
  assert.equal(rows[0].course, null);
  assert.equal(rows[0].heading, null);
  assert.equal(rows[0].name, 'MMSI 235000001');
});

test('a malformed payload yields no rows', () => {
  assert.deepEqual(normalizeOpenWatersCollection(null), []);
  assert.deepEqual(normalizeOpenWatersCollection({ features: 'x' }), []);
});

test('attribution lines are carried through, once each', () => {
  assert.deepEqual(
    openWatersAttribution({
      attribution: {
        aishub: 'Open Waters AIS (https://openwaters.io/ais/). AISHub (https://www.aishub.net)',
        station: 'Open Waters AIS (https://openwaters.io/ais/)',
        udp: 'Open Waters AIS (https://openwaters.io/ais/)',
      },
    }),
    [
      'Open Waters AIS (https://openwaters.io/ais/). AISHub (https://www.aishub.net)',
      'Open Waters AIS (https://openwaters.io/ais/)',
    ],
  );
  assert.deepEqual(openWatersAttribution({}), []);
});
