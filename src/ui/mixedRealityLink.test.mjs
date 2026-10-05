import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mixedRealityHref } from './mixedRealityLink.js';

test('the mixed-reality link faces the place the camera is over', () => {
  const href = mixedRealityHref(
    {
      latitude: (30.2672 * Math.PI) / 180,
      longitude: (-97.7431 * Math.PI) / 180,
    },
    'https://globe.example/app/?v=2',
  );
  assert.equal(
    href,
    'https://globe.example/app/xr.html?lat=30.2672&lon=-97.7431',
  );
});

test('without a camera position the link opens the page unfocused', () => {
  assert.equal(
    mixedRealityHref(undefined, 'http://localhost:4173/'),
    'http://localhost:4173/xr.html',
  );
});

test('the toolbar carries the action and every mode that hides the toolbar actions hides it', () => {
  const html = readFileSync(
    new URL('./templates/scene-chrome.html', import.meta.url),
    'utf8',
  );
  const toolbar = html.match(/<nav id="top-center-actions"[\s\S]*?<\/nav>/)[0];
  assert.match(
    toolbar,
    /id="open-mixed-reality"[^>]*aria-label="Open the globe in mixed reality"/,
  );
  for (const sheet of ['cockpit.css', 'recording.css']) {
    const css = readFileSync(
      new URL(`./styles/${sheet}`, import.meta.url),
      'utf8',
    );
    assert.match(
      css,
      /#reset-globe-view,\s*#open-mixed-reality\s*\)\s*\{\s*display:\s*none !important;/,
      sheet,
    );
  }
});
