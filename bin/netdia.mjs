#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { loadModel } from '../src/model/load.mjs';
import { validateModel, formatDiagnostics } from '../src/model/validate.mjs';
import { deriveLayer, LAYERS } from '../src/model/derive.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme, THEMES, THEME_IDS, DEFAULT_THEME, DETAIL_LEVELS } from '../src/theme/themes.mjs';
import { renderViewer } from '../src/viewer/build.mjs';
import { freezeLayout } from '../src/layout/freeze.mjs';

const USAGE = `netdia — professional L1/L2/L3 network diagrams from one model

  netdia validate <model.yaml> [--json]
  netdia svg      <model.yaml> --layer l1|l2|l3 [-o file.svg] [--theme <id>] [--detail <level>]
  netdia iso      <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
  netdia render   <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
  netdia freeze   <model.yaml> [--layer l1|l2|l3|all] [--reset]
  netdia themes

Themes: ${THEME_IDS.join(', ')} (default: ${DEFAULT_THEME})
Detail: ${DETAIL_LEVELS.join(', ')} (default: full). Lower levels drop what is
        illegible when zoomed out — vendor marks, secondary text, port detail —
        and never the device name, its role, or the cabling.
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('-')) { flags[key] = next; i++; }
    else flags[key] = true;
  } else if (a === '-o') {
    flags.out = argv[++i];
  } else {
    positional.push(a);
  }
}

try {
  await main();
} catch (err) {
  if (err.code === 'STALE_LAYOUT' || err.code === 'PARSE_ERROR') {
    console.error(`netdia: ${err.message}`);
  } else {
    console.error(`netdia: ${err.message}`);
    if (process.env.NETDIA_DEBUG) console.error(err.stack);
  }
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'validate': return cmdValidate();
    case 'svg': return cmdSvg();
    case 'iso': return cmdIso();
    case 'render': return cmdRender();
    case 'freeze': return cmdFreeze();
    case 'themes': return cmdThemes();
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`Unknown command "${cmd}".\n${USAGE}`);
  }
}

function detailOf() {
  const level = String(flags.detail ?? 'full').toLowerCase();
  if (!DETAIL_LEVELS.includes(level)) {
    throw new Error(`--detail must be one of ${DETAIL_LEVELS.join(', ')}`);
  }
  return level;
}

function requireModel() {
  const path = positional[0];
  if (!path) throw new Error(`Missing <model.yaml>.\n${USAGE}`);
  return { path, model: loadModel(path) };
}

function checked(model, path) {
  const result = validateModel(model);
  if (!result.ok) {
    console.error(`netdia: ${path} has ${result.errors.length} error(s)\n${formatDiagnostics(result)}`);
    process.exit(1);
  }
  return result;
}

function cmdValidate() {
  const { path, model } = requireModel();
  const result = validateModel(model);
  if (flags.json) {
    console.log(JSON.stringify({ ok: result.ok, file: path, ...result }, null, 2));
  } else {
    const counts = `${result.errors.length} error(s), ${result.warnings.length} warning(s)`;
    console.log(`${result.ok ? 'ok' : 'FAILED'}  ${path}  —  ${counts}`);
    if (result.errors.length || result.warnings.length) console.log(formatDiagnostics(result));
  }
  process.exit(result.ok ? 0 : 1);
}

async function cmdSvg() {
  const { path, model } = requireModel();
  checked(model, path);
  const layer = String(flags.layer ?? 'l1').toLowerCase();
  if (!LAYERS.includes(layer)) throw new Error(`--layer must be one of ${LAYERS.join(', ')}`);

  const theme = getTheme(flags.theme ?? model.meta.theme);
  const graph = deriveLayer(model, layer);
  const placed = await layoutGraph(graph, { frozen: model.layout?.[layer] });
  const svg = renderSvg(graph, placed, theme, { detail: detailOf() });

  const out = flags.out ?? `out/${stem(path)}.${layer}.svg`;
  write(out, svg);
  console.log(
    `wrote ${out}  (${layer.toUpperCase()}, ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
      `theme ${theme.id}, detail ${detailOf()}, layout ${placed.source})`,
  );
}

async function cmdIso() {
  const { path, model } = requireModel();
  checked(model, path);
  const theme = getTheme(flags.theme ?? model.meta.theme);
  const graph = deriveLayer(model, 'l1');
  const placed = await layoutGraph(graph, { frozen: model.layout?.l1 });
  const svg = renderIsometric(graph, placed, theme, { detail: detailOf() });

  const out = flags.out ?? `out/${stem(path)}.iso.svg`;
  write(out, svg);
  console.log(
    `wrote ${out}  (isometric L1, ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
      `theme ${theme.id}, detail ${detailOf()}, layout ${placed.source})`,
  );
}

async function cmdRender() {
  const { path, model } = requireModel();
  const result = checked(model, path);
  const theme = getTheme(flags.theme ?? model.meta.theme);

  const layers = [];
  for (const layer of LAYERS) {
    const graph = deriveLayer(model, layer);
    const placed = await layoutGraph(graph, { frozen: model.layout?.[layer] });
    layers.push({ graph, placed, svg: renderSvg(graph, placed, theme, { interactive: true, titleBlock: false }) });
  }

  // The isometric view is another way of reading L1, so it reuses L1's graph
  // and inspector data and only swaps the drawing.
  if (flags['no-iso'] !== true) {
    const l1 = layers[0];
    layers.push({
      graph: { ...l1.graph, layer: 'iso', subtitle: 'Isometric physical view' },
      placed: l1.placed,
      svg: renderIsometric(l1.graph, l1.placed, theme, { interactive: true, titleBlock: false }),
    });
  }

  const html = renderViewer({
    model,
    layers,
    theme,
    themes: THEMES,
    enable3d: flags['no-3d'] !== true,
    warnings: result.warnings,
  });

  const out = flags.out ?? `out/${stem(path)}.html`;
  write(out, html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(
    `wrote ${out}  (${kb} KB, theme ${theme.id}, iso ${flags['no-iso'] === true ? 'off' : 'on'}, 3D ${flags['no-3d'] === true ? 'off' : 'on'})`,
  );
  if (result.warnings.length) {
    console.log(`${result.warnings.length} warning(s):\n${formatDiagnostics({ errors: [], warnings: result.warnings })}`);
  }
}

async function cmdFreeze() {
  const { path, model } = requireModel();
  checked(model, path);
  const which = String(flags.layer ?? 'all').toLowerCase();
  const targets = which === 'all' ? LAYERS : [which];
  for (const t of targets) if (!LAYERS.includes(t)) throw new Error(`--layer must be one of ${LAYERS.join(', ')}, or all`);

  const written = await freezeLayout(path, model, targets, { reset: flags.reset === true });
  console.log(
    flags.reset
      ? `${path}: cleared frozen layout for ${targets.join(', ')} — layout is automatic again`
      : `${path}: froze ${written} node position(s) for ${targets.join(', ')}. Edit layout: to place nodes by hand.`,
  );
}

function cmdThemes() {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    console.log(`${id.padEnd(10)} ${t.mode.padEnd(6)} ${t.description}`);
  }
}

function stem(p) {
  return basename(p).replace(/\.netdia\.ya?ml$/i, '').replace(/\.ya?ml$/i, '');
}

function write(out, content) {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
