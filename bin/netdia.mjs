#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { loadModel } from '../src/model/load.mjs';
import { validateModel, formatDiagnostics } from '../src/model/validate.mjs';
import { deriveLayer, ALL_LAYERS, layersFor } from '../src/model/derive.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { renderIsometric } from '../src/render2d/isometric.mjs';
import { getTheme, THEMES, THEME_IDS, DEFAULT_THEME, DETAIL_LEVELS } from '../src/theme/themes.mjs';
import { renderViewer } from '../src/viewer/build.mjs';
import { freezeLayout } from '../src/layout/freeze.mjs';
import { clientFromEnv } from '../src/netbox/client.mjs';
import { resolvePortfolio, resolveSystem } from '../src/netbox/resolve.mjs';

const USAGE = `netdia — professional L1/L2/L3 network diagrams from one model

  netdia validate <model.yaml> [--json]
  netdia svg      <model.yaml> --layer l1|l2|l3|dep [-o file.svg] [--theme <id>] [--detail <level>]
  netdia iso      <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
  netdia render   <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
  netdia freeze   <model.yaml> [--layer l1|l2|l3|dep|all] [--reset]
  netdia themes

  netdia netbox portfolio        [-o file] [--theme <id>] [--yaml]
  netdia netbox system <slug>    [-o file] [--theme <id>] [--yaml]

Reads a live NetBox over its REST API and renders what it finds. Systems are
tenants; a device's owning system is Device.tenant; dependencies are the
'dependencies' custom field on the tenant.

  export NETBOX_URL="http://localhost:8000"
  export NETBOX_TOKEN="Bearer nbt_xxxx.yyyy"

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
    case 'netbox': return cmdNetbox();
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
  // Validated against what this model can actually draw, not against every
  // layer that exists: asking for dep on a model with no dependencies should
  // say so, not hand back a blank drawing.
  const available = layersFor(model);
  if (!available.includes(layer)) {
    throw new Error(
      ALL_LAYERS.includes(layer)
        ? `${path} declares no dependencies:, so there is no ${layer.toUpperCase()} layer to draw`
        : `--layer must be one of ${available.join(', ')}`,
    );
  }

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
  for (const layer of layersFor(model)) {
    const graph = deriveLayer(model, layer);
    const placed = await layoutGraph(graph, { frozen: model.layout?.[layer] });
    layers.push({ graph, placed, svg: renderSvg(graph, placed, theme, { interactive: true, titleBlock: false }) });
  }

  // The isometric view is another way of reading L1, so it reuses L1's graph
  // and inspector data and only swaps the drawing.
  if (flags['no-iso'] !== true) {
    const l1 = layers.find((l) => l.graph.layer === 'l1');
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
  // --reset must reach every layer that could ever have been frozen, or a
  // layout: block left over from a dependency the user has since deleted can
  // never be cleared. The write path only ever touches layers this model has,
  // including when a single layer is named: freezing a layer the model cannot
  // draw would add a dead block to the user's file.
  const writable = layersFor(model);
  const allowed = flags.reset === true ? ALL_LAYERS : writable;
  const targets = which === 'all' ? allowed : [which];
  for (const t of targets) {
    if (!allowed.includes(t)) {
      throw new Error(
        ALL_LAYERS.includes(t)
          ? `${path} declares no dependencies:, so there is no ${t.toUpperCase()} layout to freeze`
          : `--layer must be one of ${allowed.join(', ')}, or all`,
      );
    }
  }

  const written = await freezeLayout(path, model, targets, { reset: flags.reset === true });
  console.log(
    flags.reset
      ? `${path}: cleared frozen layout for ${targets.join(', ')} — layout is automatic again`
      : `${path}: froze ${written} node position(s) for ${targets.join(', ')}. Edit layout: to place nodes by hand.`,
  );
}

/* ---- NetBox ----------------------------------------------------------- */

async function cmdNetbox() {
  const what = positional[0];
  const client = clientFromEnv();

  let resolved;
  let stem;
  if (what === 'portfolio') {
    resolved = await resolvePortfolio(client);
    stem = 'portfolio';
    if (resolved.dangling.length) {
      // JSON Schema validates the shape of a dependency but cannot look up
      // its target. This is the only place that check can happen.
      console.error(
        `netdia: ${resolved.dangling.length} dependency target(s) do not exist as tenants:\n` +
          resolved.dangling.map((d) => `  ${d}`).join('\n'),
      );
    }
  } else if (what === 'system') {
    const slug = positional[1];
    if (!slug) throw new Error('Missing <slug>. Try: netdia netbox system ise');
    resolved = await resolveSystem(client, slug);
    stem = slug;
  } else {
    throw new Error(`Unknown netbox subcommand "${what ?? ''}". Use portfolio or system <slug>.`);
  }

  const { model } = resolved;
  const result = validateModel(model);
  if (!result.ok) {
    console.error(
      `netdia: what NetBox returned does not make a valid model ` +
        `(${result.errors.length} error(s))\n${formatDiagnostics(result)}`,
    );
    process.exit(1);
  }

  if (flags.yaml) {
    const out = flags.out ?? `out/${stem}.netdia.yaml`;
    write(out, toYaml(model));
    console.log(`wrote ${out}  (${model.devices.length} devices, resolved from NetBox)`);
    return;
  }

  const theme = getTheme(flags.theme ?? model.meta.theme);
  const layers = [];
  for (const layer of layersFor(model)) {
    const graph = deriveLayer(model, layer);
    const placed = await layoutGraph(graph);
    layers.push({
      graph, placed,
      svg: renderSvg(graph, placed, theme, { interactive: true, titleBlock: false }),
    });
  }
  if (layers.length === 0) throw new Error('NetBox returned nothing this model can draw.');

  const l1 = layers.find((l) => l.graph.layer === 'l1');
  if (l1 && flags['no-iso'] !== true) {
    layers.push({
      graph: { ...l1.graph, layer: 'iso', subtitle: 'Isometric physical view' },
      placed: l1.placed,
      svg: renderIsometric(l1.graph, l1.placed, theme, { interactive: true, titleBlock: false }),
    });
  }

  const html = renderViewer({
    model, layers, theme, themes: THEMES,
    enable3d: flags['no-3d'] !== true,
    warnings: result.warnings,
  });
  const out = flags.out ?? `out/${stem}.html`;
  write(out, html);
  console.log(
    `wrote ${out}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ` +
      `layers ${layers.map((l) => l.graph.layer).join(', ')}, theme ${theme.id})`,
  );
  if (result.warnings.length) {
    console.log(`${result.warnings.length} warning(s):\n${formatDiagnostics({ errors: [], warnings: result.warnings })}`);
  }
}

/** Emit a resolved model as YAML so it can be inspected, diffed or pinned. */
function toYaml(model) {
  const lines = ['# Resolved from NetBox by netdia. Do not hand-edit:', '# NetBox is the source of truth for everything in this file.', ''];
  const dump = (v, indent = 0) => JSON.stringify(v);
  for (const [key, value] of Object.entries(model)) {
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${dump(item)}`);
    } else {
      lines.push(`${key}: ${dump(value)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
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
