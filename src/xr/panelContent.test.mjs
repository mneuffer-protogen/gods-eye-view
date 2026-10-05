import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings } from './framework/settings.js';
import {
  XR_SETTINGS,
  consoleContent,
  contactContent,
  formatPosition,
  settingsContent,
} from './panelContent.js';

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
};

test('positions read as hemispheres', () => {
  assert.equal(formatPosition(30.2672, -97.7431), '30.27° N, 97.74° W');
  assert.equal(formatPosition(-33.86, 151.21), '33.86° S, 151.21° E');
});

test('the console lists every feed with its state and a toggle', () => {
  const feeds = [
    {
      id: 'aircraft',
      label: 'Aircraft',
      enabled: true,
      status: 'live',
      count: 8213,
    },
    {
      id: 'vessels',
      label: 'Vessels',
      enabled: true,
      status: 'unavailable',
      count: 0,
      message: 'AISSTREAM_API_KEY not set',
    },
    {
      id: 'earthquakes',
      label: 'Earthquakes',
      enabled: false,
      status: 'idle',
      count: 0,
    },
  ];
  const content = consoleContent({
    feeds,
    mixedReality: true,
    canPlace: true,
    presenting: true,
  });
  assert.equal(content.eyebrow, 'LIVE · MIXED REALITY');
  assert.deepEqual(content.blocks[0].rows, [
    { label: 'Aircraft', value: '8,213 live' },
    { label: 'Vessels', value: 'AISSTREAM_API_KEY not set' },
    { label: 'Earthquakes', value: 'off' },
  ]);
  const ids = content.actions.map((action) => action.id);
  assert.deepEqual(ids, [
    'feed:aircraft',
    'feed:vessels',
    'feed:earthquakes',
    'face-home',
    'place',
    'settings',
    'exit',
  ]);
  assert.equal(content.actions[2].selected, false);
  assert.ok(
    ids.every((id) => !id.startsWith('@') && !id.startsWith('panel:')),
    'no reserved action ids',
  );
});

test('the desktop console offers neither placement nor exit', () => {
  const ids = consoleContent({ feeds: [] }).actions.map((action) => action.id);
  assert.deepEqual(ids, ['face-home', 'settings']);
});

test('a contact panel names the kind, the position and the details', () => {
  const content = contactContent({
    kind: 'aircraft',
    label: 'UAL1',
    lat: 30,
    lon: -97,
    details: [['Altitude', '32,808 ft']],
  });
  assert.equal(content.eyebrow, 'AIRCRAFT');
  assert.equal(content.title, 'UAL1');
  assert.deepEqual(content.blocks[0].rows, [
    { label: 'Position', value: '30.00° N, 97.00° W' },
    { label: 'Altitude', value: '32,808 ft' },
  ]);
});

test('settings rows use the shared label format and mark non-defaults', () => {
  const settings = createSettings({
    storage: memoryStorage(),
    key: 'test',
    definitions: XR_SETTINGS,
  });
  settings.set('autoSpin', 'on');
  const content = settingsContent(settings);
  const spin = content.actions.find((action) => action.id === 'autoSpin');
  assert.equal(spin.label, 'Auto-spin: on');
  assert.equal(spin.selected, true);
  assert.equal(
    content.actions.find((action) => action.id === 'renderQuality').label,
    'Render quality: balanced',
  );
  assert.equal(content.actions.at(-1).id, 'close');
});
