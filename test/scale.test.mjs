import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel } from '../src/model/load.mjs';
import { validateModel } from '../src/model/validate.mjs';
import { deriveLayer, LAYERS } from '../src/model/derive.mjs';
import { layoutGraph, MAX_TIER_WIDTH } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme } from '../src/theme/themes.mjs';

// 59 devices, 68 links, 16 VLANs, 5 zones across two sites.
const model = loadModel(new URL('../examples/enterprise-dc.netdia.yaml', import.meta.url).pathname);

test('the enterprise example is valid and non-trivial', () => {
  const r = validateModel(model);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
  assert.ok(model.devices.length >= 50, 'this example exists to exercise scale');
  assert.ok(model.vlans.length >= 15);
});

test('no tier is drawn wider than the wrap limit', async () => {
  // A tier drawn as one long row is what turns a large network into a
  // diagram you can only read by panning.
  for (const layer of LAYERS) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    const rows = new Map();
    for (const n of g.nodes) {
      const b = p.nodes.get(n.id);
      const key = Math.round(b.y);
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
    const widest = Math.max(...rows.values());
    assert.ok(
      widest <= MAX_TIER_WIDTH,
      `${layer}: widest row holds ${widest} nodes, limit is ${MAX_TIER_WIDTH}`,
    );
  }
});

test('a large network still produces a readable aspect ratio', async () => {
  // Panning a 4:1 drawing is not reading it. Both renderers have to stay
  // within something a screen or a page can show.
  for (const layer of LAYERS) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    const flat = p.width / p.height;
    assert.ok(flat < 2.6, `${layer} flat aspect ${flat.toFixed(2)} is too wide`);
  }
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  const svg = renderIsometric(g, p, getTheme('signal'));
  const [w, h] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  assert.ok(w / h < 2.6, `isometric aspect ${(w / h).toFixed(2)} is too wide`);
});

test("wrapping keeps a tier's siblings together", async () => {
  // Hosts hanging off one leaf switch should land on adjacent wrapped rows
  // rather than being scattered by declaration order. (The hypervisors are
  // deliberately spread across all four leaves for redundancy, so they
  // legitimately occupy four rows — it is the per-leaf grouping that matters.)
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);

  for (const leaf of g.nodes.filter((n) => n.id.startsWith('sw-leaf-'))) {
    const attached = g.edges
      .filter((e) => e.a === leaf.id || e.b === leaf.id)
      .map((e) => (e.a === leaf.id ? e.b : e.a))
      .filter((id) => id.startsWith('srv-') || id.startsWith('esxi-') || id.startsWith('san-'));
    if (attached.length < 2) continue;
    const rows = new Set(attached.map((id) => Math.round(p.nodes.get(id).y)));
    assert.ok(
      rows.size <= 2,
      `${leaf.id}: its ${attached.length} hosts are scattered over ${rows.size} rows`,
    );
  }
});

test('every layer renders at scale without losing a node or an edge', async () => {
  for (const layer of LAYERS) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    const svg = renderSvg(g, p, getTheme('signal'));
    const drawn = new Set([...svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(drawn.size, g.nodes.length, `${layer} dropped a node`);
    const edges = new Set([...svg.matchAll(/data-edge="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(edges.size, g.edges.length, `${layer} dropped an edge`);
  }
});
