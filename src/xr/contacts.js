/**
 * Live contacts on the tabletop globe, one instanced mesh per kind so ten
 * thousand aircraft cost one draw call. Positions live in the globe's unit
 * sphere space, so turning or resizing the globe carries them; marker sizes
 * are divided by the globe radius so they stay the same physical size.
 *
 * Aircraft and vessels are arrowheads lying on the sphere and pointing along
 * their heading; satellites are small diamonds; earthquakes are rings on the
 * ground sized by magnitude that pulse while they are less than an hour old.
 */

import * as THREE from 'three';
import { contactRadius, latLonToVector } from './geo.js';

export const CONTACT_STYLE = Object.freeze({
  aircraft: Object.freeze({
    color: '#00d4ff',
    size: 0.0042,
    capacity: 16_000,
    label: 'AIRCRAFT',
  }),
  military: Object.freeze({
    color: '#ffb020',
    size: 0.005,
    capacity: 3_000,
    label: 'MILITARY AIRCRAFT',
  }),
  vessel: Object.freeze({
    color: '#3ddc97',
    size: 0.0034,
    capacity: 16_000,
    label: 'VESSEL',
  }),
  satellite: Object.freeze({
    color: '#d7c6ff',
    size: 0.0034,
    capacity: 3_000,
    label: 'SATELLITE',
  }),
  earthquake: Object.freeze({
    color: '#ff4d6d',
    size: 0.006,
    capacity: 2_000,
    label: 'EARTHQUAKE',
  }),
});

// Feed id -> the contact kinds it fills.
export const FEED_KINDS = Object.freeze({
  aircraft: ['aircraft'],
  military: ['military'],
  vessels: ['vessel'],
  satellites: ['satellite'],
  earthquakes: ['earthquake'],
});

const DEG = Math.PI / 180;

/** Arrowhead lying in the XZ plane, pointing +Z, unit length. */
function arrowGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.6);
  shape.lineTo(0.42, -0.45);
  shape.lineTo(0, -0.2);
  shape.lineTo(-0.42, -0.45);
  shape.closePath();
  // Shape is drawn in XY; lay it in XZ with the tip toward +Z.
  return new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2);
}

function diamondGeometry() {
  return new THREE.OctahedronGeometry(0.5, 0);
}

function quakeGeometry() {
  return new THREE.RingGeometry(0.62, 1, 32, 1).rotateX(-Math.PI / 2);
}

/**
 * Orientation basis for a contact at unit direction `normal` heading
 * `headingDeg`: up is the surface normal, forward is the heading tangent.
 */
export function headingBasis(normal, headingDeg, out = new THREE.Matrix4()) {
  const up = normal;
  // East is the longitude tangent (cos lon, 0, -sin lon); at a pole any
  // horizontal direction will do.
  const east = new THREE.Vector3(up.z, 0, -up.x);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  const north = new THREE.Vector3().crossVectors(up, east);
  const heading = (Number.isFinite(headingDeg) ? headingDeg : 0) * DEG;
  const forward = north
    .multiplyScalar(Math.cos(heading))
    .addScaledVector(east, Math.sin(heading))
    .normalize();
  // Right-handed: x = y cross z.
  const side = new THREE.Vector3().crossVectors(up, forward);
  return out.makeBasis(side, up, forward);
}

/**
 * Create the contact layer under `globe`. Returns an object that replaces a
 * kind's contacts, updates satellites in place, picks, and highlights.
 */
export function createContactLayer(globe) {
  const root = new THREE.Group();
  root.name = 'Contacts';
  globe.add(root);
  const layers = {};
  const matrix = new THREE.Matrix4();
  const basis = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const direction = { x: 0, y: 0, z: 0 };
  let globeRadius = 0.24;
  let time = 0;

  for (const [kind, style] of Object.entries(CONTACT_STYLE)) {
    const geometry =
      kind === 'earthquake'
        ? quakeGeometry()
        : kind === 'satellite'
          ? diamondGeometry()
          : arrowGeometry();
    const material = new THREE.MeshBasicMaterial({
      color: style.color,
      toneMapped: false,
      side: THREE.DoubleSide,
      transparent: kind === 'earthquake',
      opacity: kind === 'earthquake' ? 0.9 : 1,
      depthWrite: kind !== 'earthquake',
    });
    const mesh = new THREE.InstancedMesh(geometry, material, style.capacity);
    mesh.name = `${kind} contacts`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(mesh);
    layers[kind] = {
      kind,
      style,
      mesh,
      contacts: [],
      unit: new Float32Array(style.capacity * 3),
    };
  }

  /** Recompute one instance's matrix from its contact. */
  function place(layer, index, contact) {
    const radius = contactRadius(contact);
    latLonToVector(contact.lat, contact.lon, 1, direction);
    position.set(direction.x, direction.y, direction.z);
    layer.unit[index * 3] = direction.x * radius;
    layer.unit[index * 3 + 1] = direction.y * radius;
    layer.unit[index * 3 + 2] = direction.z * radius;
    headingBasis(position, contact.headingDeg, basis);
    quaternion.setFromRotationMatrix(basis);
    let size = layer.style.size / globeRadius;
    if (contact.kind === 'earthquake')
      size *= 0.6 + Math.max(0, contact.magnitude - 2.5) * 0.45;
    if (contact.iss) size *= 2.2;
    scale.setScalar(size);
    position.multiplyScalar(radius);
    matrix.compose(position, quaternion, scale);
    layer.mesh.setMatrixAt(index, matrix);
  }

  function rebuild(layer) {
    const count = Math.min(layer.contacts.length, layer.style.capacity);
    for (let i = 0; i < count; i++) place(layer, i, layer.contacts[i]);
    layer.mesh.count = count;
    layer.mesh.instanceMatrix.needsUpdate = true;
  }

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
  root.add(highlight);
  let selected = null;

  function placeHighlight() {
    if (!selected) {
      highlight.visible = false;
      return;
    }
    const layer = layers[selected.kind];
    const index =
      layer?.contacts.findIndex((contact) => contact.id === selected.id) ?? -1;
    if (index < 0) {
      highlight.visible = false;
      return;
    }
    position.set(
      layer.unit[index * 3],
      layer.unit[index * 3 + 1],
      layer.unit[index * 3 + 2],
    );
    highlight.position.copy(position);
    highlight.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      position.clone().normalize(),
    );
    highlight.scale.setScalar(0.012 / globeRadius);
    highlight.visible = true;
  }

  const world = new THREE.Vector3();
  return {
    root,
    layers,
    /** Replace every contact of `kind`. */
    setContacts(kind, contacts) {
      const layer = layers[kind];
      if (!layer) return;
      layer.contacts = contacts;
      rebuild(layer);
      if (selected?.kind === kind) {
        const fresh = contacts.find((contact) => contact.id === selected.id);
        selected = fresh || selected;
      }
      placeHighlight();
    },
    /** Update satellite positions in place for indices [from, to). */
    updateSatellites(contacts, from, to) {
      const layer = layers.satellite;
      layer.contacts = contacts;
      const end = Math.min(to, contacts.length, layer.style.capacity);
      for (let i = from; i < end; i++)
        if (contacts[i]) place(layer, i, contacts[i]);
      layer.mesh.count = Math.min(contacts.length, layer.style.capacity);
      layer.mesh.instanceMatrix.needsUpdate = true;
      if (selected?.kind === 'satellite') placeHighlight();
    },
    setVisible(kind, visible) {
      if (layers[kind]) layers[kind].mesh.visible = visible;
    },
    /** Marker sizes follow the globe radius so they keep a physical size. */
    setGlobeRadius(radius) {
      if (Math.abs(radius - globeRadius) < 1e-6) return;
      globeRadius = radius;
      for (const layer of Object.values(layers)) rebuild(layer);
      placeHighlight();
    },
    /** Earthquakes under an hour old pulse. */
    animate(dt, now = Date.now()) {
      time += dt;
      const layer = layers.earthquake;
      let changed = false;
      for (let i = 0; i < layer.mesh.count; i++) {
        const contact = layer.contacts[i];
        if (!contact?.recentMs || now - contact.recentMs > 3_600_000) continue;
        layer.mesh.getMatrixAt(i, matrix);
        matrix.decompose(position, quaternion, scale);
        const base =
          (layer.style.size / globeRadius) *
          (0.6 + Math.max(0, contact.magnitude - 2.5) * 0.45);
        scale.setScalar(
          base * (1 + 0.35 * (0.5 + 0.5 * Math.sin(time * 4 + i))),
        );
        matrix.compose(position, quaternion, scale);
        layer.mesh.setMatrixAt(i, matrix);
        changed = true;
      }
      if (changed) layer.mesh.instanceMatrix.needsUpdate = true;
      if (highlight.visible)
        highlight.material.opacity = 0.65 + 0.35 * Math.sin(time * 5);
    },
    /**
     * Every visible contact's world position, with its contact, for picking.
     * Allocates; call on a press, not every frame.
     */
    worldPoints() {
      globe.updateWorldMatrix(true, false);
      const points = [];
      const owners = [];
      for (const layer of Object.values(layers)) {
        if (!layer.mesh.visible) continue;
        for (let i = 0; i < layer.mesh.count; i++) {
          world
            .set(
              layer.unit[i * 3],
              layer.unit[i * 3 + 1],
              layer.unit[i * 3 + 2],
            )
            .applyMatrix4(globe.matrixWorld);
          points.push(world.clone());
          owners.push(layer.contacts[i]);
        }
      }
      return { points, owners };
    },
    select(contact) {
      selected = contact || null;
      placeHighlight();
    },
    get selected() {
      return selected;
    },
    counts() {
      return Object.fromEntries(
        Object.values(layers).map((layer) => [layer.kind, layer.mesh.count]),
      );
    },
  };
}
