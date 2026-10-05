import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveAllowedHosts } from '../../build/allowedHosts.js';
import { createBrowserViteConfig } from '../../build/vite.js';
import { localProviderPlugins } from '../providers/local.js';
import { localMcpPlugin } from '../mcp/plugin.js';
import { apiNotFoundPlugin } from './api-not-found.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { xrProfilesPlugin } from './xr-profiles.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The standalone app's HTML pages. `xr.html` is the mixed-reality globe; it
 * draws with three.js and never loads Cesium.
 */
export const STANDALONE_PAGES = Object.freeze({
  main: 'index.html',
  xr: 'xr.html',
});
export const CESIUM_FREE_PAGES = Object.freeze([STANDALONE_PAGES.xr]);

/**
 * HTTPS from `GEV_TLS_CERT` and `GEV_TLS_KEY` (PEM file paths), or undefined.
 * A headset reaching the dev server over Wi-Fi needs a secure origin to enter
 * WebXR. Both paths are required; one alone is a configuration error.
 */
export function resolveHttps(env = process.env, read = readFileSync) {
  const certPath = String(env.GEV_TLS_CERT || '').trim();
  const keyPath = String(env.GEV_TLS_KEY || '').trim();
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath)
    throw new Error('GEV_TLS_CERT and GEV_TLS_KEY must be set together');
  return { cert: read(certPath), key: read(keyPath) };
}

/** Load this checkout's configuration and attach its local provider middleware. */
export default defineConfig(({ command, mode }) => {
  const loaded = loadEnv(mode, root, '');
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const config = createBrowserViteConfig({
    plugins: [
      ...localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } }),
      localMcpPlugin(),
      xrProfilesPlugin(),
      apiNotFoundPlugin(),
    ],
    googleApiKey: process.env.GOOGLE_MAPS_API_KEY,
    cesiumToken: process.env.CESIUM_ION_TOKEN,
    host: process.env.HOST,
    port: process.env.PORT,
    allowedHosts: resolveAllowedHosts(process.env.GEV_ALLOWED_HOSTS),
    cesiumFreePages: CESIUM_FREE_PAGES,
    https: resolveHttps(),
    command,
  });
  const input = Object.fromEntries(
    Object.entries(STANDALONE_PAGES).map(([name, page]) => [
      name,
      join(root, page),
    ]),
  );
  return {
    ...config,
    build: {
      ...config.build,
      rollupOptions: { ...config.build?.rollupOptions, input },
    },
  };
});
