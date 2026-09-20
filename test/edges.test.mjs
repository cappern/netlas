import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadModel, parseModel } from '../src/model/load.mjs';
import { deriveLayer, layersFor } from '../src/model/derive.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme } from '../src/theme/themes.mjs';

const model = loadModel(new URL('../examples/enterprise-dc.netdia.yaml', import.meta.url).pathname);
const theme = getTheme('signal');

test('every derived edge on every layer carries a kind and a detail', () => {
  // The inspector switches on kind and reads nothing but detail, so an edge
  // missing either renders as an empty panel rather than failing loudly.
  for (const layer of layersFor(model)) {
    const g = deriveLayer(model, layer);
    assert.ok(g.edges.length > 0, `${layer} has no edges to check`);
    for (const e of g.edges) {
      assert.ok(e.kind, `${layer} ${e.id} has no kind`);
      assert.ok(e.detail && typeof e.detail === 'object', `${layer} ${e.id} has no detail`);
    }
  }
});

test('each edge kind appears only on the layer whose relationship it describes', () => {
  // Calling an L2 membership edge a "cable" is the specific untruth this
  // separation exists to prevent.
  const kindsOf = (layer) => new Set(deriveLayer(model, layer).edges.map((e) => e.kind));

  const l1 = kindsOf('l1');
  assert.deepEqual([...l1], ['cable']);
  assert.ok(!l1.has('vlan-member'), 'L1 draws cables, never VLAN membership');

  assert.deepEqual([...kindsOf('l2')], ['vlan-member']);

  const l3 = kindsOf('l3');
  assert.ok(l3.has('attachment'));
  assert.ok(l3.has('adjacency'));
  assert.ok(!l3.has('cable'));
});

test('LAG member ports survive the merge into one drawn cable', () => {
  // The merge used to keep only a count, which left the inspector unable to
  // say which physical ports the bundle actually occupies.
  const m = parseModel(`
meta: { title: T }
devices:
  - { id: a, role: core, interfaces: [{ name: Gi0/1 }, { name: Gi0/2 }] }
  - { id: b, role: distribution, interfaces: [{ name: Te1/1 }, { name: Te1/2 }] }
links:
  - { a: "a:Gi0/1", b: "b:Te1/1", lag: Po1, speed: 10G }
  - { a: "a:Gi0/2", b: "b:Te1/2", lag: Po1, speed: 10G }
`);
  const g = deriveLayer(m, 'l1');
  assert.equal(g.edges.length, 1, 'a LAG is drawn as one cable');
  const e = g.edges[0];
  assert.equal(e.members, 2);
  assert.equal(e.detail.lag, 'Po1');
  assert.deepEqual(
    e.detail.memberLinks.map((l) => [l.aPort, l.bPort]),
    [['Gi0/1', 'Te1/1'], ['Gi0/2', 'Te1/2']],
  );
  assert.equal(e.members, e.detail.memberLinks.length);
});

test('an L1 cable reports the VLANs both ends agree on, not the union', () => {
  // A trunk only transports what both sides are configured to accept; the
  // union would claim a VLAN crosses a link one end has never heard of.
  const m = parseModel(`
meta: { title: T }
vlans: [{ id: 10 }, { id: 20 }, { id: 30 }]
devices:
  - { id: a, role: core, interfaces: [{ name: Gi0/1, mode: trunk, vlans: [10, 20] }] }
  - { id: b, role: access, interfaces: [{ name: Gi0/1, mode: trunk, vlans: [20, 30] }] }
links:
  - { a: "a:Gi0/1", b: "b:Gi0/1" }
`);
  const e = deriveLayer(m, 'l1').edges[0];
  assert.deepEqual(e.detail.vlans, [20]);
});

test('an L1 cable with an unnamed endpoint reports no VLANs rather than guessing', () => {
  const m = parseModel(`
meta: { title: T }
vlans: [{ id: 10 }]
devices:
  - { id: a, role: core, interfaces: [{ name: Gi0/1, vlan: 10 }] }
  - { id: b, role: access, interfaces: [] }
links:
  - { a: "a:Gi0/1", b: "b" }
`);
  assert.deepEqual(deriveLayer(m, 'l1').edges[0].detail.vlans, []);
});

test('an L2 membership keeps every port even when the label collapses to a count', () => {
  // The drawn label has room for two names; the inspector is the only place
  // the full list can be read, so derivation must not throw it away.
  const m = parseModel(`
meta: { title: T }
vlans: [{ id: 10, name: users, subnet: 10.0.0.0/24, gateway: 10.0.0.1 }]
devices:
  - id: sw
    role: access
    interfaces:
      - { name: Gi1, vlan: 10 }
      - { name: Gi2, vlan: 10 }
      - { name: Gi3, vlan: 10 }
      - { name: Gi4, vlan: 10 }
`);
  const e = deriveLayer(m, 'l2').edges.find((x) => x.a === 'sw');
  assert.equal(e.label, '4 ports', 'the canvas label collapses');
  assert.deepEqual(e.detail.ports, ['Gi1', 'Gi2', 'Gi3', 'Gi4']);
  assert.equal(e.detail.vlan, 10);
  assert.equal(e.detail.vlanName, 'users');
  assert.equal(e.detail.subnet, '10.0.0.0/24');
  assert.equal(e.detail.svi, false);
});

test('an L3 attachment names the interface and the network it lands on', () => {
  const g = deriveLayer(model, 'l3');
  const att = g.edges.find((e) => e.kind === 'attachment');
  // The device, its interface and its address are already on the edge; detail
  // only carries what the edge cannot express.
  assert.ok(att.a && att.aPort && att.label);
  assert.ok(att.detail.cidr, 'the network the interface lands on');
  assert.equal(typeof att.detail.gateway, 'boolean');
});

test('edge detail never repeats a fact the edge already carries', () => {
  // Two places to read the same fact is how a payload starts disagreeing with
  // itself. The viewer reads ports, media and speed from the edge; detail is
  // strictly the remainder.
  const forbidden = ['media', 'speed', 'aPort', 'bPort', 'aDevice', 'bDevice', 'device', 'iface', 'ip', 'from', 'to', 'consumer', 'provider', 'a', 'b'];
  for (const layer of layersFor(model)) {
    for (const e of deriveLayer(model, layer).edges) {
      for (const key of forbidden) {
        assert.ok(
          !(key in (e.detail ?? {})),
          `${layer} ${e.kind} detail repeats "${key}", which the edge already carries`,
        );
      }
    }
  }
});

test('a cable carries member ports only when it is a LAG', () => {
  // A single-member memberLinks array on an ordinary cable is just the edge's
  // own two port names written a second time.
  const g = deriveLayer(model, 'l1');
  for (const e of g.edges) {
    if (e.detail.lag) assert.ok(Array.isArray(e.detail.memberLinks) && e.detail.memberLinks.length >= 1);
    else assert.equal(e.detail.memberLinks, null);
  }
});

test('an L3 adjacency records direction so the inspector can pick its verb', () => {
  // "peers with" and "routes via" are not interchangeable: one implies a
  // session, the other a next hop.
  const g = deriveLayer(model, 'l3');
  const adj = g.edges.filter((e) => e.kind === 'adjacency');
  assert.ok(adj.length > 0);
  for (const e of adj) {
    assert.equal(e.detail.bidirectional, !e.directed);
    assert.ok(e.detail.routingKind);
  }
});

test('edges are focusable only when the drawing is interactive', async () => {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);

  const flat = renderSvg(g, p, theme, { interactive: true });
  assert.ok(/<g class="nd-edge"[^>]*tabindex="0"/.test(flat), 'flat edges must be reachable by tab');
  assert.ok(/<g class="nd-edge"[^>]*role="button"/.test(flat));
  const flatStatic = renderSvg(g, p, theme);
  assert.ok(!/<g class="nd-edge"[^>]*tabindex/.test(flatStatic), 'an exported SVG needs no tab stops');

  const iso = renderIsometric(g, p, theme, { interactive: true });
  assert.ok(/<g class="nd-edge"[^>]*tabindex="0"/.test(iso), 'isometric cables must be reachable too');
});

test('isometric cables get a fat transparent hit target only when interactive', async () => {
  // A projected cable is a 1-2px diagonal; without the companion path it is
  // effectively unclickable.
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);

  const on = renderIsometric(g, p, theme, { interactive: true });
  assert.ok(count(on, /class="nd-edge-hit"/g) > 0);
  assert.ok(count(on, /class="nd-edge-hit"/g) >= count(on, /<g class="nd-edge"/g),
    'every drawn segment needs its own hit path');

  // Only one tab stop per cable, not one per segment.
  assert.equal(count(on, /<g class="nd-edge"[^>]*tabindex="0"/g), g.edges.length);

  const off = renderIsometric(g, p, theme);
  assert.equal(count(off, /class="nd-edge-hit"/g), 0);
});

function count(s, re) {
  return (s.match(re) ?? []).length;
}

test('the pointer is not captured before a gesture is known to be a drag', () => {
  // This is a source-level guard because the behaviour it protects cannot be
  // reached from node:test at all, and it cost a shipped bug to learn.
  //
  // setPointerCapture retargets the click that follows to the capturing
  // element. Capturing in pointerdown therefore makes every tap on a cable
  // arrive with the stage as its target, and `e.target.closest('.nd-edge')`
  // returns null -- clicking a link silently does nothing. Node clicks were
  // unaffected only because pointerdown returns early for them, which is what
  // made the bug look like it worked.
  //
  // Synthetic click dispatch in a headless browser does not reproduce it
  // either: dispatching on the element sets the target directly and bypasses
  // the retargeting. Only a real mouse press does.
  const src = readFileSync(new URL('../src/viewer/viewer.js', import.meta.url), 'utf8');
  const down = src.slice(src.indexOf("addEventListener('pointerdown'"));
  const body = down.slice(0, down.indexOf('\n  });'));
  assert.ok(
    !body.includes('setPointerCapture'),
    'pointerdown must not capture the pointer; capture belongs in pointermove once the drag threshold is crossed',
  );
  assert.ok(
    src.includes('setPointerCapture'),
    'a committed drag must still capture, so the gesture survives leaving the stage',
  );
});
