import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchSource } from './source.js';
import { createRocketLaunchesLayer } from './index.js';

test('launch sources preserve last-good eligibility by rejecting malformed snapshots', async () => {
  for (const payload of [{}, { results: null }]) {
    const source = createLaunchSource({
      fetchImpl: async () => new Response(JSON.stringify(payload)),
    });
    await assert.rejects(source.getLaunches(), /Malformed launch snapshot/);
  }
});

test('launch and active-orbit responses reject cancellation during parsing', async () => {
  for (const method of ['getLaunches', 'getActiveTle']) {
    const controller = new AbortController();
    const source = createLaunchSource({
      fetchImpl: async () => ({
        ok: true,
        async json() {
          controller.abort();
          return { results: [] };
        },
        async text() {
          controller.abort();
          return 'late orbit';
        },
      }),
    });
    await assert.rejects(source[method]({ signal: controller.signal }), {
      name: 'AbortError',
    });
  }
});

test('launch factories construct independently without starting a scene or source request', () => {
  const source = {
    getLaunches() {
      assert.fail('construction fetched launches');
    },
    getActiveTle() {
      assert.fail('construction fetched orbits');
    },
  };
  const services = { satellites: {}, geometry: {}, overlays: {}, render: {} };
  const first = createRocketLaunchesLayer({ source, services });
  const second = createRocketLaunchesLayer({ source, services });
  first._setSelectedRocketMissionForTest('first');
  assert.notEqual(first, second);
  assert.equal(first.getStats().count, 0);
  assert.equal(second.getStats().count, 0);
});

test('launches fall back to Launch Library directly when the server cannot serve them', async () => {
  const asked = [];
  const source = createLaunchSource({
    now: () => new Date('2026-10-05T00:00:00Z'),
    fetchImpl: async (url) => {
      asked.push(String(url));
      if (String(url) === '/api/launches')
        return new Response(
          JSON.stringify({ error: 'Not available on this deployment' }),
          { status: 503 },
        );
      return new Response(JSON.stringify({ results: [{ id: 'launch' }] }));
    },
  });
  const snapshot = await source.getLaunchSnapshot();
  assert.deepEqual(snapshot.payload.results, [{ id: 'launch' }]);
  assert.equal(snapshot.stale, false);
  assert.equal(asked[0], '/api/launches');
  assert.match(
    asked[1],
    /^https:\/\/ll\.thespacedevs\.com\/2\.3\.0\/launches\/\?/,
  );
});
