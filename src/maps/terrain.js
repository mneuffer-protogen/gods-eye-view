import * as Cesium from 'cesium';
import { createTerrainRetryPolicy } from './terrainRetry.js';

/** Re:Earth / Mapterhorn ellipsoidal quantized mesh, CC BY 4.0. */
export const KEYLESS_TERRAIN_URL =
  'https://terrain.reearth.land/cesium-mesh/ellipsoid';

/** These factories are lazy: a hidden globe must not trigger terrain loading. */
export async function createWorldTerrain(accessToken, { signal } = {}) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken)
    throw new Error('World terrain requires an explicit ion token');
  signal?.throwIfAborted();
  const resource = await Cesium.IonResource.fromAssetId(1, { accessToken });
  signal?.throwIfAborted();
  return {
    provider: await Cesium.CesiumTerrainProvider.fromUrl(resource, {
      requestVertexNormals: true,
      requestWaterMask: false,
      ellipsoid: Cesium.Ellipsoid.WGS84,
    }),
  };
}

function logThrottle({ statusCode, delayMs, inWindow }) {
  // One line per cooldown window, not per tile: a burst throttles dozens.
  if (inWindow !== 1) return;
  console.warn(
    `[MapStack] Re:Earth terrain answered ${statusCode}; retrying throttled tiles after ${Math.round(delayMs)} ms`,
  );
}

/**
 * The Re:Earth resource with the tile retry policy attached. Cesium copies
 * `retryCallback`/`retryAttempts` onto every derived resource, so layer.json
 * and each `{z}/{x}/{y}.terrain` fetch inherit it (see `terrainRetry.js`).
 * @param {ReturnType<typeof createTerrainRetryPolicy>} [policy]
 * @returns {Cesium.Resource}
 */
export function createKeylessTerrainResource(
  policy = createTerrainRetryPolicy({ onThrottle: logThrottle }),
) {
  return new Cesium.Resource({
    url: KEYLESS_TERRAIN_URL,
    retryCallback: policy.retryCallback,
    retryAttempts: policy.retryAttempts,
  });
}

/**
 * How long startup waits for Re:Earth's layer.json. The globe activation
 * awaits terrain, so a hung upstream would otherwise hold the loading screen;
 * past this the keyless globe draws on the flat ellipsoid instead.
 */
export const KEYLESS_TERRAIN_TIMEOUT_MS = 4000;

export async function createKeylessTerrain({
  timeoutMs = KEYLESS_TERRAIN_TIMEOUT_MS,
  fromUrl = (resource) => Cesium.CesiumTerrainProvider.fromUrl(resource),
} = {}) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Re:Earth terrain did not answer in ${timeoutMs} ms`),
          ),
        timeoutMs,
      );
    });
    return {
      provider: await Promise.race([
        fromUrl(createKeylessTerrainResource()),
        timeout,
      ]),
    };
  } catch (error) {
    console.warn(
      '[MapStack] Re:Earth terrain unavailable, falling back to flat ellipsoid terrain:',
      error,
    );
    return { provider: new Cesium.EllipsoidTerrainProvider() };
  } finally {
    clearTimeout(timer);
  }
}
