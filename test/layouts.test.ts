import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveLayer } from '../src/lib/core/model/derive.ts';
import { layoutGraph } from '../src/lib/core/layout/index.ts';
import {
  normalizeModel, frozenLayers, defaultLayoutId, layoutOptions, AUTO_LAYOUT,
} from '../src/lib/core/model/load.ts';
import type { Model } from '../src/lib/core/model/types.ts';

const star: Model = normalizeModel({
  meta: { title: 'T' },
  devices: [
    { id: 'a', role: 'core' },
    { id: 'b', role: 'access' },
    { id: 'c', role: 'access' },
    { id: 'd', role: 'access' },
  ],
  links: [{ a: 'a', b: 'b' }, { a: 'a', b: 'c' }, { a: 'a', b: 'd' }],
});

test('frozen edges leaving one node fan out instead of stacking', async () => {
  // a on top, b/c/d in a row below: all three leave a on its bottom side.
  const frozen = {
    l1: { nodes: { a: { x: 200, y: 40 }, b: { x: 40, y: 260 }, c: { x: 200, y: 260 }, d: { x: 360, y: 260 } } },
  };
  const placed = await layoutGraph(deriveLayer(star, 'l1'), { frozen: frozen.l1 });
  const startX = [...placed.edges.values()].map((r) => r.points[0].x);
  assert.equal(new Set(startX).size, startX.length, 'each edge should get a distinct anchor');
});

test('a single edge on a side stays centred', async () => {
  const two: Model = normalizeModel({
    meta: { title: 'T' },
    devices: [{ id: 'a', role: 'core' }, { id: 'b', role: 'access' }],
    links: [{ a: 'a', b: 'b' }],
  });
  const frozen = { l1: { nodes: { a: { x: 100, y: 40 }, b: { x: 100, y: 260 } } } };
  const placed = await layoutGraph(deriveLayer(two, 'l1'), { frozen: frozen.l1 });
  const route = [...placed.edges.values()][0];
  const a = placed.nodes.get('a')!;
  assert.equal(route.points[0].x, a.x + a.w / 2, 'the only edge should exit the centre of the side');
});

test('layoutOptions lists Auto first, then named layouts', () => {
  const m = normalizeModel({
    ...star,
    layouts: [{ id: 'layout-1', name: 'Rack', layers: {} }],
  });
  assert.deepEqual(layoutOptions(m).map((o) => o.id), [AUTO_LAYOUT, 'layout-1']);
});

test('defaultLayoutId is Auto unless a default is set', () => {
  assert.equal(defaultLayoutId(star), AUTO_LAYOUT);
  const m = normalizeModel({ ...star, layouts: [{ id: 'layout-1', name: 'Rack', layers: {} }], defaultLayout: 'layout-1' });
  assert.equal(defaultLayoutId(m), 'layout-1');
});

test('frozenLayers resolves the chosen layout, and Auto resolves to nothing', () => {
  const m = normalizeModel({
    ...star,
    layouts: [{ id: 'layout-1', name: 'Rack', layers: { l1: { nodes: { a: { x: 5, y: 6 } } } } }],
    defaultLayout: 'layout-1',
  });
  assert.equal(frozenLayers(m)?.l1?.nodes?.a?.x, 5);
  assert.equal(frozenLayers(m, AUTO_LAYOUT), undefined);
});
