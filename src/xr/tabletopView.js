/**
 * The tabletop view: the map table, its terrain and its live contacts,
 * opened on a place and kept current each frame. main.js switches between
 * this and the globe; both stand on the same carried table.
 */

import * as THREE from 'three';
import { createFrame } from './mapGeo.js';
import { MAP_PROVIDERS, MapTerrain } from './mapTerrain.js';
import { MAP_TABLE, createMapTable } from './mapTable.js';
import { createMapContacts } from './mapContacts.js';
import { formatPosition } from './panelContent.js';

// The local frame is equirectangular; past this distance from its origin a
// pan reopens the map around the new centre so the ground stays true.
const RECENTRE_M = 150_000;

/** `250 km` / `800 m` */
export function formatSpan(metres) {
  return metres >= 10_000
    ? `${Math.round(metres / 1000).toLocaleString('en-US')} km`
    : metres >= 1000
      ? `${(metres / 1000).toFixed(1)} km`
      : `${Math.round(metres)} m`;
}

export function createTabletopView({ brand, dataCredits, onError = () => {} }) {
  const mapTable = createMapTable({ brand });
  const contacts = createMapContacts(mapTable);
  mapTable.setCredits(`${MAP_PROVIDERS.credit} · ${dataCredits}`);
  // Ground colour under the window while tiles load, so the map never shows
  // a hole through to the room.
  const fallback = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({
      color: '#1d3340',
      clippingPlanes: mapTable.planes,
    }),
  );
  fallback.name = 'Map ground';
  fallback.position.y = -1;
  mapTable.site.add(fallback);

  let frame = null;
  let terrain = null;
  let lastKey = '';
  let dirty = true;
  // The rim note redraws a large canvas, so a pan updates it a few times a
  // second rather than every frame.
  let noteAt = 0;
  let elapsed = 0;

  /** Open the map centred on `lat, lon`, keeping or setting the span and yaw. */
  function open(
    lat,
    lon,
    { span = mapTable.view.span, yaw = mapTable.view.yaw } = {},
  ) {
    const clampedLat = Math.max(-84, Math.min(84, lat));
    frame = createFrame(lon, clampedLat);
    terrain?.dispose();
    terrain?.root.removeFromParent();
    terrain = new MapTerrain({
      frame,
      clippingPlanes: mapTable.planes,
      onError,
    });
    mapTable.site.add(terrain.root);
    terrain.init().then(() => {
      dirty = true;
    });
    mapTable.setView({ cx: 0, cz: 0, span, yaw });
    mapTable.setGround(0);
    dirty = true;
  }

  function placement() {
    return {
      frame,
      view: mapTable.view,
      scale: mapTable.scale,
      window: MAP_TABLE.window,
      toTable: (site) => mapTable.toTable(site),
      groundAt: (x, z) => mapTable.heightOnTable(terrain.sceneHeight(x, z)),
      seaLevel: mapTable.heightOnTable(-terrain.base),
    };
  }

  return {
    mapTable,
    contacts,
    group: mapTable.group,
    open,
    get frame() {
      return frame;
    },
    get terrain() {
      return terrain;
    },
    /** The map's centre, `{ lat, lon }`. */
    center() {
      const { lon, lat } = frame.fromScene(mapTable.view.cx, mapTable.view.cz);
      return { lat, lon };
    },
    /** Ground radius the map shows, in kilometres, for feed queries. */
    get radiusKm() {
      return mapTable.view.span / 2 / 1000;
    },
    setContacts(kind, list) {
      contacts.setContacts(kind, list);
      dirty = true;
    },
    setVisible(kind, visible) {
      contacts.setVisible(kind, visible);
      dirty = true;
    },
    select(contact) {
      contacts.select(contact);
      dirty = true;
    },
    /** Reopen the frame around the centre once a pan has wandered far. */
    recentreIfFar() {
      const { cx, cz } = mapTable.view;
      if (Math.hypot(cx, cz) < RECENTRE_M) return false;
      const { lat, lon } = this.center();
      open(lat, lon);
      return true;
    },
    /** Every frame while the tabletop shows. */
    update(dt) {
      if (!terrain) return;
      elapsed += dt;
      mapTable.update();
      const view = mapTable.view;
      mapTable.setGround(terrain.sceneHeight(view.cx, view.cz), dt);
      terrain.update(view.cx, view.cz, mapTable.radius);
      fallback.visible = terrain.root.children.length === 0 || terrain.loading;
      fallback.scale.setScalar(view.span * 4);
      fallback.position.set(view.cx, -1, view.cz);
      const key = [
        view.cx,
        view.cz,
        view.span,
        view.yaw,
        mapTable.site.position.y,
        terrain.version,
      ]
        .map((value) => value.toFixed(3))
        .join(',');
      if (key !== lastKey || dirty) {
        lastKey = key;
        dirty = false;
        mapTable.updateSides((x, z) => {
          const p = mapTable.toSite({ x, z });
          return mapTable.heightOnTable(terrain.sceneHeight(p.x, p.z));
        });
        contacts.rebuild(placement());
        noteAt = Math.min(noteAt, elapsed - 0.001);
      }
      if (Number.isFinite(noteAt) && elapsed - noteAt >= 0.3) {
        noteAt = Infinity;
        const { lat, lon } = this.center();
        mapTable.setNote(
          `${formatPosition(lat, lon)} · ${formatSpan(view.span)} across`,
        );
      }
      contacts.animate(dt);
    },
    dispose() {
      terrain?.dispose();
    },
  };
}
