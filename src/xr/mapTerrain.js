/**
 * Satellite imagery draped on elevation for the tabletop map, as tile meshes
 * in site metres (x east, y up, z south). Both sources are keyless: Esri
 * World Imagery for the picture and the AWS Open Data terrain tiles
 * (terrarium encoding) for the ground. The map table scales and clips them.
 *
 * One imagery zoom shows at a time. When the view asks for a finer or
 * coarser level the new tiles load underneath and the old ones stay until
 * the new set is complete, so zooming never shows holes. Elevation is kept
 * on the CPU, so anything set on the ground is placed by a lookup, not a
 * raycast.
 */

import * as THREE from 'three';
import {
  coverTiles,
  decodeTerrarium,
  lonLatToTile,
  tileKey,
  tileSizeMeters,
  tileToLonLat,
  zoomForSpan,
} from './mapGeo.js';

export const MAP_PROVIDERS = Object.freeze({
  imagery: ({ z, x, y }) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  imageryMaxZoom: 17,
  elevation: ({ z, x, y }) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  elevationMaxZoom: 12,
  decode: decodeTerrarium,
  credit:
    'Imagery © Esri, Maxar, Earthstar Geographics · Terrain © Mapzen, AWS',
});

const TILE_SEGMENTS = 24;
const MAX_TILES = 40;
const CONCURRENCY = 6;
const RETRY_MS = 5_000;
// A tile that keeps failing (a server with no imagery there) stops being
// asked for; the ground colour under the map stands in.
const MAX_ATTEMPTS = 3;
const CACHE_NAME = 'gods-eye-view-xr-tiles-v1';
// A number per elevation tile, unique for z <= 22, so a height lookup
// builds no key strings.
const loadedKey = (z, x, y) => (z * 4_194_304 + x) * 4_194_304 + y;

// Tiles are immutable, so they are kept with the Cache API across visits.
// Any failure falls through to the network.
async function fetchCached(url, signal) {
  let cache = null;
  try {
    cache = await globalThis.caches?.open(CACHE_NAME);
    const hit = await cache?.match(url);
    if (hit) return hit;
  } catch {
    /* no cache in this context */
  }
  const response = await fetch(url, { signal, mode: 'cors' });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  try {
    await cache?.put(url, response.clone());
  } catch {
    /* quota */
  }
  return response;
}

// WebGL ignores flipY for an ImageBitmap, so imagery is flipped as it is
// decoded; elevation is read as pixels and keeps its rows.
async function bitmapFrom(response, flip = false) {
  return createImageBitmap(await response.blob(), {
    imageOrientation: flip ? 'flipY' : 'none',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

function pixels(bitmap) {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(bitmap.width, bitmap.height)
      : Object.assign(document.createElement('canvas'), {
          width: bitmap.width,
          height: bitmap.height,
        });
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

const disposeMesh = (mesh) => {
  mesh.geometry.dispose();
  mesh.material.map?.dispose();
  mesh.material.dispose();
};

export class MapTerrain {
  /**
   * @param {object} options
   * @param {ReturnType<import('./mapGeo.js').createFrame>} options.frame
   * @param {THREE.Plane[]} options.clippingPlanes
   * @param {(error: Error) => void} [options.onError]
   */
  constructor({
    frame,
    clippingPlanes,
    onError = () => {},
    providers = MAP_PROVIDERS,
  }) {
    Object.assign(this, { frame, clippingPlanes, onError, providers });
    this.root = new THREE.Group();
    this.root.name = 'Map terrain';
    this.tiles = new Map();
    // Tries so far for tiles that failed and were dropped to be asked again.
    this.attempts = new Map();
    this.elevation = new Map();
    this.loaded = new Map();
    this.queue = [];
    this.active = 0;
    this.level = null;
    this.wanted = null;
    // The ground height at the frame's origin, so the map sits on the table
    // rather than at its altitude above sea level.
    this.base = 0;
    this.abort = new AbortController();
    // Bumped whenever elevation lands, so things set on the ground re-seat.
    this.version = 0;
  }

  async init() {
    const height = await this.heightAtAsync(
      this.frame.lon0,
      this.frame.lat0,
    ).catch(() => null);
    this.base = Number.isFinite(height) ? Math.max(0, height) : 0;
    this.version++;
    return this.base;
  }

  loadElevation(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.elevation.has(key)) return this.elevation.get(key);
    const entry = { z, x, y, data: null, promise: null };
    entry.promise = fetchCached(
      this.providers.elevation({ z, x, y }),
      this.abort.signal,
    )
      .then(bitmapFrom)
      .then((bitmap) => {
        const rgba = pixels(bitmap);
        const size = bitmap.width;
        const data = new Float32Array(size * size);
        for (let i = 0; i < size * size; i++)
          data[i] = this.providers.decode(
            rgba[i * 4],
            rgba[i * 4 + 1],
            rgba[i * 4 + 2],
          );
        bitmap.close?.();
        entry.size = size;
        entry.data = data;
        this.loaded.set(loadedKey(z, x, y), entry);
        this.version++;
        return entry;
      })
      .catch((error) => {
        if (error.name !== 'AbortError') this.onError(error);
        entry.failed = true;
        return entry;
      });
    this.elevation.set(key, entry);
    return entry;
  }

  /** Bilinear height in metres above sea level, from the finest tile loaded. */
  heightAt(lon, lat) {
    const top = this.providers.elevationMaxZoom;
    const t = lonLatToTile(lon, lat, top);
    let tx = t.x;
    let ty = t.y;
    for (let z = top; z >= 0; z--, tx /= 2, ty /= 2) {
      const fx0 = Math.floor(tx);
      const fy0 = Math.floor(ty);
      const entry = this.loaded.get(loadedKey(z, fx0, fy0));
      if (!entry) continue;
      const s = entry.size;
      const u = (tx - fx0) * s - 0.5;
      const v = (ty - fy0) * s - 0.5;
      const x0 = Math.max(0, Math.min(s - 1, Math.floor(u)));
      const y0 = Math.max(0, Math.min(s - 1, Math.floor(v)));
      const x1 = Math.min(s - 1, x0 + 1);
      const y1 = Math.min(s - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, u - x0));
      const fy = Math.max(0, Math.min(1, v - y0));
      const d = entry.data;
      const upper = d[y0 * s + x0] * (1 - fx) + d[y0 * s + x1] * fx;
      const lower = d[y1 * s + x0] * (1 - fx) + d[y1 * s + x1] * fx;
      return upper * (1 - fy) + lower * fy;
    }
    return null;
  }

  async heightAtAsync(lon, lat) {
    const z = this.providers.elevationMaxZoom;
    const t = lonLatToTile(lon, lat, z);
    await this.loadElevation(z, Math.floor(t.x), Math.floor(t.y)).promise;
    return this.heightAt(lon, lat);
  }

  /**
   * Height in site metres (relative to the origin's ground) at a scene x, z.
   * Sea is clamped to sea level: the ocean surface, not the sea floor.
   */
  sceneHeight(x, z) {
    const { lon, lat } = this.frame.fromScene(x, z);
    const h = this.heightAt(lon, lat);
    return (h == null ? this.base : Math.max(0, h)) - this.base;
  }

  /** How much of what the view asked for has arrived, 0..1. */
  get progress() {
    if (!this.wanted?.size) return 0;
    let ready = 0;
    for (const key of this.wanted) if (this.tiles.get(key)?.ready) ready++;
    return ready / this.wanted.size;
  }

  get loading() {
    return this.active > 0 || this.queue.length > 0;
  }

  /** Ask for the tiles covering a square of half-width `radius` around x, z. */
  update(x, z, radius) {
    const { lat } = this.frame.fromScene(x, z);
    const level = zoomForSpan(lat, radius * 2, {
      max: this.providers.imageryMaxZoom,
    });
    let wanted = coverTiles(this.frame, x, z, radius * 1.05, level);
    if (wanted.length > MAX_TILES) wanted = wanted.slice(0, MAX_TILES);
    const keys = new Set(wanted.map(tileKey));
    if (this.level !== level || !sameSet(keys, this.wanted)) {
      this.level = level;
      this.wanted = keys;
      this.queue = wanted.filter((tile) => !this.tiles.has(tileKey(tile)));
      this.pump();
    } else {
      // Tile servers drop the odd request; a wanted tile that failed is asked
      // for again after a pause rather than left as a hole.
      const now = performance.now();
      for (const key of keys) {
        const record = this.tiles.get(key);
        if (
          record?.failed &&
          record.attempts < MAX_ATTEMPTS &&
          now - record.failedAt > RETRY_MS
        ) {
          this.tiles.delete(key);
          this.attempts.set(key, record.attempts);
          this.queue.push(record.tile);
        }
      }
      this.pump();
    }
    this.settle();
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const tile = this.queue.shift();
      const key = tileKey(tile);
      if (this.tiles.has(key)) continue;
      const record = {
        tile,
        mesh: null,
        ready: false,
        attempts: (this.attempts.get(key) ?? 0) + 1,
      };
      this.tiles.set(key, record);
      this.active++;
      this.buildTile(tile)
        .then((mesh) => {
          if (this.abort.signal.aborted) return disposeMesh(mesh);
          record.mesh = mesh;
          record.ready = true;
          this.root.add(mesh);
        })
        .catch((error) => {
          if (error.name === 'AbortError') return;
          this.onError(error);
          // A failed tile counts as arrived so the old level can go; it is
          // asked for again the next time the view wants it.
          record.ready = true;
          record.failed = true;
          record.failedAt = performance.now();
        })
        .finally(() => {
          this.active--;
          this.pump();
          this.settle();
        });
    }
  }

  /** Once every wanted tile has arrived, drop the ones no longer wanted. */
  settle() {
    if (!this.wanted) return;
    for (const key of this.wanted) if (!this.tiles.get(key)?.ready) return;
    for (const [key, record] of this.tiles) {
      if (this.wanted.has(key)) continue;
      if (record.mesh) {
        this.root.remove(record.mesh);
        disposeMesh(record.mesh);
      }
      this.tiles.delete(key);
    }
  }

  async buildTile({ z, x, y }) {
    const ez = Math.min(z, this.providers.elevationMaxZoom);
    const scale = 2 ** (z - ez);
    const [imagery] = await Promise.all([
      fetchCached(this.providers.imagery({ z, x, y }), this.abort.signal).then(
        (response) => bitmapFrom(response, true),
      ),
      this.loadElevation(ez, Math.floor(x / scale), Math.floor(y / scale))
        .promise,
    ]);
    const texture = new THREE.Texture(imagery);
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    const material = new THREE.MeshLambertMaterial({
      map: texture,
      clippingPlanes: this.clippingPlanes,
    });
    const mesh = new THREE.Mesh(this.tileGeometry(z, x, y), material);
    mesh.name = `tile ${z}/${x}/${y}`;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  /**
   * A grid with each vertex at its true longitude, latitude and height, plus
   * a skirt hanging from the edge to hide hairlines between tiles that
   * sampled their shared edge from different elevation tiles.
   */
  tileGeometry(z, x, y) {
    const n = TILE_SEGMENTS;
    const count = (n + 1) * (n + 1);
    const positions = new Float32Array((count + 4 * n) * 3);
    const uvs = new Float32Array((count + 4 * n) * 2);
    const index = [];
    const { lat } = tileToLonLat(x + 0.5, y + 0.5, z);
    const drop = Math.max(2, tileSizeMeters(lat, z) * 0.02);
    const put = (i, px, py, pz, u, v) => {
      positions[i * 3] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;
      uvs[i * 2] = u;
      uvs[i * 2 + 1] = v;
    };
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const corner = tileToLonLat(x + i / n, y + j / n, z);
        const p = this.frame.toScene(corner.lon, corner.lat);
        const h = this.heightAt(corner.lon, corner.lat);
        put(
          j * (n + 1) + i,
          p.x,
          (h == null ? this.base : Math.max(0, h)) - this.base,
          p.z,
          i / n,
          1 - j / n,
        );
      }
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        const b = a + 1;
        const c = a + n + 1;
        const d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    const border = [];
    for (let i = 0; i < n; i++) border.push(i);
    for (let j = 0; j < n; j++) border.push(j * (n + 1) + n);
    for (let i = n; i > 0; i--) border.push(n * (n + 1) + i);
    for (let j = n; j > 0; j--) border.push(j * (n + 1));
    border.forEach((v, k) => {
      put(
        count + k,
        positions[v * 3],
        positions[v * 3 + 1] - drop,
        positions[v * 3 + 2],
        uvs[v * 2],
        uvs[v * 2 + 1],
      );
    });
    for (let k = 0; k < border.length; k++) {
      const a = border[k];
      const b = border[(k + 1) % border.length];
      const sa = count + k;
      const sb = count + ((k + 1) % border.length);
      index.push(a, b, sa, b, sb, sa);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    // A skirt lit by its own sideways normal draws a dark seam; lit like the
    // ground above it, it reads as more of the same ground.
    const normals = geometry.attributes.normal.array;
    border.forEach((v, k) => {
      const s = count + k;
      normals[s * 3] = normals[v * 3];
      normals[s * 3 + 1] = normals[v * 3 + 1];
      normals[s * 3 + 2] = normals[v * 3 + 2];
    });
    geometry.computeBoundingSphere();
    return geometry;
  }

  dispose() {
    this.abort.abort();
    this.queue = [];
    this.wanted = null;
    for (const record of this.tiles.values())
      if (record.mesh) disposeMesh(record.mesh);
    this.tiles.clear();
    this.elevation.clear();
    this.loaded.clear();
    this.root.clear();
  }
}

function sameSet(a, b) {
  if (!b || a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}
