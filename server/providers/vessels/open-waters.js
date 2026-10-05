import {
  coalesceProxyRequest,
  readResponseJsonCapped,
} from '../common/http.js';
import {
  OPENWATERS_VESSELS_URL,
  OPENWATERS_DEFAULT_AREA,
  OPENWATERS_ANON_MAX_AREA_SQ_DEG,
  OPENWATERS_TOKEN_MAX_AREA_SQ_DEG,
  bboxForArea,
  formatOpenWatersBbox,
  normalizeOpenWatersCollection,
  openWatersAttribution,
} from '../../../src/data/openWatersAis.js';
import { AISSTREAM_STALE_MS } from './ais-store.js';

export const OPENWATERS_SOURCE = 'Open Waters AIS';
/** Snapshot reuse window per box; the client polls about once a minute. */
const OPENWATERS_CACHE_MS = 15_000;
const OPENWATERS_CACHE_MAX = 40;
const OPENWATERS_TIMEOUT_MS = 20_000;
/** A dense 400 sq° box is ~20 MB of GeoJSON; refuse anything far past it. */
const OPENWATERS_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/** @type {Map<string,{rows:object[],attribution:string[],cachedAt:number}>} */
const _cache = new Map();
/** @type {Map<string,Promise<object>>} */
const _inFlight = new Map();
/**
 * The last area a client asked about. A view zoomed out past the client's
 * area radius sends none, and Open Waters has no keyless global snapshot, so
 * the last place someone looked stands in until they zoom in again.
 */
let _lastArea = null;

/** Optional free personal token; raises the box cap from ~10°² to ~20°². */
function openWatersToken() {
  return String(process.env.OPENWATERS_TOKEN || '').trim();
}

/**
 * Resolve the area for a request: the client's `lat`/`lon`/`radius_km` when
 * present (remembered for later wide views), else the last area, else the
 * default region.
 */
export function openWatersAreaFor(area) {
  if (area) _lastArea = area;
  return _lastArea || OPENWATERS_DEFAULT_AREA;
}

/**
 * One Open Waters snapshot for the box around `area`, cached and coalesced
 * per box. Falls back to the last good snapshot of the same box, marked
 * stale; throws only when there is none.
 * @returns {Promise<{rows:object[],attribution:string[],cachedAt:number,cacheStatus:string,bbox:string}>}
 */
export async function fetchOpenWatersSnapshot(
  area,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const token = openWatersToken();
  const bbox = formatOpenWatersBbox(
    bboxForArea(
      openWatersAreaFor(area),
      token
        ? OPENWATERS_TOKEN_MAX_AREA_SQ_DEG
        : OPENWATERS_ANON_MAX_AREA_SQ_DEG,
    ),
  );
  const cached = _cache.get(bbox);
  if (cached && now() - cached.cachedAt < OPENWATERS_CACHE_MS)
    return { ...cached, cacheStatus: 'HIT', bbox };
  const request = coalesceProxyRequest(_inFlight, bbox, async () => {
    const payload = await pullOpenWaters(bbox, token, fetchImpl);
    const record = {
      rows: normalizeOpenWatersCollection(payload, {
        now: now(),
        maxAgeMs: AISSTREAM_STALE_MS,
      }),
      attribution: openWatersAttribution(payload),
      cachedAt: now(),
    };
    _cache.delete(bbox);
    _cache.set(bbox, record);
    while (_cache.size > OPENWATERS_CACHE_MAX)
      _cache.delete(_cache.keys().next().value);
    return record;
  });
  try {
    const record = await request.promise;
    return {
      ...record,
      cacheStatus: request.shared ? 'INFLIGHT' : 'MISS',
      bbox,
    };
  } catch (error) {
    if (!request.shared)
      console.warn('[Open Waters AIS]', error?.message || error);
    if (cached) return { ...cached, cacheStatus: 'STALE', bbox };
    throw error;
  }
}

async function pullOpenWaters(bbox, token, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENWATERS_TIMEOUT_MS);
  try {
    const headers = {
      Accept: 'application/geo+json, application/json',
      'User-Agent': 'gods-eye-view-ais/1.0',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const upstream = await fetchImpl(
      `${OPENWATERS_VESSELS_URL}?bbox=${encodeURIComponent(bbox)}`,
      { headers, signal: controller.signal },
    );
    if (!upstream.ok) {
      // The service explains refusals in plain text ("bbox not allowed for
      // this key"); keep it short and never echo a token.
      const detail = (await upstream.text().catch(() => ''))
        .trim()
        .slice(0, 120);
      throw new Error(
        `upstream HTTP ${upstream.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return await readResponseJsonCapped(
      upstream,
      OPENWATERS_MAX_RESPONSE_BYTES,
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget cached snapshots and the remembered area. */
export function _resetOpenWatersForTest() {
  _cache.clear();
  _inFlight.clear();
  _lastArea = null;
}
