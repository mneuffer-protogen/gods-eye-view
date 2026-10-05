/**
 * Content for the in-scene panels, as plain data for the framework's panel
 * manager (framework/panels/manager.js). Kept free of three.js and the DOM
 * so the unit suite can check exactly what a headset user reads.
 */

import {
  SETTINGS as FRAMEWORK_SETTINGS,
  labelFor,
} from './framework/settings.js';
import { CONTACT_STYLE } from './contacts.js';
import { describeFeed } from './feeds.js';

export const XR_SETTINGS_KEY = 'gods-eye-view:xr-settings';

// The framework's controller-hand and render-quality settings, plus the
// globe's own. One definition each; the board and the page read the same
// store.
export const XR_SETTINGS = Object.freeze({
  autoSpin: Object.freeze({
    default: 'off',
    values: ['off', 'on'],
    label: 'Auto-spin',
  }),
  dayNight: Object.freeze({
    default: 'on',
    values: ['on', 'off'],
    label: 'Day and night',
  }),
  renderQuality: FRAMEWORK_SETTINGS.renderQuality,
  controllerVisual: FRAMEWORK_SETTINGS.controllerVisual,
});

/** `30.27° N, 97.74° W` */
export function formatPosition(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lon).toFixed(2)}° ${ew}`;
}

/** The main console: feed status, feed toggles and the globe's commands. */
export function consoleContent({
  feeds,
  mixedReality = false,
  canPlace = false,
  presenting = false,
}) {
  return {
    taskId: 'console',
    eyebrow: mixedReality ? 'LIVE · MIXED REALITY' : 'LIVE · TABLETOP GLOBE',
    title: "God's Eye View",
    blocks: [
      {
        type: 'keyValue',
        rows: feeds.map((feed) => ({
          label: feed.label,
          value: describeFeed(feed),
        })),
      },
    ],
    actions: [
      ...feeds.map((feed) => ({
        id: `feed:${feed.id}`,
        label: feed.label,
        selected: feed.enabled,
      })),
      { id: 'face-home', label: 'Face start location' },
      ...(canPlace ? [{ id: 'place', label: 'Set on a surface' }] : []),
      { id: 'settings', label: 'Settings' },
      ...(presenting ? [{ id: 'exit', label: 'Exit headset' }] : []),
    ],
  };
}

/** The selected contact's details. */
export function contactContent(contact) {
  const style = CONTACT_STYLE[contact.kind];
  return {
    taskId: 'contact',
    eyebrow: style?.label || 'CONTACT',
    title: String(contact.label || 'Unknown').slice(0, 48),
    blocks: [
      {
        type: 'keyValue',
        rows: [
          {
            label: 'Position',
            value: formatPosition(contact.lat, contact.lon),
          },
          ...(contact.details || []).map(([label, value]) => ({
            label,
            value: String(value),
          })),
        ],
      },
    ],
    actions: [{ id: 'close', label: 'Close' }],
  };
}

/** The settings board: one row per setting, as the framework's boards are. */
export function settingsContent(settings, definitions = XR_SETTINGS) {
  return {
    taskId: 'settings',
    eyebrow: 'PREFERENCES',
    title: 'Settings',
    actions: [
      ...Object.keys(definitions).map((id) => ({
        id,
        label: labelFor(id, settings.get(id), definitions),
        selected: settings.get(id) !== definitions[id].default,
      })),
      { id: 'close', label: 'Done' },
    ],
  };
}
