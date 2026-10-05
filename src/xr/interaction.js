/**
 * Turns every XR input into one of: a press on a panel (the toolkit already
 * owns it), a hold on the globe, a hold on the base, or a tap that selects.
 *
 * Direct first, as on a real desk globe. The globe is within reach, so:
 *   Hand: pinch on the globe            turn it like a ball; flick to spin
 *   Two hands on the globe              resize it by their spread, and turn
 *   Pinch or grip on the base's rim     carry the table; two hands turn it
 *   Quick pinch on a contact            select it
 * A ray is the fallback for a controller that is not at the globe and for
 * system pointers (gaze and pinch), which have no hand to reach with: it can
 * turn the globe from where it hits and tap-select along its line.
 */

import * as THREE from 'three';
import { isSpatialPointer } from './framework/xr-capabilities.js';
import { trackedHandPose } from './framework/xr-hands.js';
import {
  createSpinMomentum,
  isTap,
  pickAlongRay,
  pickNearPoint,
  raySphere,
  solveGlobeHold,
  solveTableCarry,
} from './manipulation.js';

// How close a fingertip pinch must be to a contact to select it directly.
const DIRECT_PICK = 0.03;
// Angular tolerance for selecting along a ray, in radians (about 2.3 deg).
const RAY_PICK = 0.04;
// A controller reaches from a point just ahead of its grip.
const CONTROLLER_TIP = 0.05;
// Rebuild marker sizes only when the radius has changed by this share.
const RESIZE_STEP = 0.03;

/**
 * @param {object} options
 * @param {import('./framework/xr-toolkit.js').XRToolkit} options.xr
 * @param {ReturnType<import('./globeTable.js').createGlobeTable>} options.globeTable
 * @param {ReturnType<import('./contacts.js').createContactLayer>} options.contacts
 * @param {{ captured(input: object): boolean }} options.panels
 * @param {(contact: object|null) => void} options.onSelect
 * @param {() => void} [options.onTableMoved] after a carry ends
 * @param {(input: object) => boolean} [options.onPressFirst] may consume a press first
 */
export function createGlobeInteraction({
  xr,
  globeTable,
  contacts,
  panels,
  onSelect,
  onTableMoved = () => {},
  onPressFirst = () => false,
}) {
  const { table, globe, pivot } = globeTable;
  const momentum = createSpinMomentum();
  const globeHolds = new Map();
  const carryHolds = new Map();
  const center = new THREE.Vector3();
  const parentQuaternion = new THREE.Quaternion();
  let globeStart = null;
  let carryStart = null;
  let lastRebuiltRadius = globeTable.radius;

  const states = xr.inputs.map((input) => {
    const state = { input, press: null, pinching: false, events: [] };
    // Controllers and system pointers report presses as events; tracked
    // hands are read from the toolkit's pinch state in update(). The edges
    // are queued so every press is handled in the frame loop, after the
    // toolkit has decided whether a panel took it.
    const queue = (kind) => () => {
      if (input.source?.hand && !isSpatialPointer(input.source)) return;
      state.events.push(kind);
    };
    input.controller.addEventListener('selectstart', queue('start'));
    input.controller.addEventListener('squeezestart', queue('start'));
    input.controller.addEventListener('selectend', queue('end'));
    input.controller.addEventListener('squeezeend', queue('end'));
    input.controller.addEventListener('disconnected', () => {
      cancel(state);
      state.events.length = 0;
      state.pinching = false;
    });
    return state;
  });

  const worldQuaternion = (target = new THREE.Quaternion()) => {
    globe.updateWorldMatrix(true, false);
    return globe.getWorldQuaternion(target);
  };
  const setWorldQuaternion = (quaternion) => {
    pivot.getWorldQuaternion(parentQuaternion);
    globe.quaternion.copy(parentQuaternion.invert().multiply(quaternion));
  };

  /** Where an input reaches from, or null (system pointers, lost hands). */
  function reachPoint(input) {
    const source = input.source;
    if (!source) return null;
    if (source.hand && !isSpatialPointer(source))
      return trackedHandPose(input.hand)?.position ?? null;
    if (isSpatialPointer(source))
      return input.grip?.visible
        ? input.grip.getWorldPosition(new THREE.Vector3())
        : null;
    const origin = input.controller.getWorldPosition(new THREE.Vector3());
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      input.controller.getWorldQuaternion(new THREE.Quaternion()),
    );
    return origin.addScaledVector(forward, CONTROLLER_TIP);
  }

  function rayOf(input) {
    const { origin, direction } = xr.aimOf(input);
    return { origin: origin.clone(), direction: direction.clone().normalize() };
  }

  /** The point on the hold sphere under a ray: its hit, or its nearest approach. */
  function rayOnSphere(ray, radius) {
    globeTable.center(center);
    const t = raySphere(ray.origin, ray.direction, center, radius);
    if (t != null) return ray.origin.clone().addScaledVector(ray.direction, t);
    const along = Math.max(
      0,
      center.clone().sub(ray.origin).dot(ray.direction),
    );
    const nearest = ray.origin.clone().addScaledVector(ray.direction, along);
    return center.clone().add(nearest.sub(center).setLength(radius));
  }

  function rebaseGlobe() {
    globeStart = { quaternion: worldQuaternion(), radius: globeTable.radius };
    for (const hold of globeHolds.values()) hold.from.copy(hold.at);
    momentum.reset();
  }
  function rebaseCarry() {
    carryStart = { position: table.position.clone(), yaw: table.rotation.y };
    for (const hold of carryHolds.values()) hold.from.copy(hold.at);
  }

  function begin(state) {
    const { input } = state;
    if (panels.captured(input) || input.aimHit) {
      state.press = { kind: 'ui' };
      return;
    }
    if (onPressFirst(input)) {
      state.press = { kind: 'consumed' };
      return;
    }
    const now = performance.now();
    const reach = reachPoint(input);
    if (reach && globeTable.onGlobe(reach)) {
      state.press = {
        kind: 'globe',
        direct: true,
        startMs: now,
        travel: 0,
        origin: reach.clone(),
      };
      globeHolds.set(input, { from: reach.clone(), at: reach.clone() });
      rebaseGlobe();
      return;
    }
    if (reach && globeTable.onBase(reach)) {
      state.press = {
        kind: 'carry',
        startMs: now,
        travel: 0,
        origin: reach.clone(),
      };
      carryHolds.set(input, { from: reach.clone(), at: reach.clone() });
      rebaseCarry();
      return;
    }
    const ray = rayOf(input);
    globeTable.center(center);
    const t = raySphere(
      ray.origin,
      ray.direction,
      center,
      globeTable.radius * 1.02,
    );
    if (t != null) {
      const anchor = ray.origin.clone().addScaledVector(ray.direction, t);
      state.press = {
        kind: 'globe',
        direct: false,
        startMs: now,
        travel: 0,
        origin: anchor.clone(),
        sphere: anchor.distanceTo(center),
        ray,
      };
      globeHolds.set(input, { from: anchor.clone(), at: anchor.clone() });
      rebaseGlobe();
      return;
    }
    // Nothing under the press but sky: a tap may still select a satellite.
    state.press = { kind: 'air', startMs: now, travel: 0, ray };
  }

  /** Select the contact a finished tap meant, or clear the selection. */
  function selectFromTap(state) {
    const { press, input } = state;
    const { points, owners } = contacts.worldPoints();
    let index = -1;
    if (press.kind === 'globe' && press.direct) {
      index = pickNearPoint(press.origin, points, DIRECT_PICK);
    } else {
      const ray = press.ray ?? rayOf(input);
      globeTable.center(center);
      const direction = new THREE.Vector3();
      index = pickAlongRay(
        ray.origin,
        ray.direction,
        points,
        RAY_PICK,
        (i, distance) => {
          // Contacts on the far side are behind the Earth.
          direction.copy(points[i]).sub(ray.origin).normalize();
          const t = raySphere(ray.origin, direction, center, globeTable.radius);
          return t != null && t < distance - 0.002;
        },
      );
    }
    const contact = index >= 0 ? owners[index] : null;
    contacts.select(contact);
    onSelect(contact);
  }

  function end(state, { allowTap = true } = {}) {
    const { press, input } = state;
    state.press = null;
    if (!press || press.kind === 'ui' || press.kind === 'consumed') return;
    const tap =
      allowTap && isTap(performance.now() - press.startMs, press.travel);
    if (press.kind === 'globe') {
      globeHolds.delete(input);
      if (globeHolds.size) rebaseGlobe();
      else if (tap) momentum.reset();
      else momentum.release();
      syncRadius(true);
    }
    if (press.kind === 'carry') {
      carryHolds.delete(input);
      if (carryHolds.size) rebaseCarry();
      else onTableMoved();
      return;
    }
    if (tap) selectFromTap({ press, input });
  }

  function cancel(state) {
    if (state.press) end(state, { allowTap: false });
  }

  function syncRadius(force = false) {
    const radius = globeTable.radius;
    if (
      force ||
      Math.abs(radius - lastRebuiltRadius) / lastRebuiltRadius > RESIZE_STEP
    ) {
      contacts.setGlobeRadius(radius);
      lastRebuiltRadius = radius;
    }
  }

  return {
    get holding() {
      return globeHolds.size > 0 || carryHolds.size > 0;
    },
    get carrying() {
      return carryHolds.size > 0;
    },
    /** Stop a coasting globe (for example before re-orienting it). */
    stopSpin() {
      momentum.reset();
    },
    /** Drop every hold without selecting, e.g. on session end. */
    reset() {
      for (const state of states) {
        cancel(state);
        state.events.length = 0;
        state.pinching = false;
      }
      momentum.reset();
    },
    /** Run after XRToolkit.update() each presenting frame. */
    update(dt) {
      for (const state of states) {
        const { input } = state;
        if (input.source?.hand && !isSpatialPointer(input.source)) {
          const pose = trackedHandPose(input.hand);
          if (!pose) {
            // Tracking lost: let go without selecting or flinging.
            if (state.press) end(state, { allowTap: false });
            momentum.reset();
            state.pinching = false;
            continue;
          }
          if (input.pinching && !state.pinching) begin(state);
          else if (!input.pinching && state.pinching) end(state);
          state.pinching = input.pinching;
        } else {
          for (const event of state.events.splice(0)) {
            if (event === 'start' && !state.press) begin(state);
            else if (event === 'end' && state.press) end(state);
          }
        }
        const press = state.press;
        if (!press || press.kind === 'ui' || press.kind === 'consumed')
          continue;
        if (press.kind === 'air') {
          press.ray = rayOf(input);
          continue;
        }
        let at = null;
        if (press.kind === 'globe' && !press.direct) {
          press.ray = rayOf(input);
          at = rayOnSphere(press.ray, press.sphere);
        } else {
          at = reachPoint(input);
        }
        if (!at) {
          end(state, { allowTap: false });
          continue;
        }
        press.travel = Math.max(press.travel, at.distanceTo(press.origin));
        const hold = (press.kind === 'globe' ? globeHolds : carryHolds).get(
          input,
        );
        hold?.at.copy(at);
      }

      if (globeHolds.size && globeStart) {
        globeTable.center(center);
        const solved = solveGlobeHold(
          globeStart,
          [...globeHolds.values()],
          center,
        );
        setWorldQuaternion(solved.quaternion);
        if (solved.radius !== globeTable.radius) {
          globeTable.setRadius(solved.radius);
          syncRadius();
        }
        if (globeHolds.size === 1) momentum.sample(solved.quaternion, dt);
      } else {
        const quaternion = worldQuaternion();
        if (momentum.coast(quaternion, dt)) setWorldQuaternion(quaternion);
      }
      if (carryHolds.size && carryStart) {
        const solved = solveTableCarry(carryStart, [...carryHolds.values()]);
        table.position.copy(solved.position);
        table.rotation.set(0, solved.yaw, 0);
      }
    },
    get coasting() {
      return momentum.velocity.lengthSq() > 0;
    },
  };
}
