#!/usr/bin/env node
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { loadModel } from '../src/lib/core/model/load-file.ts';
import { frozenLayers } from '../src/lib/core/model/load.ts';
import { validateModel, formatDiagnostics } from '../src/lib/core/model/validate.ts';
import { deriveLayer, ALL_LAYERS, layersFor } from '../src/lib/core/model/derive.ts';
import { layoutGraph } from '../src/lib/core/layout/index.ts';
import { renderSvg } from '../src/lib/core/render2d/svg.ts';
import { renderIsometric } from '../src/lib/core/render2d/isometric.ts';
import { getTheme, THEMES, THEME_IDS, DEFAULT_THEME, DETAIL_LEVELS } from '../src/lib/core/theme/themes.ts';
import { renderViewer } from '../src/lib/core/viewer/build.ts';
import type { ViewerLayer } from '../src/lib/core/viewer/build.ts';
import { freezeLayout } from '../src/lib/core/layout/freeze.ts';
import { loadWorkspace } from '../src/lib/core/workspace/index.ts';
import type { Model, LayerId, Diagnostics } from '../src/lib/core/model/types.ts';

const USAGE = `netlas — professional L1/L2/L3 network diagrams from one model

  netlas validate  <model.yaml> [--json]
  netlas svg       <model.yaml> --layer l1|l2|l3|dep [-o file.svg] [--theme <id>] [--detail <level>]
  netlas iso       <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
  netlas render    <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
  netlas freeze    <model.yaml> [--layer l1|l2|l3|dep|all] [--reset]
  netlas workspace <dir> [-o out-dir] [--theme <id>] [--no-3d] [--no-iso]
  netlas themes

A workspace is a folder with a workspace.netlas.yaml manifest that lists
several designs and the links between them. "netlas workspace" renders every
design to a self-contained HTML file and wires the cross-design links.

Themes: ${THEME_IDS.join(', ')} (default: ${DEFAULT_THEME})
Detail: ${DETAIL_LEVELS.join(', ')} (default: full). Lower levels drop what is
        illegible when zoomed out — vendor marks, secondary text, port detail —
        and never the device name, its role, or the cabling.
`;

const argv = process.argv.slice(2);
const cmd = argv[0];

const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
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

/** Read a value-taking flag; a bare boolean flag (e.g. `--theme`) reads as absent. */
function strFlag(name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

try {
  await main();
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'STALE_LAYOUT' || e.code === 'PARSE_ERROR') {
    console.error(`netlas: ${e.message}`);
  } else {
    console.error(`netlas: ${e.message}`);
    if (process.env.NETLAS_DEBUG) console.error(e.stack);
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
    case 'workspace': return cmdWorkspace();
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

function detailOf(): string {
  const level = String(flags.detail ?? 'full').toLowerCase();
  if (!DETAIL_LEVELS.includes(level)) {
    throw new Error(`--detail must be one of ${DETAIL_LEVELS.join(', ')}`);
  }
  return level;
}

function requireModel(): { path: string; model: Model } {
  const path = positional[0];
  if (!path) throw new Error(`Missing <model.yaml>.\n${USAGE}`);
  return { path, model: loadModel(path) };
}

function checked(model: Model, path: string): Diagnostics {
  const result = validateModel(model);
  if (!result.ok) {
    console.error(`netlas: ${path} has ${result.errors.length} error(s)\n${formatDiagnostics(result)}`);
    process.exit(1);
  }
  return result;
}

function cmdValidate() {
  const { path, model } = requireModel();
  const result = validateModel(model);
  if (flags.json) {
    console.log(JSON.stringify({ file: path, ...result }, null, 2));
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
  if (!(available as string[]).includes(layer)) {
    throw new Error(
      (ALL_LAYERS as string[]).includes(layer)
        ? `${path} declares no dependencies, so there is no ${layer.toUpperCase()} layer to draw`
        : `--layer must be one of ${available.join(', ')}`,
    );
  }

  const theme = getTheme(strFlag('theme') ?? model.meta.theme);
  const graph = deriveLayer(model, layer as LayerId);
  const placed = await layoutGraph(graph, { frozen: frozenLayers(model)?.[layer] });
  const svg = renderSvg(graph, placed, theme, { detail: detailOf() });

  const out = strFlag('out') ?? `out/${stem(path)}.${layer}.svg`;
  write(out, svg);
  console.log(
    `wrote ${out}  (${layer.toUpperCase()}, ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
      `theme ${theme.id}, detail ${detailOf()}, layout ${placed.source})`,
  );
}

async function cmdIso() {
  const { path, model } = requireModel();
  checked(model, path);
  const theme = getTheme(strFlag('theme') ?? model.meta.theme);
  const graph = deriveLayer(model, 'l1');
  const placed = await layoutGraph(graph, { frozen: frozenLayers(model)?.l1 });
  const svg = renderIsometric(graph, placed, theme, { detail: detailOf() });

  const out = strFlag('out') ?? `out/${stem(path)}.iso.svg`;
  write(out, svg);
  console.log(
    `wrote ${out}  (isometric L1, ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
      `theme ${theme.id}, detail ${detailOf()}, layout ${placed.source})`,
  );
}

async function cmdRender() {
  const { path, model } = requireModel();
  const result = checked(model, path);
  const theme = getTheme(strFlag('theme') ?? model.meta.theme);

  const layers: ViewerLayer[] = [];
  for (const layer of layersFor(model)) {
    const graph = deriveLayer(model, layer);
    const placed = await layoutGraph(graph, { frozen: frozenLayers(model)?.[layer] });
    layers.push({ graph, placed, svg: renderSvg(graph, placed, theme, { interactive: true, titleBlock: false }) });
  }

  // The isometric view is another way of reading L1, so it reuses L1's graph
  // and inspector data and only swaps the drawing.
  if (flags['no-iso'] !== true) {
    const l1 = layers.find((l) => l.graph.layer === 'l1');
    if (l1) {
      layers.push({
        graph: { ...l1.graph, layer: 'iso' as LayerId, subtitle: 'Isometric physical view' },
        placed: l1.placed,
        svg: renderIsometric(l1.graph, l1.placed, theme, { interactive: true, titleBlock: false }),
      });
    }
  }

  const html = renderViewer({
    model,
    layers,
    theme,
    themes: THEMES,
    enable3d: flags['no-3d'] !== true,
    warnings: result.warnings,
  });

  const out = strFlag('out') ?? `out/${stem(path)}.html`;
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
    if (!(allowed as string[]).includes(t)) {
      throw new Error(
        (ALL_LAYERS as string[]).includes(t)
          ? `${path} declares no dependencies, so there is no ${t.toUpperCase()} layout to freeze`
          : `--layer must be one of ${allowed.join(', ')}, or all`,
      );
    }
  }

  const written = await freezeLayout(path, model, targets as LayerId[], { reset: flags.reset === true });
  console.log(
    flags.reset
      ? `${path}: cleared frozen layout for ${targets.join(', ')} — layout is automatic again`
      : `${path}: froze ${written} node position(s) for ${targets.join(', ')}. Edit layout: to place nodes by hand.`,
  );
}

/* ---- Workspace -------------------------------------------------------- */

/**
 * Render every design in a workspace to a self-contained HTML file, plus an
 * index.html that lists them. Cross-design links (a device/external in one
 * design that points at another design) become <a href> jumps between the
 * emitted files — the same portfolio the Studio edits, exported for offline.
 */
async function cmdWorkspace() {
  const dir = positional[0];
  if (!dir) throw new Error(`Missing <dir>.\n${USAGE}`);
  const ws = loadWorkspace(dir);

  const outDir = strFlag('out') ?? 'out';
  const themeFlag = strFlag('theme');
  const theme = themeFlag ? getTheme(themeFlag) : null;

  // A device/external id -> the design it links to, so we can turn linked
  // nodes into hrefs. Keyed "designId::nodeId".
  const linkTargets = new Map();
  for (const link of ws.links) {
    const [fromDesign, fromNode] = String(link.from).split(':');
    if (fromNode) linkTargets.set(`${fromDesign}::${fromNode}`, `${link.to}.html`);
  }

  const written = [];
  for (const design of ws.designs) {
    const { id, model, diagnostics } = design;
    if (!diagnostics.ok) {
      console.error(
        `netlas: ${design.file} has ${diagnostics.errors.length} error(s)\n${formatDiagnostics(diagnostics)}`,
      );
      process.exit(1);
    }
    const t = theme ?? getTheme(model.meta.theme);
    const layers: ViewerLayer[] = [];
    for (const layer of layersFor(model)) {
      const graph = deriveLayer(model, layer);
      const placed = await layoutGraph(graph, { frozen: frozenLayers(model)?.[layer] });
      layers.push({ graph, placed, svg: renderSvg(graph, placed, t, { interactive: true, titleBlock: false }) });
    }
    if (flags['no-iso'] !== true) {
      const l1 = layers.find((l) => l.graph.layer === 'l1');
      if (l1) {
        layers.push({
          graph: { ...l1.graph, layer: 'iso' as LayerId, subtitle: 'Isometric physical view' },
          placed: l1.placed,
          svg: renderIsometric(l1.graph, l1.placed, t, { interactive: true, titleBlock: false }),
        });
      }
    }

    const html = renderViewer({
      model, layers, theme: t, themes: THEMES,
      enable3d: flags['no-3d'] !== true,
      warnings: diagnostics.warnings,
      links: [...linkTargets].filter(([k]) => k.startsWith(`${id}::`)).map(([k, href]) => ({ node: k.split('::')[1], href })),
    });
    const out = `${outDir}/${id}.html`;
    write(out, html);
    written.push({ id, title: design.title ?? model.meta.title, out });
  }

  write(`${outDir}/index.html`, workspaceIndex(ws, written));
  console.log(`wrote ${written.length + 1} file(s) to ${outDir}/  (${ws.name}: ${written.map((w) => w.id).join(', ')})`);
}

/** A minimal, dependency-free index page linking to each rendered design. */
function workspaceIndex(ws: { name: string }, written: Array<{ id: string; title?: string; out: string }>): string {
  const esc = (s: unknown): string =>
    String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  const items = written
    .map((w) => `    <li><a href="${esc(w.id)}.html">${esc(w.title ?? w.id)}</a></li>`)
    .join('\n');
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="netlas">
<title>${esc(ws.name)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}li{margin:.3rem 0}</style>
<h1>${esc(ws.name)}</h1>
<ul>
${items}
</ul>
`;
}

function cmdThemes() {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    console.log(`${id.padEnd(10)} ${t.mode.padEnd(6)} ${t.description}`);
  }
}

function stem(p: string): string {
  return basename(p).replace(/\.netlas\.ya?ml$/i, '').replace(/\.ya?ml$/i, '');
}

function write(out: string, content: string): void {
  const abs = resolve(out);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
