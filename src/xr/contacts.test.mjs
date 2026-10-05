import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createContactLayer, headingBasis } from './contacts.js';

const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`,
  );

test('a heading basis is a proper rotation pointing along the heading', () => {
  const up = new THREE.Vector3(0, 0, 1); // lat 0, lon 0
  const north = headingBasis(up, 0);
  close(north.determinant(), 1, 1e-9, 'right-handed');
  const forward = new THREE.Vector3(0, 0, 1).applyMatrix4(north);
  close(forward.y, 1, 1e-9, 'heading 0 points north');
  const east = new THREE.Vector3(0, 0, 1).applyMatrix4(headingBasis(up, 90));
  close(east.x, 1, 1e-9, 'heading 90 points east');
  const lift = new THREE.Vector3(0, 1, 0).applyMatrix4(north);
  close(lift.z, 1, 1e-9, 'local up is the surface normal');
});

test('a basis at the pole stays finite', () => {
  const basis = headingBasis(new THREE.Vector3(0, 1, 0), 45);
  assert.ok(basis.elements.every(Number.isFinite));
  close(basis.determinant(), 1, 1e-9, 'right-handed');
});

test('contacts land on the globe in world space and can be selected', () => {
  const globe = new THREE.Group();
  globe.scale.setScalar(0.25);
  globe.position.set(0, 1, -1);
  const layer = createContactLayer(globe);
  layer.setGlobeRadius(0.25);
  layer.setContacts('vessel', [
    { kind: 'vessel', id: 'vessel:1', lat: 0, lon: 0, label: 'A' },
  ]);
  layer.setContacts('aircraft', [
    {
      kind: 'aircraft',
      id: 'aircraft:2',
      lat: 0,
      lon: 90,
      altitudeM: 10_000,
      label: 'B',
    },
  ]);
  assert.deepEqual(layer.counts(), {
    aircraft: 1,
    military: 0,
    vessel: 1,
    satellite: 0,
    earthquake: 0,
  });
  const { points, owners } = layer.worldPoints();
  assert.equal(points.length, 2);
  const ship = points[owners.findIndex((owner) => owner.id === 'vessel:1')];
  close(
    ship.z,
    -1 + 0.25 * 1.006,
    1e-6,
    'the vessel sits just above the surface facing +Z',
  );
  layer.setVisible('aircraft', false);
  assert.equal(
    layer.worldPoints().points.length,
    1,
    'hidden layers are not pickable',
  );
  layer.select(owners[0]);
  assert.equal(layer.selected, owners[0]);
  layer.setContacts('vessel', []);
  assert.equal(layer.counts().vessel, 0);
});
