import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { themeToCss } from '../theme/themes.mjs';
import { esc } from '../render2d/svg.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const CSS = readFileSync(here('./viewer.css'), 'utf8');
const JS = readFileSync(here('./viewer.js'), 'utf8');
const THREE_BUNDLE = here('../render3d/scene.bundle.js');

/**
 * Assemble one self-contained HTML file.
 *
 * Everything is inlined: no CDN, no fonts fetched at runtime, no network at
 * all. The file survives being emailed, dropped in a wiki attachment, or
 * opened from a USB stick in a plant room with no internet — which is where
 * network documentation actually gets read.
 */
export function renderViewer({ model, layers, theme, enable3d = true, warnings = [] }) {
  const slug = (model.meta.title ?? 'network').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const has3d = enable3d && existsSync(THREE_BUNDLE);
  const threeSrc = has3d ? readFileSync(THREE_BUNDLE, 'utf8') : '';

  const payloadLayers = layers.map(({ graph, placed }) => ({
    id: graph.layer,
    label: graph.layer.toUpperCase(),
    subtitle: graph.subtitle,
    legend: graph.legend.map((l) => ({
      ...l,
      color: theme.media[l.kind] ?? theme.role[l.kind] ?? theme.textMuted,
    })),
    nodes: graph.nodes.map((n) => {
      const b = placed.nodes.get(n.id) ?? { x: 0, y: 0, w: 0, h: 0 };
      return {
        id: n.id,
        label: n.label,
        sublabel: n.sublabel,
        kind: n.kind,
        detail: n.detail,
        color: theme.role[n.role] ?? theme.textMuted,
        x: b.x, y: b.y, w: b.w, h: b.h,
      };
    }),
    edges: graph.edges.map((e) => ({
      id: e.id, a: e.a, b: e.b,
      color: theme.media[e.media] ?? theme.stroke,
      points: (placed.edges.get(e.id)?.points ?? []).map((p) => ({ x: p.x, y: p.y })),
    })),
  }));

  const payload = {
    slug,
    meta: model.meta,
    theme: {
      bg: theme.bg, surface: theme.surface, surfaceRaised: theme.surfaceRaised,
      strokeStrong: theme.strokeStrong, textMuted: theme.textMuted,
      fontBody: theme.fontBody, mode: theme.mode,
    },
    layers: payloadLayers,
  };

  const tabs = layers
    .map(({ graph }) => {
      const n = graph.nodes.length;
      return (
        `<button class="nd-tab" role="tab" data-layer="${graph.layer}" aria-selected="false">` +
        `<strong>${graph.layer === 'iso' ? 'ISO' : graph.layer.toUpperCase()}</strong>` +
        `<span>${layerWord(graph.layer)}</span>` +
        `<em>${n}</em></button>`
      );
    })
    .join('');

  const tab3d = has3d
    ? `<button class="nd-tab" role="tab" data-layer="3d" aria-selected="false">` +
      `<strong>3D</strong><span>Stack</span><em>${layers.filter((l) => l.graph.layer !== 'iso').length}</em></button>`
    : '';

  const views =
    layers
      .map(({ graph, svg }) =>
        `<div class="nd-view" data-layer="${graph.layer}" hidden><div class="nd-pan">${svg}</div></div>`,
      )
      .join('') +
    (has3d
      ? `<div class="nd-view" data-layer="3d" hidden><canvas id="nd-canvas3d"></canvas>` +
        `<div id="nd-3d-note" class="micro" style="position:absolute;left:16px;top:14px"></div></div>`
      : '');

  const cells = [
    ['Owner', model.meta.owner],
    ['Revision', model.meta.version],
    ['Date', model.meta.updated],
    ['Devices', String(model.devices.length)],
    ['VLANs', String(model.vlans.length)],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="nd-cell"><div class="micro">${esc(k)}</div><b>${esc(v)}</b></div>`)
    .join('');

  const warnNote = warnings.length
    ? `<span class="nd-note" title="${esc(warnings.map((w) => w.message).join(' · '))}">${warnings.length} model warning${warnings.length > 1 ? 's' : ''}</span>`
    : '';

  return `<!doctype html>
<html lang="en" data-theme="${esc(theme.id)}" data-mode="${esc(theme.mode)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.meta.title)} — network diagram</title>
<meta name="generator" content="netdia">
<style>
:root {
${themeToCss(theme)}
}
${CSS}
</style>
</head>
<body>

<header class="nd-head">
  <div class="nd-head__title">
    <div class="micro">Network drawing</div>
    <h1>${esc(model.meta.title)}</h1>
    ${model.meta.subtitle ? `<p>${esc(model.meta.subtitle)}</p>` : ''}
  </div>
  <div class="nd-cells">${cells}</div>
  <div class="nd-head__actions">
    <input id="nd-search" class="nd-search" type="search" placeholder="Search host, IP, VLAN, port" aria-label="Search the diagram">
    <button id="nd-svg" class="nd-btn" type="button">SVG</button>
    <button id="nd-png" class="nd-btn" type="button">PNG</button>
    <button id="nd-print" class="nd-btn" type="button">PDF</button>
  </div>
</header>

<div class="nd-body" id="nd-body" data-inspector="closed">
  <nav class="nd-rail" id="nd-rail" role="tablist" aria-label="Diagram layers">${tabs}${tab3d}</nav>
  <main class="nd-stage" id="nd-stage" data-focus="off">${views}</main>
  <aside class="nd-inspector" id="nd-inspector" aria-live="polite"></aside>
</div>

<footer class="nd-foot">
  <div class="nd-legend" id="nd-legend"></div>
  <div class="nd-foot__right">
    ${warnNote}
    <button id="nd-fit" class="nd-btn" type="button">Fit</button>
    <span class="nd-zoom" id="nd-zoom">100%</span>
  </div>
</footer>

<script type="application/json" id="nd-payload">${jsonForHtml(payload)}</script>
${has3d ? `<script type="text/plain" id="nd-3d-src">${escapeScript(threeSrc)}</script>` : ''}
<script>window.NETDIA = JSON.parse(document.getElementById('nd-payload').textContent);</script>
<script>${JS}</script>
</body>
</html>`;
}

function layerWord(layer) {
  return { l1: 'Physical', l2: 'VLANs', l3: 'Routing', iso: 'Isometric' }[layer] ?? layer;
}

/** Safe to embed inside <script type="application/json">. */
function jsonForHtml(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Safe to embed inside a non-executing <script type="text/plain">. */
function escapeScript(src) {
  return src.replace(/<\/script/gi, '<\\/script');
}
