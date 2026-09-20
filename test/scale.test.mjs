import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel } from '../src/model/load.mjs';
import { validateModel } from '../src/model/validate.mjs';
import { deriveLayer, layersFor } from '../src/model/derive.mjs';
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
  for (const layer of layersFor(model)) {
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
  for (const layer of layersFor(model)) {
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
  for (const layer of layersFor(model)) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    const svg = renderSvg(g, p, getTheme('signal'));
    const drawn = new Set([...svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(drawn.size, g.nodes.length, `${layer} dropped a node`);
    const edges = new Set([...svg.matchAll(/data-edge="([^"]+)"/g)].map((m) => m[1]));
    assert.equal(edges.size, g.edges.length, `${layer} dropped an edge`);
  }
});

test('isometric cables do not cross a chassis they are unrelated to', async () => {
  // This is why the isometric view reprojects the flat layout instead of
  // re-placing nodes on its own grid: ELK routes orthogonally around
  // obstacles, and a hand-rolled two-segment router does not. The grid
  // version put 70% of cable segments through a chassis.
  const COS30 = Math.cos(Math.PI / 6);
  const SIN30 = 0.5;
  const SLAB = 26;
  const K = 0.8;
  const P = (x, y, z = 0) => ({ x: (x - y) * COS30, y: (x + y) * SIN30 - z });

  const hull = (pts) => {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
  };
  const segmentsCross = (p, q, r, s) => {
    const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = d(r, s, p), d2 = d(r, s, q), d3 = d(p, q, r), d4 = d(p, q, s);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };
  const inside = (pt, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i].y > pt.y) !== (poly[j].y > pt.y) &&
          pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  };
  const hits = (a, b, poly) => {
    if (inside(a, poly) || inside(b, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsCross(a, b, poly[j], poly[i])) return true;
    }
    return false;
  };

  const g = deriveLayer(model, 'l1');
  const flat = await layoutGraph(g);

  const silhouette = new Map();
  for (const [id, b0] of flat.nodes) {
    const b = { x: b0.x * K, y: b0.y * K, w: b0.w * K, h: b0.h * K };
    const corners = [];
    for (const X of [b.x, b.x + b.w]) for (const Y of [b.y, b.y + b.h]) for (const Z of [0, SLAB]) {
      corners.push(P(X, Y, Z));
    }
    silhouette.set(id, hull(corners));
  }

  let segments = 0;
  let crossings = 0;
  for (const e of g.edges) {
    const route = flat.edges.get(e.id);
    if (!route) continue;
    const pts = route.points.map((p) => ({ x: p.x * K, y: p.y * K }));
    for (let i = 1; i < pts.length; i++) {
      segments++;
      const a = P(pts[i - 1].x, pts[i - 1].y, SLAB * 0.55);
      const b = P(pts[i].x, pts[i].y, SLAB * 0.55);
      for (const [id, poly] of silhouette) {
        if (id === e.a || id === e.b) continue;
        if (hits(a, b, poly)) { crossings++; break; }
      }
    }
  }

  const ratio = crossings / segments;
  assert.ok(
    ratio < 0.05,
    `${crossings} of ${segments} cable segments (${Math.round(ratio * 100)}%) cross an unrelated chassis`,
  );
});
