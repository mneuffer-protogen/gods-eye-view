import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  aircraftRadius,
  contactRadius,
  facingQuaternion,
  latLonToVector,
  orbitRadius,
  sunDirection,
  vectorToLatLon,
} from './geo.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`,
  );

test('the globe frame is north-up with Greenwich facing +Z and east to the right', () => {
  const greenwich = latLonToVector(0, 0);
  close(greenwich.z, 1, 1e-12, 'lat 0 lon 0 is +Z');
  const east = latLonToVector(0, 90);
  close(east.x, 1, 1e-12, 'lon 90E is +X');
  const north = latLonToVector(90, 0);
  close(north.y, 1, 1e-12, 'the north pole is +Y');
});

test('latitude and longitude round-trip through globe-local vectors', () => {
  for (const [lat, lon] of [
    [30.2672, -97.7431],
    [-33.86, 151.21],
    [64.1, -21.9],
    [0, 179.5],
  ]) {
    const back = vectorToLatLon(latLonToVector(lat, lon, 2.5));
    close(back.lat, lat, 1e-9, 'latitude');
    close(back.lon, lon, 1e-9, 'longitude');
  }
});

test('the facing quaternion turns a place toward +Z with north kept up', () => {
  for (const [lat, lon] of [
    [30.2672, -97.7431],
    [51.5, -0.12],
    [-41.3, 174.8],
  ]) {
    const { x, y, z, w } = facingQuaternion(lat, lon);
    const q = new THREE.Quaternion(x, y, z, w);
    const p = latLonToVector(lat, lon);
    const turned = new THREE.Vector3(p.x, p.y, p.z).applyQuaternion(q);
    close(turned.z, 1, 1e-9, 'the place faces the viewer');
    const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    close(pole.x, 0, 1e-9, 'the north pole does not lean sideways');
    assert.ok(pole.y > 0, 'north stays up');
  }
});

test('aircraft lift orders by altitude inside a thin shell', () => {
  assert.ok(aircraftRadius(0) > 1);
  assert.ok(aircraftRadius(11_000) > aircraftRadius(3_000));
  assert.equal(
    aircraftRadius(40_000),
    aircraftRadius(15_000),
    'clamped at the ceiling',
  );
  assert.equal(
    aircraftRadius(Number.NaN),
    aircraftRadius(0),
    'unknown altitude is ground level',
  );
});

test('orbits are true scale low and compressed high', () => {
  close(orbitRadius(1_000), 1 + 1_000 / 6_371.0088, 1e-9, 'LEO is true scale');
  const geo = orbitRadius(35_786);
  assert.ok(geo > orbitRadius(20_200), 'GEO sits above GPS');
  assert.ok(geo < 2.1, `GEO stays within reach of the globe (${geo})`);
  assert.ok(
    orbitRadius(300) > aircraftRadius(15_000),
    'satellites never sit under aircraft',
  );
});

test('contact radius depends on kind', () => {
  assert.ok(
    contactRadius({ kind: 'vessel' }) <
      contactRadius({ kind: 'aircraft', altitudeM: 0 }),
  );
  assert.ok(contactRadius({ kind: 'earthquake' }) > 1);
  assert.equal(
    contactRadius({ kind: 'satellite', altitudeKm: 550 }),
    orbitRadius(550),
  );
});

test('the sun sits over the tropic of Cancer at the June solstice', () => {
  const sun = sunDirection(new Date('2024-06-20T20:51:00Z'));
  const { lat, lon } = vectorToLatLon(sun);
  close(lat, 23.44, 0.3, 'subsolar latitude');
  // 20:51 UTC is about 132 degrees west of Greenwich's noon.
  close(lon, -133, 3, 'subsolar longitude');
});

test('the sun crosses the equator near the March equinox', () => {
  const { lat } = vectorToLatLon(
    sunDirection(new Date('2025-03-20T09:01:00Z')),
  );
  close(lat, 0, 0.3, 'subsolar latitude');
});

test('the start focus comes from the URL, else the time zone', async () => {
  const { startFocus } = await import('./geo.js');
  assert.deepEqual(startFocus('?lat=30.2672&lon=-97.7431'), {
    lat: 30.2672,
    lon: -97.7431,
    fromUrl: true,
  });
  assert.deepEqual(startFocus('?lat=91&lon=0', 300), {
    lat: 30,
    lon: -75,
    fromUrl: false,
  });
  assert.deepEqual(startFocus('', -540), { lat: 30, lon: 135, fromUrl: false });
});
