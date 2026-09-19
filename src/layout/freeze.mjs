import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { deriveLayer } from '../model/derive.mjs';
import { layoutGraph } from './index.mjs';

/**
 * Convert automatic layout into manual layout.
 *
 * This is the escape hatch that makes automatic layout safe to rely on: run
 * the solver once, write the coordinates it chose back into the model, then
 * nudge them by hand. The model stays the single source of truth, and the
 * diff shows exactly which nodes a human moved.
 *
 * The frozen block is rewritten in place. Comments elsewhere in the file are
 * preserved by splicing on the top-level `layout:` key rather than
 * round-tripping the whole document through the YAML dumper.
 */
export async function freezeLayout(path, model, layers, { reset = false } = {}) {
  const abs = resolve(path);
  const original = readFileSync(abs, 'utf8');

  const layout = { ...(model.layout ?? {}) };
  let count = 0;

  for (const layer of layers) {
    if (reset) {
      delete layout[layer];
      continue;
    }
    const graph = deriveLayer(model, layer);
    const placed = await layoutGraph(graph, { frozen: null });
    const nodes = {};
    for (const n of graph.nodes) {
      const b = placed.nodes.get(n.id);
      if (!b) continue;
      nodes[n.id] = { x: round(b.x), y: round(b.y) };
      count++;
    }
    layout[layer] = { nodes };
  }

  writeFileSync(abs, spliceLayout(original, layout));
  return count;
}

function round(n) {
  return Math.round(n);
}

/** Replace the top-level `layout:` block, keeping the rest of the file byte-identical. */
function spliceLayout(source, layout) {
  const block = renderLayoutBlock(layout);
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^layout\s*:/.test(l));

  if (start === -1) {
    const trimmed = source.replace(/\s*$/, '');
    return `${trimmed}\n\n${block}\n`;
  }

  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^\s+\S/.test(lines[end]))) end++;
  // Trailing blank lines inside the block belong to whatever follows.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;

  return [...lines.slice(0, start), ...block.split('\n'), ...lines.slice(end)].join('\n');
}

function renderLayoutBlock(layout) {
  if (Object.keys(layout).length === 0) return 'layout: {}';
  const body = yaml.dump({ layout }, { indent: 2, lineWidth: 120, sortKeys: false, flowLevel: 3 });
  return body.replace(/\n$/, '');
}
