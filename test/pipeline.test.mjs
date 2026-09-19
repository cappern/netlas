import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadModel, parseModel } from '../src/model/load.mjs';
import { validateModel } from '../src/model/validate.mjs';
import { deriveLayer, LAYERS } from '../src/model/derive.mjs';
import { layoutGraph, groupHulls } from '../src/layout/index.mjs';
import { freezeLayout } from '../src/layout/freeze.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme, THEME_IDS } from '../src/theme/themes.mjs';

const EXAMPLE = new URL('../examples/iac-lab.netdia.yaml', import.meta.url).pathname;
const model = loadModel(EXAMPLE);

test('the shipped example is valid', () => {
  const r = validateModel(model);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('L1 keeps every device and every cable', () => {
  const g = deriveLayer(model, 'l1');
  assert.equal(g.nodes.length, model.devices.length);
  assert.equal(g.edges.length, model.links.length);
  for (const e of g.edges) {
    assert.ok(g.nodes.some((n) => n.id === e.a), `missing ${e.a}`);
    assert.ok(g.nodes.some((n) => n.id === e.b), `missing ${e.b}`);
  }
});

test('L2 creates one node per VLAN in use and no orphan edges', () => {
  const g = deriveLayer(model, 'l2');
  const vlanNodes = g.nodes.filter((n) => n.kind === 'vlan');
  assert.equal(vlanNodes.length, model.vlans.length);
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    assert.ok(ids.has(e.a) && ids.has(e.b), `orphan edge ${e.id}`);
  }
});

test('L2 marks an SVI as the gateway and a trunk as tagged', () => {
  const g = deriveLayer(model, 'l2');
  const svi = g.edges.find((e) => e.a === 'sw-core-1' && e.b === 'vlan:10');
  assert.equal(svi.style, 'gateway');
  assert.equal(svi.label, 'SVI');
  const trunk = g.edges.find((e) => e.a === 'sw-acc-1' && e.b === 'vlan:10');
  assert.equal(trunk.media, 'tagged');
});

test('L2 drops a device that belongs to no VLAN', () => {
  const m = parseModel(`
meta: { title: T }
vlans: [{ id: 10 }]
devices:
  - { id: sw, role: access, interfaces: [{ name: Gi1, vlan: 10 }] }
  - { id: router, role: router, interfaces: [{ name: e0, ip: 10.0.0.1/30 }] }
`);
  const g = deriveLayer(m, 'l2');
  assert.ok(!g.nodes.some((n) => n.id === 'router'));
});

test('L3 drops pure L2 switches but keeps routed devices', () => {
  const g = deriveLayer(model, 'l3');
  const ids = g.nodes.map((n) => n.id);
  assert.ok(!ids.includes('sw-acc-1'), 'an access switch has no L3 presence');
  assert.ok(ids.includes('sw-core-1'), 'the core has SVIs');
  assert.ok(ids.includes('fw-edge-1'));
});

test('L3 groups every declared network and finds its gateway', () => {
  const g = deriveLayer(model, 'l3');
  const users = g.nodes.find((n) => n.id === 'net:10.10.10.0/24');
  assert.ok(users);
  const gw = users.detail.attached.find((a) => a.gateway);
  assert.equal(gw.device, 'sw-core-1');
  assert.equal(gw.ip, '10.10.10.1/24');
});

test('L3 routing adjacencies are directed unless declared bidirectional', () => {
  const g = deriveLayer(model, 'l3');
  const route = g.edges.find((e) => e.style === 'route-default');
  assert.equal(route.directed, true);
});

test('every layer lays out with positions for every node and edge', async () => {
  for (const layer of LAYERS) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    assert.equal(p.nodes.size, g.nodes.length, layer);
    for (const e of g.edges) {
      const route = p.edges.get(e.id);
      assert.ok(route && route.points.length >= 2, `${layer} ${e.id} has no route`);
    }
    assert.ok(p.width > 0 && p.height > 0);
  }
});

test('role tiers put the internet above the access layer', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  assert.ok(p.nodes.get('internet').y < p.nodes.get('fw-edge-1').y);
  assert.ok(p.nodes.get('fw-edge-1').y < p.nodes.get('sw-core-1').y);
  assert.ok(p.nodes.get('sw-core-1').y < p.nodes.get('sw-acc-1').y);
  assert.ok(p.nodes.get('sw-acc-1').y < p.nodes.get('srv-git-1').y);
});

test('zone hulls are reported unusable when they would overlap', async () => {
  // L1 follows zone boundaries; L2 interleaves VLANs, so its hulls overlap
  // and the renderer must fall back to per-node zone badges.
  const l1 = await layoutGraph(deriveLayer(model, 'l1'));
  assert.equal(groupHulls(deriveLayer(model, 'l1'), l1).usable, true);
  const l2g = deriveLayer(model, 'l2');
  const l2 = await layoutGraph(l2g);
  assert.equal(groupHulls(l2g, l2).usable, false);
});

test('every theme renders well-formed SVG that contains the content', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  for (const id of THEME_IDS) {
    const svg = renderSvg(g, p, getTheme(id));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.endsWith('</svg>'));
    assert.equal(countTags(svg, 'g'), countCloseTags(svg, 'g'), `${id} has unbalanced <g>`);
    assert.ok(svg.includes('SW-CORE-1'), id);
    assert.ok(svg.includes('IaC Lab'), id);
  }
});

test('every drawn box fits inside the viewBox once the content offset is applied', async () => {
  for (const layer of LAYERS) {
    const g = deriveLayer(model, layer);
    const p = await layoutGraph(g);
    const svg = renderSvg(g, p, getTheme('signal'));
    const [vw, vh] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);

    // Everything between the content group and the legend is group-local and
    // must be shifted by the group's translate before it can be checked.
    const start = svg.indexOf('<g class="nd-content"');
    const end = svg.indexOf('<g class="nd-legend"');
    const [ox, oy] = svg
      .slice(start)
      .match(/translate\(([-\d.]+) ([-\d.]+)\)/)
      .slice(1)
      .map(Number);
    const body = svg.slice(start, end === -1 ? undefined : end);

    let checked = 0;
    for (const m of body.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)) {
      const [x, y, w, h] = m.slice(1).map(Number);
      const ax = x + ox;
      const ay = y + oy;
      assert.ok(ax >= -0.5 && ay >= -0.5, `${layer}: box clipped at left/top (${ax}, ${ay})`);
      assert.ok(ax + w <= vw + 0.5, `${layer}: box overflows right (${ax + w} > ${vw})`);
      assert.ok(ay + h <= vh + 0.5, `${layer}: box overflows bottom (${ay + h} > ${vh})`);
      checked++;
    }
    assert.ok(checked > 10, `${layer}: expected to check many boxes, checked ${checked}`);
  }
});

test('XML special characters in labels are escaped', async () => {
  const m = parseModel(`
meta: { title: "A & B <lab>" }
devices:
  - { id: x, role: server, label: "a<b>&c" }
`);
  const g = deriveLayer(m, 'l1');
  const svg = renderSvg(g, await layoutGraph(g), getTheme('signal'));
  assert.ok(svg.includes('a&lt;b&gt;&amp;c'));
  assert.ok(!svg.includes('a<b>&c'));
});

test('freeze writes coordinates back and the model still validates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'netdia-'));
  const file = join(dir, 'm.netdia.yaml');
  const original = readFileSync(EXAMPLE, 'utf8');
  writeFileSync(file, original);

  const count = await freezeLayout(file, loadModel(file), ['l1']);
  assert.ok(count > 0);

  const frozen = loadModel(file);
  assert.equal(validateModel(frozen).ok, true);
  assert.ok(Object.keys(frozen.layout.l1.nodes).length === frozen.devices.length);

  // Comments above the layout block survive the splice.
  assert.ok(readFileSync(file, 'utf8').includes('# netdia example'));

  // A frozen layout is honoured verbatim.
  const g = deriveLayer(frozen, 'l1');
  const p = await layoutGraph(g, { frozen: frozen.layout.l1 });
  assert.equal(p.source, 'frozen');
  assert.equal(p.nodes.get('sw-core-1').x, frozen.layout.l1.nodes['sw-core-1'].x);

  // Resetting returns to automatic layout.
  await freezeLayout(file, loadModel(file), ['l1'], { reset: true });
  assert.equal(loadModel(file).layout.l1, undefined);
});

test('a stale frozen layout fails loudly instead of dropping nodes', async () => {
  const g = deriveLayer(model, 'l1');
  await assert.rejects(
    () => layoutGraph(g, { frozen: { nodes: { 'sw-core-1': { x: 0, y: 0 } } } }),
    /STALE_LAYOUT|missing/,
  );
});

test('an unknown layer or theme is rejected by name', () => {
  assert.throws(() => deriveLayer(model, 'l4'), /l1, l2 or l3/);
  assert.throws(() => getTheme('neon'), /Available:/);
});

function countTags(s, tag) {
  return (s.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
}
function countCloseTags(s, tag) {
  return (s.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
}

/* ---- isometric L1 ----------------------------------------------------- */

test('isometric draws one slab per device and keeps every cable', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  const svg = renderIsometric(g, p, getTheme('signal'));
  assert.equal(countMatches(svg, /class="nd-node"/g), g.nodes.length);
  const drawn = new Set([...svg.matchAll(/data-edge="([^"]+)"/g)].map((m) => m[1]));
  assert.equal(drawn.size, g.edges.length, 'every cable must appear at least once');
});

test('isometric renders well-formed SVG in every theme', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  for (const id of THEME_IDS) {
    const svg = renderIsometric(g, p, getTheme(id));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.endsWith('</svg>'));
    assert.equal(countMatches(svg, /<g[ >]/g), countMatches(svg, /<\/g>/g), `${id} unbalanced <g>`);
    assert.ok(svg.includes('SW-CORE-1'), id);
  }
});

test('isometric content fits inside its viewBox', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  const svg = renderIsometric(g, p, getTheme('signal'));
  const [vw, vh] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).slice(1).map(Number);
  const start = svg.indexOf('<g class="nd-content"');
  const end = svg.indexOf('<g class="nd-legend"');
  const [ox, oy] = svg.slice(start).match(/translate\(([-\d.]+) ([-\d.]+)\)/).slice(1).map(Number);
  const body = svg.slice(start, end);

  let checked = 0;
  for (const m of body.matchAll(/points="([^"]+)"/g)) {
    for (const pt of m[1].split(' ')) {
      const [x, y] = pt.split(',').map(Number);
      assert.ok(x + ox >= -0.5 && x + ox <= vw + 0.5, `x ${x + ox} outside 0..${vw}`);
      assert.ok(y + oy >= -0.5 && y + oy <= vh + 0.5, `y ${y + oy} outside 0..${vh}`);
      checked++;
    }
  }
  assert.ok(checked > 40, `expected many points, got ${checked}`);
});

test('isometric keeps tier order along the depth axis', async () => {
  // The core must sit behind the access switches, which sit behind the servers.
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  const svg = renderIsometric(g, p, getTheme('signal'));
  const order = [...svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(order.indexOf('sw-core-1') < order.indexOf('sw-acc-1'));
  assert.ok(order.indexOf('sw-acc-1') < order.indexOf('srv-git-1'));
});

test('isometric drops zone plates rather than drawing overlapping floors', async () => {
  // Two zones interleaved across the same tier cannot both own that ground.
  const m = parseModel(`
meta: { title: T }
zones:
  - { id: a, kind: trust }
  - { id: b, kind: dmz }
devices:
  - { id: sw, role: core, zone: a, interfaces: [{ name: p1 }, { name: p2 }, { name: p3 }] }
  - { id: s1, role: server, zone: a, interfaces: [{ name: e0 }] }
  - { id: s2, role: server, zone: b, interfaces: [{ name: e0 }] }
  - { id: s3, role: server, zone: a, interfaces: [{ name: e0 }] }
links:
  - { a: "sw:p1", b: "s1:e0" }
  - { a: "sw:p2", b: "s2:e0" }
  - { a: "sw:p3", b: "s3:e0" }
`);
  const g = deriveLayer(m, 'l1');
  const p = await layoutGraph(g);
  const svg = renderIsometric(g, p, getTheme('signal'));
  assert.equal(countMatches(svg, /class="nd-zone"/g), 0, 'interleaved zones must not draw plates');
  // The zone is still reported, as text on the slab.
  assert.ok(svg.includes('· b'), 'zone must fall back to a text badge');
});

function countMatches(s, re) {
  return (s.match(re) ?? []).length;
}
