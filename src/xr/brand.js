/**
 * God's Eye View's identity in the shape the XR framework's panels read
 * (`colors`, `fonts`, `name`): the main app's palette and typefaces from
 * src/ui/styles/foundation.css. Text pairs keep at least 4.5:1 contrast
 * (text/background, muted/surface, accentText/accent).
 */

export const brand = Object.freeze({
  id: 'gods-eye-view',
  name: "God's Eye View",
  tagline: 'LIVE · MIXED REALITY',
  colors: Object.freeze({
    background: '#0a0a0f',
    surface: '#161622',
    text: '#e8eaed',
    muted: '#a8adb7',
    accent: '#00d4ff',
    accentText: '#04121a',
    border: '#3a4252',
  }),
  fonts: Object.freeze({
    body: Object.freeze({ family: 'Inter' }),
    display: Object.freeze({ family: 'JetBrains Mono' }),
  }),
});

/** Resolves once the panel fonts are ready to measure (or have failed). */
export function brandReady(fonts = globalThis.document?.fonts) {
  if (!fonts?.load) return Promise.resolve();
  return Promise.allSettled([
    fonts.load(`700 32px "${brand.fonts.display.family}"`),
    fonts.load(`400 16px "${brand.fonts.body.family}"`),
    fonts.load(`700 16px "${brand.fonts.body.family}"`),
  ]);
}
