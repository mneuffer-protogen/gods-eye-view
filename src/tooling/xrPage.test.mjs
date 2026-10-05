import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withoutCesiumOnPages } from '../../build/vite.js';
import { panelBuildConfig } from '../../build/panel.js';
import standaloneConfig, {
  CESIUM_FREE_PAGES,
  STANDALONE_PAGES,
  resolveHttps,
} from '../../server/standalone/vite.config.js';
import {
  XR_PROFILE_IDS,
  filteredProfilesList,
  profileAssets,
  resolveProfileFile,
  xrProfilesPlugin,
} from '../../server/standalone/xr-profiles.js';

test('the mixed-reality page receives no Cesium tags; the globe page still does', () => {
  const tags = [{ tag: 'script', attrs: { src: '/cesium/Cesium.js' } }];
  const plugin = withoutCesiumOnPages(
    { name: 'vite-plugin-cesium', transformIndexHtml: () => tags },
    ['xr.html'],
  );
  assert.equal(plugin.name, 'vite-plugin-cesium');
  assert.equal(
    plugin.transformIndexHtml('<p>xr</p>', { path: '/xr.html' }),
    '<p>xr</p>',
  );
  assert.equal(
    plugin.transformIndexHtml('<p>xr</p>', { filename: 'C:\\repo\\xr.html' }),
    '<p>xr</p>',
  );
  assert.equal(
    plugin.transformIndexHtml('<p>globe</p>', { path: '/index.html' }),
    tags,
  );
  const untouched = { name: 'x', transformIndexHtml: () => tags };
  assert.equal(
    withoutCesiumOnPages(untouched, []),
    untouched,
    'no pages: the plugin is unchanged',
  );
});

test('the standalone build has both pages and keeps Cesium off the XR page', () => {
  assert.deepEqual(STANDALONE_PAGES, { main: 'index.html', xr: 'xr.html' });
  assert.deepEqual(CESIUM_FREE_PAGES, ['xr.html']);
  const config = standaloneConfig({ command: 'build', mode: 'test' });
  const input = config.build.rollupOptions.input;
  assert.ok(input.main.endsWith('index.html'));
  assert.ok(input.xr.endsWith('xr.html'));
});

test('the panel build drops the extra page and the headset assets', () => {
  const config = panelBuildConfig({
    plugins: [{ name: 'vite-plugin-cesium' }, { name: 'xr-profiles' }],
    build: { rollupOptions: { input: { main: 'index.html', xr: 'xr.html' } } },
  });
  assert.equal(config.build.rollupOptions.input, undefined);
  assert.deepEqual(
    config.plugins.map((plugin) => plugin.name),
    ['vite-plugin-cesium'],
  );
});

test('HTTPS is configured only with both a certificate and a key', () => {
  assert.equal(resolveHttps({}), undefined);
  const read = (path) => `contents of ${path}`;
  assert.deepEqual(
    resolveHttps({ GEV_TLS_CERT: 'c.pem', GEV_TLS_KEY: 'k.pem' }, read),
    {
      cert: 'contents of c.pem',
      key: 'contents of k.pem',
    },
  );
  assert.throws(
    () => resolveHttps({ GEV_TLS_CERT: 'c.pem' }, read),
    /set together/,
  );
});

test('controller profiles are served only from the shipped list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xr-profiles-'));
  try {
    await mkdir(join(root, 'generic-hand'), { recursive: true });
    await mkdir(join(root, 'unshipped'), { recursive: true });
    await writeFile(join(root, 'generic-hand', 'left.glb'), 'glb');
    await writeFile(join(root, 'generic-hand', 'profile.json'), '{}');
    await writeFile(join(root, 'generic-hand', 'notes.txt'), 'no');
    await writeFile(join(root, 'unshipped', 'left.glb'), 'glb');
    await writeFile(
      join(root, 'profilesList.json'),
      JSON.stringify({
        'generic-hand': { path: 'x' },
        unshipped: { path: 'y' },
      }),
    );
    assert.ok(resolveProfileFile(root, 'generic-hand/left.glb'));
    assert.equal(
      resolveProfileFile(root, 'generic-hand/notes.txt'),
      null,
      'only models and profiles',
    );
    assert.equal(resolveProfileFile(root, 'unshipped/left.glb'), null);
    assert.equal(
      resolveProfileFile(root, 'generic-hand/../unshipped/left.glb'),
      null,
      'no traversal',
    );
    assert.deepEqual(
      filteredProfilesList({ 'generic-hand': 1, unshipped: 2 }),
      { 'generic-hand': 1 },
    );
    assert.deepEqual(
      profileAssets(root, ['generic-hand'])
        .map((asset) => asset.fileName)
        .sort(),
      [
        'webxr-profiles/generic-hand/left.glb',
        'webxr-profiles/generic-hand/profile.json',
      ],
    );
    let middleware;
    xrProfilesPlugin({ root }).configureServer({
      middlewares: { use: (fn) => (middleware = fn) },
    });
    const get = (url) =>
      new Promise((resolve) => {
        const res = {
          statusCode: 200,
          headers: {},
          setHeader(k, v) {
            this.headers[k] = v;
          },
          end(body) {
            resolve({
              status: this.statusCode,
              body: String(body),
              type: this.headers['Content-Type'],
            });
          },
        };
        middleware({ url }, res, () => resolve({ status: 'next' }));
      });
    assert.deepEqual(await get('/webxr-profiles/generic-hand/left.glb'), {
      status: 200,
      body: 'glb',
      type: 'model/gltf-binary',
    });
    assert.deepEqual(
      JSON.parse((await get('/webxr-profiles/profilesList.json')).body),
      { 'generic-hand': { path: 'x' } },
    );
    assert.deepEqual(await get('/webxr-profiles/unshipped/left.glb'), {
      status: 'next',
    });
    assert.deepEqual(await get('/src/main.js'), { status: 'next' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('every shipped profile exists in the installed asset package', () => {
  const files = profileAssets().map((asset) => asset.fileName);
  for (const id of XR_PROFILE_IDS)
    assert.ok(
      files.some((file) => file.startsWith(`webxr-profiles/${id}/`)),
      id,
    );
});
