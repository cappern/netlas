import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel } from '../src/model/load.mjs';
import { deriveLayer } from '../src/model/derive.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme, detailFlags, DETAIL_LEVELS } from '../src/theme/themes.mjs';

const model = loadModel(new URL('../examples/enterprise-dc.netdia.yaml', import.meta.url).pathname);
const theme = getTheme('signal');

async function render(kind, detail) {
  const g = deriveLayer(model, 'l1');
  const p = await layoutGraph(g);
  const svg = kind === 'iso'
    ? renderIsometric(g, p, theme, { detail })
    : renderSvg(g, p, theme, { detail });
  return { g, svg };
}

const count = (s, re) => (s.match(re) ?? []).length;

test('detail levels are validated by name', () => {
  assert.deepEqual(DETAIL_LEVELS, ['full', 'mid', 'low']);
  assert.throws(() => detailFlags('tiny'), /Use full, mid, low/);
});

for (const kind of ['flat', 'iso']) {
  test(`${kind}: lowering detail never drops a device or a cable`, async () => {
    // This is the whole promise of the feature: it removes what cannot be
    // read at that zoom, never what the diagram is for.
    const full = await render(kind, 'full');
    for (const level of ['mid', 'low']) {
      const out = await render(kind, level);
      const nodes = new Set([...out.svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]));
      const edges = new Set([...out.svg.matchAll(/data-edge="([^"]+)"/g)].map((m) => m[1]));
      assert.equal(nodes.size, full.g.nodes.length, `${kind}/${level} lost a device`);
      assert.equal(edges.size, full.g.edges.length, `${kind}/${level} lost a cable`);
      // Every device keeps its name.
      for (const n of full.g.nodes) {
        assert.ok(out.svg.includes(`>${n.label}<`), `${kind}/${level} lost the label ${n.label}`);
      }
    }
  });

  test(`${kind}: each level drops strictly more than the one above`, async () => {
    const sizes = [];
    for (const level of DETAIL_LEVELS) {
      const { svg } = await render(kind, level);
      sizes.push(svg.length);
    }
    assert.ok(sizes[0] > sizes[1], `${kind}: mid should be smaller than full`);
    assert.ok(sizes[1] > sizes[2], `${kind}: low should be smaller than mid`);
  });
}

test('mid drops vendor marks and secondary text, low drops chassis too', async () => {
  const full = (await render('flat', 'full')).svg;
  const mid = (await render('flat', 'mid')).svg;
  const low = (await render('flat', 'low')).svg;

  assert.ok(count(full, /nd-detail-vendor/g) > 20);
  assert.equal(count(mid, /nd-detail-vendor/g), 0);
  assert.equal(count(mid, /nd-detail-sub/g), 0);

  // The port strip and the port-name chips survive mid and go at low.
  assert.ok(count(mid, /nd-detail-chassis/g) > 0);
  assert.equal(count(low, /nd-detail-chassis/g), 0);
  assert.ok(count(mid, /nd-detail-chip/g) > 0);
  assert.equal(count(low, /nd-detail-chip/g), 0);
});

test('the glow filter, the most expensive thing to paint, is full-detail only', async () => {
  const full = (await render('flat', 'full')).svg;
  const mid = (await render('flat', 'mid')).svg;
  assert.ok(count(full, /filter="url\(#nd-glow\)"/g) > 30, 'the example should exercise the glow');
  assert.equal(count(mid, /filter="url\(#nd-glow\)"/g), 0);
});

test('detail classes survive into the markup so the viewer can toggle them live', async () => {
  // The viewer switches level with CSS alone; that only works if the classes
  // are on the elements rather than baked away at render time.
  const { svg } = await render('iso', 'full');
  for (const cls of ['nd-detail-chassis', 'nd-detail-sub', 'nd-detail-vendor']) {
    assert.ok(svg.includes(cls), `isometric is missing ${cls}`);
  }
  const flat = (await render('flat', 'full')).svg;
  for (const cls of ['nd-detail-chassis', 'nd-detail-sub', 'nd-detail-vendor', 'nd-detail-chip', 'nd-detail-glow']) {
    assert.ok(flat.includes(cls), `flat is missing ${cls}`);
  }
});
