/**
 * The provider routes a static deployment serves from the edge (Cloudflare
 * Pages Functions, see functions/api/[[path]].js). The same middleware the
 * dev server installs, minus what an edge function cannot run:
 *
 *  - CCTV (catalogues read from config files, streamed media, HLS sessions)
 *  - Wind (GRIB2 decoding in a WebAssembly build of ecCodes)
 *  - Local ADS-B receivers (LAN addresses) and the dev-only key setup
 *  - OpenAI and Google Places, whose cost endpoints refuse proxied requests;
 *    keyless, they answer "not configured" here instead
 *
 * Everything listed is keyless by default; a key set in the deployment's
 * environment upgrades it exactly as on the dev server.
 */

import { openSkyProxy } from '../providers/aircraft/opensky.js';
import { adsbLolProxy } from '../providers/aircraft/adsb-lol.js';
import { adsbdbProxy } from '../providers/aircraft/enrichment.js';
import { trackBackfillProxies } from '../providers/aircraft/tracks.js';
import { aisLiveProxy } from '../providers/vessels/ais-live.js';
import { celestrakProxy } from '../providers/space/celestrak.js';
import { rocketLaunchesProxy } from '../providers/space/launch-library.js';
import { tomtomProxy } from '../providers/traffic.js';
import { firmsProxy } from '../providers/firms.js';
import { terrainHeightsProxy } from '../providers/terrain.js';
import { overpassProxy } from '../providers/overpass.js';
import { militaryInstallationsProxy } from '../providers/military-installations.js';
import { regionalBriefProxy } from '../providers/regional/briefing.js';
import { geocodeProxy } from '../providers/regional/place.js';
import { weatherEffectsProxy } from '../providers/regional/weather-effects.js';
import { radioBrowserProxy } from '../providers/radio.js';
import { gbfsProxy } from '../providers/gbfs.js';
import { transitProxy } from '../providers/transit.js';
import { weatherProxy } from '../providers/weather.js';
import { cycloneProxy } from '../providers/cyclones.js';
import { firePerimetersProxy } from '../providers/firePerimeters.js';
import { apiNotFoundPlugin } from '../standalone/api-not-found.js';
import { keylessHudSummaryResponse } from '../../src/hudSummaryResponse.js';

/** A plugin answering fixed JSON at `route`. */
function staticJson(name, routes) {
  const install = (server) => {
    for (const [route, respond] of routes)
      server.middlewares.use(route, (req, res) => {
        const { statusCode, payload } = respond(req);
        res.writeHead(statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      });
  };
  return { name, configureServer: install, configurePreviewServer: install };
}

/**
 * Voice and the AI HUD summary are off at the edge: the mic reads VOICE OFF
 * and the HUD keeps its deterministic line. Google place search answers
 * "not configured" so search falls through to the keyless geocoders.
 */
function keylessEdgeAnswers() {
  return staticJson('edge-keyless', [
    [
      '/api/realtime/status',
      () => ({ statusCode: 200, payload: { configured: false } }),
    ],
    [
      '/api/realtime/token',
      () => ({
        statusCode: 503,
        payload: { error: 'OPENAI_API_KEY is not set' },
      }),
    ],
    ['/api/openai/hud-summary', () => keylessHudSummaryResponse('')],
    [
      '/api/google',
      () => ({
        statusCode: 200,
        payload: { configured: false, error: null, places: [] },
      }),
    ],
    [
      '/api/cctv/sources',
      () => ({
        statusCode: 503,
        payload: {
          error: 'Cameras are not served by this deployment',
          cameras: [],
        },
      }),
    ],
    [
      '/api/wind/status',
      () => ({
        statusCode: 503,
        payload: { error: 'Wind is not served by this deployment' },
      }),
    ],
  ]);
}

/** The edge's plugins, in the dev server's order, ending with a JSON 404. */
export function edgeProviderPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    weatherEffectsProxy(),
    radioBrowserProxy(),
    gbfsProxy(),
    transitProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    weatherProxy(),
    cycloneProxy(),
    firePerimetersProxy(),
    keylessEdgeAnswers(),
    apiNotFoundPlugin(),
  ];
}
