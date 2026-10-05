# Vendored WebXR framework

The modules in this directory are copied unchanged from a brand-neutral WebXR starter template
(Vite + three.js + WebXR). They give the mixed-reality page (`xr.html`, `src/xr/`) its session
entry and fallback, session lifecycle, render quality, tracked hands, controllers and controller
hands, aim rays, the glass tabletop surface, hit-test plumbing, persisted settings and in-scene
information panels.

- Template source commit: `db0b6cc474db496676375b674b66e29065203f35` (`WebXR Template/src`).
- Copied byte-for-byte. Formatting is skipped (`.prettierignore`) so a later template revision
  can be compared with a plain diff.
- Not copied: the template's test bench scene, diagnostics, desktop walk/carry controls, branding
  and deployment scripts. The globe, feeds, gestures, desktop orbit preview and branding are
  God's Eye View's own code in `src/xr/`.
- `xr-toolkit.js` imports `cannon-es` for physics-backed grabbing. The globe registers no
  grabbables, so that code path stays idle. `cannon-es` remains a dependency so the file can stay
  identical to the template.
- Controller and hand models are not committed. `server/standalone/xr-profiles.js` serves them at
  `/webxr-profiles/` from `@webxr-input-profiles/assets`, and copies them into the build. The
  profile list matches the template's `scripts/sync-xr-profiles.mjs`.

## Syncing

To bring in a template fix, diff the template's `src/` against this directory and copy the
changed files whole. Then run `npm test` and `npm run build`. Keep edits out of these files. If
the globe needs different behavior, put it in `src/xr/`, the way `interaction.js` and
`surfaceAnchor.js` build on the toolkit and `mr-placement.js`.

If a change made here would help other projects, send it back to the template instead of letting
this copy drift. Unit tests and builds do not prove headset behavior. See `docs/MIXED-REALITY.md`
for the on-device checklist.
