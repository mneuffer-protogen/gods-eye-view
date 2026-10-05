/**
 * Hand and controller manipulation of the tabletop globe, as pure solvers.
 *
 * Two things can be held. The globe itself turns like a ball under the hand
 * (one hold) and grows or shrinks with the spread of two hands. The base it
 * floats over carries the whole table: one hand moves it, height included,
 * and two hands move it by their midpoint and turn it with the line between
 * them. Nothing snaps; everything stays where it is released. Each solve
 * starts from the pose captured when the hold began, so error never
 * accumulates frame over frame.
 */

import * as THREE from 'three';

export const GLOBE_LIMITS = Object.freeze({
  minRadius: 0.12,
  maxRadius: 0.6,
  // Hands this close together say nothing reliable about spread or angle.
  steadyGap: 0.06,
});

export const TABLE_LIMITS = Object.freeze({
  minHeight: 0.35,
  maxHeight: 1.6,
});

// After a flick the globe keeps turning and slows to rest; the spin a hand
// can impart is capped so a tracking glitch cannot fling it.
export const MOMENTUM = Object.freeze({
  damping: 1.6,
  maxSpeed: 6,
  restSpeed: 0.04,
  smoothing: 0.35,
});

// A press that ends this quickly, having moved this little, is a tap: it
// selects instead of turning.
export const TAP = Object.freeze({ maxMs: 320, maxTravel: 0.02 });

const UP = new THREE.Vector3(0, 1, 0);

// Where the table first appears: an arm's length ahead and well below the
// eyes, so the globe sits like a desk globe rather than in the face.
export const START = Object.freeze({
  distance: 0.62,
  drop: 0.78,
  minHeight: 0.45,
  maxHeight: 1.2,
});

/** Yaw that turns an object at `from` so its local +Z faces `toward`. */
export function yawToward(from, toward) {
  return Math.atan2(toward.x - from.x, toward.z - from.z);
}

/**
 * Table pose in front of a head at `head` looking along `forward` (both
 * world space). Returns `{ position, yaw }` with the table facing the head.
 */
export function tablePoseInFront(head, forward, start = START) {
  const flat = new THREE.Vector3(forward.x, 0, forward.z);
  if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
  flat.normalize();
  const position = new THREE.Vector3(
    head.x + flat.x * start.distance,
    THREE.MathUtils.clamp(
      head.y - start.drop,
      start.minHeight,
      start.maxHeight,
    ),
    head.z + flat.z * start.distance,
  );
  return { position, yaw: yawToward(position, head) };
}

/**
 * Local globe orientation (under a pivot already turned to face the viewer)
 * that shows `facing` — a quaternion putting the focus at +Z with north up —
 * tipped up toward eyes `elevation` radians above the globe centre.
 */
export function tiltedFacing(facing, elevation) {
  const tilt = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(1, 0, 0),
    -elevation,
  );
  return tilt.multiply(
    new THREE.Quaternion(facing.x, facing.y, facing.z, facing.w),
  );
}

/** Whether a press of `durationMs` that travelled `travel` metres is a tap. */
export function isTap(durationMs, travel) {
  return durationMs <= TAP.maxMs && travel <= TAP.maxTravel;
}

/**
 * Globe pose for the current holds. `start` is `{ quaternion, radius }` at
 * the moment the holds began; each hold is `{ from, at }` in world space and
 * `center` is the globe's world centre.
 */
export function solveGlobeHold(start, holds, center, limits = GLOBE_LIMITS) {
  const quaternion = start.quaternion.clone();
  let radius = start.radius;
  if (holds.length === 1) {
    const [hold] = holds;
    const a = hold.from.clone().sub(center);
    const b = hold.at.clone().sub(center);
    if (a.lengthSq() > 1e-8 && b.lengthSq() > 1e-8) {
      const turn = new THREE.Quaternion().setFromUnitVectors(
        a.normalize(),
        b.normalize(),
      );
      quaternion.premultiply(turn);
    }
  } else if (holds.length >= 2) {
    const [first, second] = holds;
    const before = second.from.clone().sub(first.from);
    const after = second.at.clone().sub(first.at);
    const gap0 = before.length();
    const gap = after.length();
    if (gap0 >= limits.steadyGap && gap >= limits.steadyGap) {
      radius = THREE.MathUtils.clamp(
        start.radius * (gap / gap0),
        limits.minRadius,
        limits.maxRadius,
      );
      const turn = new THREE.Quaternion().setFromUnitVectors(
        before.normalize(),
        after.normalize(),
      );
      quaternion.premultiply(turn);
    }
  }
  return { quaternion: quaternion.normalize(), radius };
}

/**
 * Table pose for the current holds on its base. `start` is
 * `{ position, yaw }` when the holds began; each hold is `{ from, at }` in
 * world space. Returns `{ position, yaw }`.
 */
export function solveTableCarry(start, holds, limits = TABLE_LIMITS) {
  const clampY = (y) =>
    THREE.MathUtils.clamp(y, limits.minHeight, limits.maxHeight);
  if (!holds.length)
    return { position: start.position.clone(), yaw: start.yaw };
  if (holds.length === 1) {
    const [hold] = holds;
    const position = start.position.clone().add(hold.at).sub(hold.from);
    position.y = clampY(position.y);
    return { position, yaw: start.yaw };
  }
  const [a, b] = holds;
  const pivot0 = a.from.clone().add(b.from).multiplyScalar(0.5);
  const pivot = a.at.clone().add(b.at).multiplyScalar(0.5);
  const gap0 = Math.hypot(b.from.x - a.from.x, b.from.z - a.from.z);
  const gap = Math.hypot(b.at.x - a.at.x, b.at.z - a.at.z);
  const steady =
    gap0 < GLOBE_LIMITS.steadyGap * 2 || gap < GLOBE_LIMITS.steadyGap * 2;
  const turn = steady
    ? 0
    : Math.atan2(b.at.x - a.at.x, b.at.z - a.at.z) -
      Math.atan2(b.from.x - a.from.x, b.from.z - a.from.z);
  const offset = start.position.clone().sub(pivot0);
  offset.y = 0;
  offset.applyAxisAngle(UP, turn);
  const position = new THREE.Vector3(
    pivot.x + offset.x,
    clampY(start.position.y + pivot.y - pivot0.y),
    pivot.z + offset.z,
  );
  return { position, yaw: start.yaw + turn };
}

/**
 * Tracks the globe's angular velocity while it is held and lets it coast
 * after release. Angular velocity is a world-space axis scaled by rad/s.
 */
export function createSpinMomentum(limits = MOMENTUM) {
  const velocity = new THREE.Vector3();
  const previous = new THREE.Quaternion();
  const delta = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  let sampling = false;
  return {
    velocity,
    /** Forget any motion, e.g. when a new hold begins. */
    reset() {
      velocity.set(0, 0, 0);
      sampling = false;
    },
    /** Record the held orientation for this frame. */
    sample(quaternion, dt) {
      if (sampling && dt > 1e-4) {
        delta.copy(quaternion).multiply(previous.clone().invert()).normalize();
        if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
        const s = Math.sqrt(Math.max(0, 1 - delta.w * delta.w));
        if (s > 1e-6) axis.set(delta.x / s, delta.y / s, delta.z / s);
        else axis.set(0, 0, 0);
        const instant = axis.multiplyScalar(angle / dt);
        velocity.lerp(instant, limits.smoothing);
        if (velocity.length() > limits.maxSpeed)
          velocity.setLength(limits.maxSpeed);
      }
      previous.copy(quaternion);
      sampling = true;
    },
    /** Stop sampling; the next coast() continues from the last velocity. */
    release() {
      sampling = false;
    },
    /**
     * Apply one frame of coasting to `quaternion` in place. Returns whether
     * the globe is still moving.
     */
    coast(quaternion, dt) {
      const speed = velocity.length();
      if (speed < limits.restSpeed) {
        velocity.set(0, 0, 0);
        return false;
      }
      axis.copy(velocity).divideScalar(speed);
      delta.setFromAxisAngle(axis, speed * dt);
      quaternion.premultiply(delta).normalize();
      velocity.multiplyScalar(Math.exp(-limits.damping * dt));
      return true;
    },
  };
}

/**
 * Nearest intersection distance of a ray with a sphere, or null. `direction`
 * must be normalized.
 */
export function raySphere(origin, direction, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const near = -b - root;
  if (near >= 0) return near;
  const far = -b + root;
  return far >= 0 ? far : null;
}

/**
 * Index of the point nearest a ray by angle, within `maxAngle` radians, or
 * -1. `points` is an array of world positions; `blocked(index, distance)`
 * may veto a candidate (for example one hidden behind the globe).
 */
export function pickAlongRay(
  origin,
  direction,
  points,
  maxAngle,
  blocked = () => false,
) {
  let best = -1;
  let bestAngle = maxAngle;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const dz = p.z - origin.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-6) continue;
    const cos =
      (dx * direction.x + dy * direction.y + dz * direction.z) / distance;
    if (cos <= 0) continue;
    const angle = Math.acos(Math.min(1, cos));
    if (angle < bestAngle && !blocked(i, distance)) {
      best = i;
      bestAngle = angle;
    }
  }
  return best;
}

/** Index of the point nearest `target` within `maxDistance` metres, or -1. */
export function pickNearPoint(target, points, maxDistance) {
  let best = -1;
  let bestDistance = maxDistance;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const distance = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}
