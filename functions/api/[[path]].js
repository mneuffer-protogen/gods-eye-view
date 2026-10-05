/**
 * Cloudflare Pages Function for every /api route of a static deployment.
 *
 * The built site is static files; the live layers' data comes through the
 * same provider middleware the dev server runs (server/edge/providers.js),
 * adapted to fetch here (server/edge/connect.js). Needs the `nodejs_compat`
 * flag (wrangler.toml).
 */

import {
  collectMiddleware,
  installEdgeFetch,
  runMiddleware,
} from '../../server/edge/connect.js';
import { edgeProviderPlugins } from '../../server/edge/providers.js';

// Built on the first request rather than at load: some providers start
// timers when installed, which Workers only allow inside a request.
let stack = null;

export async function onRequest(context) {
  // Deployment variables (optional keys such as OPENSKY_CLIENT_ID) reach the
  // providers the way the dev server's .env does.
  for (const [name, value] of Object.entries(context.env ?? {}))
    if (typeof value === 'string' && !(name in process.env))
      process.env[name] = value;
  installEdgeFetch();
  stack ??= collectMiddleware(edgeProviderPlugins());
  const response = await runMiddleware(stack, context.request);
  return (
    response ??
    new Response(JSON.stringify({ error: 'Unknown API route' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}
