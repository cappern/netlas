import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel } from '../src/lib/core/model/load-file.ts';
import { deriveLayer, layersFor } from '../src/lib/core/model/derive.ts';
import { layoutGraph } from '../src/lib/core/layout/index.ts';
import { renderSvg, esc } from '../src/lib/core/render2d/svg.ts';
import { getTheme } from '../src/lib/core/theme/themes.ts';
import type { PlacedBox } from '../src/lib/core/layout/index.ts';

// netlas exists to produce a picture a human reads. These tests assert the
// things a reader would notice at a glance — no overlapping cards, every device
// named, zones drawn as boxes — rather than only internal structure.

const EXAMPLES = ['iac-lab', 'enterprise-dc', 'ise-dependencies'].map(
  (n) => new URL(`../examples/${n}.netlas.yaml`, import.meta.url).pathname,
);

function overlap(a: PlacedBox, b: PlacedBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

test('device boxes never overlap on any drawn layer', async () => {
  for (const path of EXAMPLES) {
    const model = loadModel(path);
    for (const layer of layersFor(model)) {
      const placed = await layoutGraph(deriveLayer(model, layer));
      const boxes = [...placed.nodes.values()];
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          assert.ok(
            !overlap(boxes[i], boxes[j]),
            `${path} ${layer}: two device boxes sit on top of each other`,
          );
        }
      }
    }
  }
});

test('every device is rendered as visible, named text', async () => {
  for (const path of EXAMPLES) {
    const model = loadModel(path);
    const g = deriveLayer(model, 'l1');
    const svg = renderSvg(g, await layoutGraph(g), getTheme('signal'));
    for (const n of g.nodes) {
      assert.ok(svg.includes(esc(n.label)), `${path}: device label "${n.label}" is not drawn`);
    }
  }
});

test('the IaC lab draws its security zones as labelled boxes', async () => {
  // The lab's zones are spatially separable, so they must draw as boxes rather
  // than silently collapse to per-node badges. Guards the regression where a
  // DMZ change put two zones on one tier and the boxes vanished.
  const model = loadModel(new URL('../examples/iac-lab.netlas.yaml', import.meta.url).pathname);
  const g = deriveLayer(model, 'l1');
  const svg = renderSvg(g, await layoutGraph(g), getTheme('signal'));
  assert.equal((svg.match(/class="nd-zone"/g) ?? []).length, 3, 'expected three zone boxes drawn');
  for (const label of ['UNTRUST', 'DMZ', 'TRUST']) {
    assert.ok(svg.includes(label), `zone label ${label} is not drawn`);
  }
});

test('the legend names every cable medium actually drawn', async () => {
  // The colour key has to match the picture: a medium on a cable but missing
  // from the legend leaves a reader unable to decode a line they can see.
  const model = loadModel(new URL('../examples/iac-lab.netlas.yaml', import.meta.url).pathname);
  const g = deriveLayer(model, 'l1');
  const media = new Set(g.edges.map((e) => e.media));
  const legendKinds = new Set(g.legend.map((l) => l.kind));
  for (const m of media) {
    assert.ok(legendKinds.has(m), `medium "${m}" is drawn but missing from the legend`);
  }
});
