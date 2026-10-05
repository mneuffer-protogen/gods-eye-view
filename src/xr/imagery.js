/**
 * Base imagery for the tabletop globe: one Web Mercator mosaic of a few
 * dozen tiles, drawn into a canvas the globe shader samples by latitude.
 *
 * The sources and credits are the main app's keyless ones (src/maps/imagery.js,
 * DATA_SOURCES.md): Esri World Imagery first, OpenStreetMap if Esri is
 * unreachable, and a plain graticule if neither answers, so the globe is
 * never blank and never claims imagery it does not show.
 */

export const IMAGERY_SOURCES = Object.freeze([
  Object.freeze({
    id: 'esri',
    template:
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit:
      'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  }),
  Object.freeze({
    id: 'osm',
    template: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
  }),
]);

export const TILE_SIZE = 256;
// Zoom 3 is an 8 x 8 mosaic, 2048 px square: about 20 km a pixel at the
// equator, sharper than a 25 cm globe can show at arm's length, from 64
// requests.
export const DEFAULT_ZOOM = 3;
// A fraction of tiles may fail (a rate limit, a flaky link) without
// abandoning a source; more than this and the next source is tried.
export const MAX_FAILED_SHARE = 0.25;

/** The tile URL for one source, zoom and tile column/row. */
export function tileUrl(source, z, x, y) {
  return source.template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** Every tile of a zoom level, row-major from the north-west corner. */
export function tilesForZoom(z) {
  const count = 2 ** z;
  const tiles = [];
  for (let y = 0; y < count; y++)
    for (let x = 0; x < count; x++) tiles.push({ x, y });
  return tiles;
}

/** Draw a faint 30-degree graticule straight onto a Web Mercator canvas. */
export function drawGraticule(
  context,
  size,
  { color = 'rgba(0, 212, 255, 0.28)', width = 1.5 } = {},
) {
  const mercatorY = (lat) => {
    const phi = (lat * Math.PI) / 180;
    return (
      (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * size
    );
  };
  context.save();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  for (let lon = -180; lon < 180; lon += 30) {
    const x = ((lon + 180) / 360) * size;
    context.moveTo(x, 0);
    context.lineTo(x, size);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = mercatorY(lat);
    context.moveTo(0, y);
    context.lineTo(size, y);
  }
  context.stroke();
  context.restore();
}

function loadImage(url, signal) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // Without CORS the canvas is tainted and WebGL refuses the upload.
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const abort = () => {
      image.src = '';
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    image.onload = () => {
      signal?.removeEventListener('abort', abort);
      resolve(image);
    };
    image.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error(`Tile failed: ${url}`));
    };
    image.src = url;
  });
}

/**
 * Build the mosaic. Resolves `{ canvas, source }` where `source` is the
 * imagery that filled it, or null for the graticule-only fallback.
 * `onProgress(loaded, total)` reports tile arrivals.
 */
export async function buildMosaic({
  zoom = DEFAULT_ZOOM,
  sources = IMAGERY_SOURCES,
  signal,
  onProgress = () => {},
  createCanvas = () => document.createElement('canvas'),
  load = loadImage,
} = {}) {
  const size = TILE_SIZE * 2 ** zoom;
  const canvas = createCanvas();
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  const tiles = tilesForZoom(zoom);
  for (const source of sources) {
    if (signal?.aborted) break;
    context.fillStyle = '#06121c';
    context.fillRect(0, 0, size, size);
    let loaded = 0;
    let failed = 0;
    await Promise.all(
      tiles.map(async ({ x, y }) => {
        try {
          const image = await load(tileUrl(source, zoom, x, y), signal);
          context.drawImage(
            image,
            x * TILE_SIZE,
            y * TILE_SIZE,
            TILE_SIZE,
            TILE_SIZE,
          );
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          failed++;
        }
        loaded++;
        onProgress(loaded, tiles.length);
      }),
    ).catch((error) => {
      if (error?.name !== 'AbortError') throw error;
    });
    if (signal?.aborted) break;
    if (failed / tiles.length <= MAX_FAILED_SHARE) {
      drawGraticule(context, size, {
        color: 'rgba(255, 255, 255, 0.12)',
        width: 1,
      });
      return { canvas, source };
    }
  }
  context.fillStyle = '#06121c';
  context.fillRect(0, 0, size, size);
  drawGraticule(context, size);
  return { canvas, source: null };
}
