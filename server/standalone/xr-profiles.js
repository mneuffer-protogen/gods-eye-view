import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';

/**
 * Controller and hand models for the mixed-reality page, served at
 * /webxr-profiles/ from the @webxr-input-profiles/assets package instead of
 * being committed. The dev server reads them from node_modules; a build
 * copies them into the output so a deployed headset page loads them from its
 * own origin and keeps working when the public CDN does not answer.
 */

export const XR_PROFILES_BASE = '/webxr-profiles/';

// Quest 3 reports Meta Touch Plus. The older Oculus aliases stay as a
// fallback because browser versions have used each of these IDs for the
// same controller family. generic-hand is the tracked-hand mesh.
export const XR_PROFILE_IDS = Object.freeze([
  'generic-hand',
  'meta-quest-touch-plus',
  'meta-quest-touch-plus-v2',
  'oculus-touch-v3',
  'oculus-touch-v2',
  'oculus-touch',
  'generic-trigger',
  'generic-trigger-squeeze-thumbstick',
]);

const CONTENT_TYPES = {
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
};

/** The package's profiles directory. */
export function profilesRoot() {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve('@webxr-input-profiles/assets/package.json')),
    'dist',
    'profiles',
  );
}

/** profilesList.json restricted to the profiles this app ships. */
export function filteredProfilesList(list, ids = XR_PROFILE_IDS) {
  return Object.fromEntries(
    ids.filter((id) => list[id]).map((id) => [id, list[id]]),
  );
}

/**
 * The file a request path names, or null when it falls outside the shipped
 * profiles. `relative` is the path after XR_PROFILES_BASE.
 */
export function resolveProfileFile(root, relative, ids = XR_PROFILE_IDS) {
  const [id] = relative.split('/');
  if (!ids.includes(id)) return null;
  const file = resolve(root, relative);
  const base = resolve(root, id);
  if (file !== base && !file.startsWith(base + sep)) return null;
  return CONTENT_TYPES[extname(file)] ? file : null;
}

/** Every shipped file as `{ fileName, read() }`, for the build. */
export function profileAssets(root = profilesRoot(), ids = XR_PROFILE_IDS) {
  const assets = [];
  for (const id of ids) {
    for (const name of readdirSync(join(root, id))) {
      if (!CONTENT_TYPES[extname(name)]) continue;
      assets.push({
        fileName: `webxr-profiles/${id}/${name}`,
        read: () => readFileSync(join(root, id, name)),
      });
    }
  }
  return assets;
}

/** Vite plugin serving the profiles in development and emitting them in a build. */
export function xrProfilesPlugin({ root: suppliedRoot } = {}) {
  let root;
  const rootDir = () => (root ??= suppliedRoot || profilesRoot());
  return {
    name: 'xr-profiles',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const { pathname } = new URL(req.url || '/', 'http://localhost');
        if (!pathname.startsWith(XR_PROFILES_BASE)) return next();
        let relative;
        try {
          relative = decodeURIComponent(
            pathname.slice(XR_PROFILES_BASE.length),
          );
        } catch {
          res.statusCode = 400;
          res.end('Bad path');
          return;
        }
        try {
          if (relative === 'profilesList.json') {
            const list = JSON.parse(
              readFileSync(join(rootDir(), 'profilesList.json'), 'utf8'),
            );
            res.setHeader('Content-Type', CONTENT_TYPES['.json']);
            res.end(JSON.stringify(filteredProfilesList(list)));
            return;
          }
          const file = resolveProfileFile(rootDir(), relative);
          if (!file) return next();
          const body = readFileSync(file);
          res.setHeader('Content-Type', CONTENT_TYPES[extname(file)]);
          res.end(body);
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      const list = JSON.parse(
        readFileSync(join(rootDir(), 'profilesList.json'), 'utf8'),
      );
      this.emitFile({
        type: 'asset',
        fileName: 'webxr-profiles/profilesList.json',
        source: JSON.stringify(filteredProfilesList(list), null, 2),
      });
      for (const asset of profileAssets(rootDir())) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: asset.read(),
        });
      }
    },
  };
}
