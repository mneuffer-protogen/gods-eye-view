import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  GLOBE_LIMITS,
  TABLE_LIMITS,
  createSpinMomentum,
  isTap,
  pickAlongRay,
  pickNearPoint,
  raySphere,
  solveGlobeHold,
  solveTableCarry,
} from './manipulation.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const close = (actual, expected, tolerance, message) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected}`,
  );

test('one hand turns the globe so the grabbed point follows the hand', () => {
  const center = v(0, 1, -1);
  const start = { quaternion: new THREE.Quaternion(), radius: 0.25 };
  const from = v(0, 1, -0.75);
  const at = v(0.25, 1, -1);
  const { quaternion, radius } = solveGlobeHold(start, [{ from, at }], center);
  assert.equal(radius, 0.25, 'one hand never resizes');
  const grabbed = v(0, 0, 0.25).applyQuaternion(quaternion);
  close(grabbed.x, 0.25, 1e-9, 'the grabbed point is now under the hand');
  close(grabbed.z, 0, 1e-9, 'and has left its old place');
});

test('two hands resize the globe by their spread, within limits', () => {
  const center = v(0, 1, -1);
  const start = { quaternion: new THREE.Quaternion(), radius: 0.25 };
  const holds = [
    { from: v(-0.1, 1, -1), at: v(-0.2, 1, -1) },
    { from: v(0.1, 1, -1), at: v(0.2, 1, -1) },
  ];
  close(
    solveGlobeHold(start, holds, center).radius,
    0.5,
    1e-9,
    'double spread doubles the radius',
  );
  const wide = [
    { from: v(-0.1, 1, -1), at: v(-1, 1, -1) },
    { from: v(0.1, 1, -1), at: v(1, 1, -1) },
  ];
  assert.equal(
    solveGlobeHold(start, wide, center).radius,
    GLOBE_LIMITS.maxRadius,
  );
});

test('two hands held together only keep the pose', () => {
  const start = { quaternion: new THREE.Quaternion(), radius: 0.3 };
  const holds = [
    { from: v(0, 1, -1), at: v(0.01, 1, -1) },
    { from: v(0.02, 1, -1), at: v(0.02, 1.01, -1) },
  ];
  const result = solveGlobeHold(start, holds, v(0, 1, -1));
  assert.equal(result.radius, 0.3);
  close(result.quaternion.w, 1, 1e-12, 'no turn');
});

test('one hand carries the table, height clamped', () => {
  const start = { position: v(0, 0.8, -1), yaw: 0.3 };
  const moved = solveTableCarry(start, [
    { from: v(0.3, 0.8, -1), at: v(0.5, 1, -1.2) },
  ]);
  close(moved.position.x, 0.2, 1e-9, 'x');
  close(moved.position.y, 1, 1e-9, 'y');
  close(moved.position.z, -1.2, 1e-9, 'z');
  assert.equal(moved.yaw, 0.3);
  const low = solveTableCarry(start, [
    { from: v(0, 0.8, -1), at: v(0, -1, -1) },
  ]);
  assert.equal(low.position.y, TABLE_LIMITS.minHeight);
});

test('two hands turn the table about their midpoint', () => {
  const start = { position: v(0, 0.8, -1), yaw: 0 };
  const holds = [
    { from: v(-0.3, 0.8, -1), at: v(0, 0.8, -1.3) },
    { from: v(0.3, 0.8, -1), at: v(0, 0.8, -0.7) },
  ];
  const result = solveTableCarry(start, holds);
  close(Math.abs(result.yaw), Math.PI / 2, 1e-9, 'a quarter turn');
  close(result.position.x, 0, 1e-9, 'the pivot stays put');
  close(result.position.z, -1, 1e-9, 'the pivot stays put');
});

test('a flicked globe coasts and comes to rest', () => {
  const momentum = createSpinMomentum();
  const q = new THREE.Quaternion();
  const step = new THREE.Quaternion().setFromAxisAngle(v(0, 1, 0), 0.05);
  for (let i = 0; i < 20; i++) {
    q.premultiply(step);
    momentum.sample(q, 1 / 60);
  }
  close(momentum.velocity.y, 3, 0.05, 'measured spin about +Y in rad/s');
  momentum.release();
  const before = q.clone();
  assert.equal(momentum.coast(q, 1 / 60), true);
  assert.ok(q.angleTo(before) > 0, 'still turning after release');
  let frames = 0;
  while (momentum.coast(q, 1 / 60) && frames < 10_000) frames++;
  assert.ok(frames < 10_000, 'it stops');
});

test('a quick still press is a tap, a long or moving one is not', () => {
  assert.equal(isTap(150, 0.005), true);
  assert.equal(isTap(900, 0.005), false);
  assert.equal(isTap(150, 0.08), false);
});

test('ray sphere intersection finds the near face', () => {
  close(
    raySphere(v(0, 0, 2), v(0, 0, -1), v(0, 0, 0), 1),
    1,
    1e-12,
    'front face',
  );
  assert.equal(raySphere(v(0, 2, 2), v(0, 0, -1), v(0, 0, 0), 1), null, 'miss');
  close(
    raySphere(v(0, 0, 0), v(0, 0, -1), v(0, 0, 0), 1),
    1,
    1e-12,
    'from inside',
  );
});

test('picking prefers the smallest angle and honours a veto', () => {
  const points = [v(0.1, 0, -1), v(0.02, 0, -1), v(0, 0, 1)];
  assert.equal(pickAlongRay(v(0, 0, 0), v(0, 0, -1), points, 0.2), 1);
  assert.equal(
    pickAlongRay(v(0, 0, 0), v(0, 0, -1), points, 0.2, (i) => i === 1),
    0,
  );
  assert.equal(
    pickAlongRay(v(0, 0, 0), v(0, 0, -1), points, 0.01),
    -1,
    'outside the cone',
  );
  assert.equal(pickNearPoint(v(0.09, 0, -1), points, 0.05), 0);
  assert.equal(pickNearPoint(v(5, 5, 5), points, 0.05), -1);
});

test('the table starts an arm ahead of the head, below the eyes, facing it', async () => {
  const { tablePoseInFront, START } = await import('./manipulation.js');
  const head = v(0.2, 1.6, 0.5);
  const { position, yaw } = tablePoseInFront(head, v(0, -0.4, -1));
  close(position.x, 0.2, 1e-9, 'straight ahead');
  close(position.z, 0.5 - START.distance, 1e-9, 'an arm away');
  close(position.y, 1.6 - START.drop, 1e-9, 'below the eyes');
  const facing = v(Math.sin(yaw), 0, Math.cos(yaw));
  close(facing.z, 1, 1e-9, 'its front faces the head');
  const seated = tablePoseInFront(v(0, 0.9, 0), v(0, 0, -1));
  assert.equal(seated.position.y, START.minHeight, 'never down on the floor');
});

test('a tilted facing shows the focus to eyes above the globe', async () => {
  const { tiltedFacing } = await import('./manipulation.js');
  const { facingQuaternion, latLonToVector } = await import('./geo.js');
  const q = tiltedFacing(facingQuaternion(30, -97), Math.PI / 6);
  const p = latLonToVector(30, -97);
  const turned = v(p.x, p.y, p.z).applyQuaternion(q);
  close(
    turned.y,
    Math.sin(Math.PI / 6),
    1e-9,
    'the focus tips up toward the eyes',
  );
  close(turned.x, 0, 1e-9, 'and stays centred');
});
