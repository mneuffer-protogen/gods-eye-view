/**
 * Live contacts on the tabletop map, in table metres under the map table, so
 * marker sizes stay the same on the glass at every zoom. One instanced mesh
 * per kind; only contacts over the window are drawn, and the window's clip
 * trims those at its edge.
 *
 * Aircraft stand over the ground at their altitude, exaggerated so the
 * cruising band reads at arm's length, each with a drop line to the ground
 * under it. Vessels sit on the water; earthquakes are rings on the ground.
 * Satellites stay on the globe: their orbits are far off any regional map.
 */

import * as THREE from 'three';
import { CONTACT_STYLE } from './contacts.js';

export const MAP_MARKERS = Object.freeze({
  aircraft: 0.012,
  military: 0.014,
  vessel: 0.009,
  earthquake: 0.014,
  // Altitude is drawn at this multiple of the map's true scale, between a
  // floor that keeps a landing aircraft off the ground and a ceiling that
  // keeps the cruising band within the table's reach.
  airExaggeration: 3,
  airFloor: 0.008,
  airCeiling: 0.16,
});

const MAP_KINDS = ['aircraft', 'military', 'vessel', 'earthquake'];
const DEG = Math.PI / 180;

/**
 * Table-local position and turn for one contact, or null when it is off the
 * window. Pure apart from the callbacks, so the unit suite covers it.
 * @param {object} contact `{ kind, lat, lon, altitudeM?, headingDeg? }`
 * @param {object} map `{ frame, toTable(site), view, scale, window,
 *   groundAt(siteX, siteZ) -> table y, seaLevel -> table y }`
 */
export function mapContactPose(contact, map) {
  const site = map.frame.toScene(contact.lon, contact.lat);
  const table = map.toTable(site);
  if (Math.hypot(table.x, table.z) > map.window / 2 + 0.03) return null;
  const ground = map.groundAt(site.x, site.z);
  let y;
  if (contact.kind === 'aircraft' || contact.kind === 'military') {
    const altitude = Number.isFinite(contact.altitudeM)
      ? Math.max(0, contact.altitudeM)
      : 0;
    const lift = Math.min(
      MAP_MARKERS.airCeiling,
      Math.max(
        MAP_MARKERS.airFloor,
        altitude * map.scale * MAP_MARKERS.airExaggeration,
      ),
    );
    y = Math.max(ground + MAP_MARKERS.airFloor, map.seaLevel + lift);
  } else if (contact.kind === 'vessel') {
    y = Math.max(ground, map.seaLevel) + 0.002;
  } else {
    y = ground + 0.002;
  }
  // The arrow's tip is +Z; north on the site is -Z, turned by the view.
  const heading = Number.isFinite(contact.headingDeg) ? contact.headingDeg : 0;
  return {
    x: table.x,
    y,
    z: table.z,
    ground,
    turn: Math.PI - heading * DEG + map.view.yaw,
  };
}

function arrowGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.6);
  shape.lineTo(0.42, -0.45);
  shape.lineTo(0, -0.2);
  shape.lineTo(-0.42, -0.45);
  shape.closePath();
  return new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
}

/** Create the map's contact layer under `mapTable.contactRoot`. */
export function createMapContacts(mapTable) {
  const layers = {};
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const kind of MAP_KINDS) {
    const style = CONTACT_STYLE[kind];
    const quake = kind === 'earthquake';
    const mesh = new THREE.InstancedMesh(
      quake
        ? new THREE.RingGeometry(0.62, 1, 32, 1).rotateX(-Math.PI / 2)
        : arrowGeometry(),
      new THREE.MeshBasicMaterial({
        color: style.color,
        toneMapped: false,
        side: THREE.DoubleSide,
        transparent: quake,
        opacity: quake ? 0.9 : 1,
        depthWrite: !quake,
        clippingPlanes: mapTable.planes,
      }),
      style.capacity,
    );
    mesh.name = `${kind} map contacts`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mapTable.contactRoot.add(mesh);
    layers[kind] = {
      kind,
      mesh,
      contacts: [],
      shown: [],
      points: new Float32Array(style.capacity * 3),
    };
  }

  // Drop lines from each aircraft to the ground under it: one segment pair
  // per aircraft, both kinds in one draw.
  const dropCapacity =
    CONTACT_STYLE.aircraft.capacity + CONTACT_STYLE.military.capacity;
  const dropPositions = new Float32Array(dropCapacity * 6);
  const dropGeometry = new THREE.BufferGeometry();
  dropGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(dropPositions, 3).setUsage(
      THREE.DynamicDrawUsage,
    ),
  );
  const drops = new THREE.LineSegments(
    dropGeometry,
    new THREE.LineBasicMaterial({
      color: '#9fdcff',
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      toneMapped: false,
      clippingPlanes: mapTable.planes,
    }),
  );
  drops.frustumCulled = false;
  mapTable.contactRoot.add(drops);

  const highlight = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: '#ffffff',
      toneMapped: false,
      side: THREE.DoubleSide,
      transparent: true,
      depthTest: false,
    }),
  );
  highlight.renderOrder = 5;
  highlight.visible = false;
  mapTable.contactRoot.add(highlight);
  let selected = null;
  let time = 0;

  /**
   * Re-place every shown contact for the current view. `map` is the
   * placement context mapContactPose takes.
   */
  function rebuild(map) {
    let dropCount = 0;
    highlight.visible = false;
    for (const layer of Object.values(layers)) {
      layer.shown = [];
      if (!layer.mesh.visible) {
        layer.mesh.count = 0;
        continue;
      }
      const capacity = CONTACT_STYLE[layer.kind].capacity;
      const air = layer.kind === 'aircraft' || layer.kind === 'military';
      for (const contact of layer.contacts) {
        if (layer.shown.length >= capacity) break;
        const pose = mapContactPose(contact, map);
        if (!pose) continue;
        const i = layer.shown.length;
        let size = MAP_MARKERS[layer.kind];
        if (layer.kind === 'earthquake')
          size *= 0.6 + Math.max(0, (contact.magnitude ?? 3) - 2.5) * 0.45;
        position.set(pose.x, pose.y, pose.z);
        quaternion.setFromAxisAngle(up, pose.turn);
        scale.setScalar(size);
        matrix.compose(position, quaternion, scale);
        layer.mesh.setMatrixAt(i, matrix);
        layer.points.set([pose.x, pose.y, pose.z], i * 3);
        layer.shown.push(contact);
        if (air && pose.y - pose.ground > 0.004) {
          dropPositions.set(
            [pose.x, pose.y, pose.z, pose.x, pose.ground, pose.z],
            dropCount * 6,
          );
          dropCount++;
        }
        if (
          selected &&
          contact.id === selected.id &&
          contact.kind === selected.kind
        ) {
          highlight.position.set(pose.x, pose.y, pose.z);
          highlight.scale.setScalar(0.022);
          highlight.visible = true;
        }
      }
      layer.mesh.count = layer.shown.length;
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
    dropGeometry.setDrawRange(0, dropCount * 2);
    dropGeometry.attributes.position.needsUpdate = true;
  }

  const world = new THREE.Vector3();
  return {
    layers,
    rebuild,
    setContacts(kind, contacts) {
      if (layers[kind]) layers[kind].contacts = contacts;
    },
    setVisible(kind, visible) {
      if (layers[kind]) layers[kind].mesh.visible = visible;
    },
    select(contact) {
      selected = contact || null;
    },
    /** Pulse the selection ring. */
    animate(dt) {
      time += dt;
      if (highlight.visible)
        highlight.material.opacity = 0.65 + 0.35 * Math.sin(time * 5);
    },
    /** Every drawn contact's world position, for picking. Allocates. */
    worldPoints() {
      mapTable.group.updateMatrixWorld(true);
      const points = [];
      const owners = [];
      for (const layer of Object.values(layers)) {
        if (!layer.mesh.visible) continue;
        layer.shown.forEach((contact, i) => {
          world
            .set(
              layer.points[i * 3],
              layer.points[i * 3 + 1],
              layer.points[i * 3 + 2],
            )
            .applyMatrix4(mapTable.group.matrixWorld);
          points.push(world.clone());
          owners.push(contact);
        });
      }
      return { points, owners };
    },
  };
}
