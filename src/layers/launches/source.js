import { launchLibraryRecentUrl } from '../../data/spaceProviderRequests.js';

const isLaunchPayload = (payload) =>
  Array.isArray(payload) || Array.isArray(payload?.results);

/** Read launch records and their optional active-orbit catalog with explicit cancellation. */
export function createLaunchSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => new Date(),
} = {}) {
  /**
   * Launch Library 2 directly from the browser. It allows any origin, and a
   * visitor's own address has its own allowance, where a shared host's may
   * be spent: the fallback when the app's server cannot serve launches.
   */
  async function getDirect(signal) {
    const response = await fetchImpl(launchLibraryRecentUrl(now()).href, {
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!isLaunchPayload(payload)) throw new Error('Malformed launch snapshot');
    return { payload, stale: false };
  }

  /** The launch payload, and whether the proxy served it from a stale cache. */
  async function getLaunchSnapshot({ signal } = {}) {
    signal?.throwIfAborted();
    let served = null;
    try {
      const response = await fetchImpl('/api/launches', { signal });
      if (response.ok) {
        const payload = await response.json();
        if (isLaunchPayload(payload))
          served = {
            payload,
            stale: response.headers?.get?.('x-gev-cache') === 'STALE-ERROR',
          };
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
    }
    signal?.throwIfAborted();
    return served ?? getDirect(signal);
  }
  return {
    getLaunchSnapshot,
    async getLaunches(options) {
      return (await getLaunchSnapshot(options)).payload;
    },
    async getActiveTle({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl('/api/celestrak/active', { signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      signal?.throwIfAborted();
      return text;
    },
  };
}
