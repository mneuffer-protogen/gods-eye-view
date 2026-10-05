import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  collectMiddleware,
  installEdgeFetch,
  runMiddleware,
} from '../../server/edge/connect.js';

const plugin = (install) => ({
  configureServer: install,
  configurePreviewServer: install,
});
const request = (path, init) =>
  new Request(`https://site.pages.dev${path}`, init);

test('mounts match by prefix in order, strip the prefix, and fall through on next()', async () => {
  const seen = [];
  const stack = collectMiddleware([
    plugin((server) => {
      server.middlewares.use('/api/flights', (req, res, next) => {
        seen.push(req.url);
        if (new URL(req.url, 'http://x').pathname !== '/') return next();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ states: [] }));
      });
      server.middlewares.use('/api/flights/track', (req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ track: req.url }));
      });
    }),
  ]);
  const list = await runMiddleware(stack, request('/api/flights?lat=1&lon=2'));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { states: [] });
  const track = await runMiddleware(
    stack,
    request('/api/flights/track?icao24=abc'),
  );
  assert.deepEqual(await track.json(), { track: '/?icao24=abc' });
  assert.deepEqual(seen, ['/?lat=1&lon=2', '/track?icao24=abc']);
  // A sibling path that only shares a prefix is not this mount's.
  assert.equal(await runMiddleware(stack, request('/api/flightsx')), null);
});

test('a provider gets the body, the client address, and its close listeners work', async () => {
  const stack = collectMiddleware([
    plugin((server) =>
      server.middlewares.use('/api/echo', async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        res.once('close', () => {});
        res.writeHead(201, { 'X-Client': req.socket.remoteAddress });
        res.end(Buffer.concat(chunks));
      }),
    ),
  ]);
  const response = await runMiddleware(
    stack,
    request('/api/echo', {
      method: 'POST',
      body: 'data=[out:json];',
      headers: { 'CF-Connecting-IP': '203.0.113.9' },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-client'), '203.0.113.9');
  assert.equal(await response.text(), 'data=[out:json];');
});

test('a throwing provider answers 500 instead of hanging', async () => {
  const stack = collectMiddleware([
    plugin((server) =>
      server.middlewares.use('/api/broken', async () => {
        throw new Error('boom');
      }),
    ),
  ]);
  const response = await runMiddleware(stack, request('/api/broken'));
  assert.equal(response.status, 500);
});

test('the edge fetch keeps redirects refused where a provider asked for that', async () => {
  const calls = [];
  const scope = {
    fetch: async (url, init) => {
      calls.push(init?.redirect);
      return new Response(null, {
        status: url.includes('moved') ? 302 : 200,
        headers: url.includes('moved') ? { Location: 'https://elsewhere' } : {},
      });
    },
  };
  installEdgeFetch(scope);
  assert.equal(
    (await scope.fetch('https://ok', { redirect: 'error' })).status,
    200,
  );
  await assert.rejects(
    scope.fetch('https://moved', { redirect: 'error' }),
    /redirect/,
  );
  assert.equal((await scope.fetch('https://moved', {})).status, 302);
  assert.deepEqual(calls, ['manual', 'manual', undefined]);
});

test('the edge serves the keyless answers and a JSON 404 for unknown routes', async () => {
  const { edgeProviderPlugins } =
    await import('../../server/edge/providers.js');
  const stack = collectMiddleware(edgeProviderPlugins());
  const status = await runMiddleware(stack, request('/api/realtime/status'));
  assert.deepEqual(await status.json(), { configured: false });
  // Upstreams that refuse Cloudflare's addresses answer at once, by name.
  for (const path of [
    '/api/flights?lat=1&lon=2',
    '/api/military/track?hex=a',
    '/api/launches',
  ]) {
    const blocked = await runMiddleware(stack, request(path));
    assert.equal(blocked.status, 503, path);
    assert.equal(
      blocked.headers.get('x-gev-unavailable'),
      'Not available on this deployment',
    );
  }
  const unknown = await runMiddleware(stack, request('/api/not-a-route'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('content-type'), 'application/json');
});

test('Cloudflare Pages is configured for the functions', () => {
  const config = readFileSync(
    new URL('../../wrangler.toml', import.meta.url),
    'utf8',
  );
  assert.match(config, /pages_build_output_dir = "dist"/);
  assert.match(config, /compatibility_flags = \["nodejs_compat"\]/);
  const entry = readFileSync(
    new URL('../../functions/api/[[path]].js', import.meta.url),
    'utf8',
  );
  assert.match(entry, /installEdgeFetch\(\)/);
});
