import { icon, VENDOR_MARK } from './icons.mjs';
import { dashFor, weightFor, DATA_FONT, detailFlags } from '../theme/themes.mjs';
import { groupHulls } from '../layout/index.mjs';

/**
 * SVG renderer.
 *
 * The visual thesis: a network diagram is an engineering drawing. So the
 * page carries a title block, the background carries a drafting grid, and
 * link colour follows the patch-cable code rather than an arbitrary ramp.
 *
 * The signature element is the port strip along the bottom edge of every
 * device: one lit segment per cabled interface, coloured by media. It is
 * lifted straight from a switch faceplate, and it encodes real data — port
 * count and media mix — so it earns its place instead of decorating.
 */

const CORNER = 9;

export function renderSvg(graph, placed, theme, opts = {}) {
  const {
    titleBlock = true,
    legend = true,
    padding = 40,
    interactive = false,
    detail = 'full',
  } = opts;
  const show = detailFlags(detail);

  const groups = groupHulls(graph, placed);
  const blockH = titleBlock ? 96 : 0;
  const legendH = legend ? 44 : 0;

  // Chips are placed and separated before the canvas is measured. A port
  // label that has been nudged apart from its neighbour still has to fit on
  // the page, so label resolution has to happen first, not after.
  const chips = [];
  for (const e of graph.edges) {
    const route = placed.edges.get(e.id);
    if (route && route.points.length >= 2) collectChips(chips, e, route.points, theme, show);
  }
  resolveChips(chips);

  // Content bounds include zone hulls and resolved labels, both of which
  // extend past the node boxes ELK measured.
  const bounds = contentBounds(graph, placed, groups, chips);
  const ox = -Math.min(0, bounds.x);
  const oy = -Math.min(0, bounds.y);

  const contentW = Math.max(bounds.x + bounds.w + ox, 720);
  const contentH = bounds.y + bounds.h + oy;
  const w = Math.round(contentW + padding * 2);
  const h = Math.round(contentH + padding * 2 + blockH + legendH);

  const parts = [];
  parts.push(background(w, h, theme));

  parts.push(`<g class="nd-content" transform="translate(${r(padding + ox)} ${r(padding + oy)})">`);

  if (groups.usable) {
    for (const g of groups.hulls) parts.push(zoneHull(g, theme));
  }

  for (const e of graph.edges) {
    const route = placed.edges.get(e.id);
    if (route && route.points.length >= 2) parts.push(edge(e, route.points, theme, interactive, show));
  }

  for (const c of chips) parts.push(drawChip(c));

  for (const n of graph.nodes) {
    const box = placed.nodes.get(n.id);
    if (!box) continue;
    parts.push(
      n.kind === 'device'
        ? deviceCard(n, box, graph, theme, { zoneBadge: !groups.usable, interactive, show })
        : n.kind === 'external'
          ? externalCard(n, box, theme, interactive, show)
          : dataCard(n, box, theme, interactive),
    );
  }

  parts.push('</g>');

  let y = padding + contentH + 20;
  if (legend) {
    parts.push(legendRow(graph, theme, padding, y));
    y += legendH;
  }
  if (titleBlock) {
    parts.push(titleBlockEl(graph, theme, padding, y, contentW, placed));
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="${esc(theme.fontBody)}" role="img" aria-label="${esc(graph.title)} ${graph.layer.toUpperCase()}">` +
    defs(theme) +
    parts.join('') +
    '</svg>'
  );
}

/* ---- chrome ---------------------------------------------------------- */

export function defs(theme) {
  const arrow = (id, color) =>
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M0 1 L9 5 L0 9 z" fill="${color}"/></marker>`;
  const markers = Object.entries(theme.media)
    .map(([k, v]) => arrow(`nd-arrow-${k}`, v))
    .join('');
  const glow = theme.glow
    ? `<filter id="nd-glow" x="-40%" y="-40%" width="180%" height="180%">` +
      `<feGaussianBlur stdDeviation="3" result="b"/>` +
      `<feComponentTransfer in="b" result="f"><feFuncA type="linear" slope="${theme.glow}"/></feComponentTransfer>` +
      `<feMerge><feMergeNode in="f"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    : '';
  const grid =
    theme.gridStyle === 'dot'
      ? `<pattern id="nd-grid" width="26" height="26" patternUnits="userSpaceOnUse">` +
        `<circle cx="1" cy="1" r="1" fill="${theme.grid}"/></pattern>`
      : theme.gridStyle === 'line'
        ? `<pattern id="nd-grid" width="32" height="32" patternUnits="userSpaceOnUse">` +
          `<path d="M32 0H0V32" fill="none" stroke="${theme.grid}" stroke-width="0.6"/></pattern>`
        : '';
  return `<defs>${markers}${glow}${grid}</defs>`;
}

export function background(w, h, theme) {
  const grid = theme.gridStyle === 'none' ? '' : `<rect width="${w}" height="${h}" fill="url(#nd-grid)"/>`;
  return `<rect width="${w}" height="${h}" fill="${theme.bg}"/>${grid}`;
}

function zoneHull(g, theme) {
  const z = theme.zone[g.kind] ?? theme.zone.internal;
  const labelW = g.label.length * 7.2 + 26;
  return (
    `<g class="nd-zone" data-zone="${esc(g.id)}">` +
    `<rect x="${r(g.x)}" y="${r(g.y)}" width="${r(g.w)}" height="${r(g.h)}" rx="${theme.radius + 6}" ` +
    `fill="${z.fill}" fill-opacity="0.55" stroke="${z.stroke}" stroke-width="1" stroke-dasharray="6 5"/>` +
    `<rect x="${r(g.x + 12)}" y="${r(g.y - 11)}" width="${r(labelW)}" height="22" rx="11" ` +
    `fill="${theme.bg}" stroke="${z.stroke}" stroke-width="1"/>` +
    `<text x="${r(g.x + 12 + labelW / 2)}" y="${r(g.y + 4)}" text-anchor="middle" ` +
    `font-size="10.5" font-weight="600" letter-spacing="0.09em" fill="${z.text}">${esc(g.label.toUpperCase())}</text>` +
    `</g>`
  );
}

/* ---- edges ----------------------------------------------------------- */

function edge(e, pts, theme, interactive, show = detailFlags('full')) {
  const color = theme.media[e.media] ?? theme.stroke;
  const dash = dashFor(e.media, theme);
  const width = weightFor(e.media, theme);
  const d = roundedPath(pts, CORNER);
  const marker = e.directed ? ` marker-end="url(#nd-arrow-${e.media})"` : '';
  const glow = show.glow && theme.glow && (e.media === 'fiber' || e.media === 'wan');
  const filter = glow ? ' filter="url(#nd-glow)"' : '';
  const hit = interactive
    ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="14" class="nd-edge-hit"/>`
    : '';

  const lag =
    e.style === 'lag'
      ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${r(width * 2.9)}" ` +
        `stroke-opacity="0.18" stroke-linecap="round" stroke-linejoin="round"/>`
      : '';

  return (
    `<g class="nd-edge" data-edge="${esc(e.id)}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" data-media="${esc(e.media)}"${
      interactive ? ' tabindex="0" role="button"' : ''
    }>` +
    hit +
    lag +
    `<path class="${glow ? 'nd-detail-glow' : ''}" d="${d}" fill="none" stroke="${color}" ` +
    `stroke-width="${r(width)}" stroke-linecap="round" stroke-linejoin="round"` +
    `${dash ? ` stroke-dasharray="${dash}"` : ''}${marker}${filter}/>` +
    `</g>`
  );
}

function edgeLabels(e, pts, theme) {
  const out = [];
  const chips = [];
  collectChips(chips, e, pts, theme);
  for (const c of chips) out.push(drawChip(c));
  return out;
}

/* ---- label placement -------------------------------------------------- */

function collectChips(out, e, pts, theme, show = { chip: true }) {
  if (e.showPorts !== false && show.chip) {
    if (e.aPort) out.push(portChip(e.aPort, pts[0], pts[1], theme, e.media));
    if (e.bPort) out.push(portChip(e.bPort, pts[pts.length - 1], pts[pts.length - 2], theme, e.media));
  }
  if (e.label) {
    const mid = midpointOf(pts);
    const spec = chipSpec(e.label, mid.x, mid.y, theme, {
      fill: theme.bg,
      stroke: theme.strokeSoft,
      text: theme.textMuted,
      size: 10,
      mono: false,
      axis: Math.abs(mid.dy) >= Math.abs(mid.dx) ? 'y' : 'x',
    });
    offsetOffCable(spec, mid.dx, mid.dy);
    out.push(spec);
  }
}

/**
 * Move a label clear of the cable it annotates.
 *
 * A chip drawn on top of its own line breaks the line into stubs, and on a
 * short run between two switches that reads as a missing link. Sitting the
 * label beside the cable keeps the cable continuous, which is the one thing
 * an L1 drawing has to get right.
 */
function offsetOffCable(spec, dx, dy) {
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular, rotated so vertical cables label to the right and
  // horizontal cables label above.
  const px = dy / len;
  const py = -dx / len;
  const gap = (Math.abs(px) > Math.abs(py) ? spec.w : spec.h) / 2 + 5;
  spec.cx += px * gap;
  spec.cy += py * gap;
}

/**
 * Push overlapping chips apart along the axis perpendicular to their own
 * cable, so a label never drifts away from the line it belongs to.
 */
function resolveChips(chips, iterations = 28) {
  for (let pass = 0; pass < iterations; pass++) {
    let moved = false;
    for (let i = 0; i < chips.length; i++) {
      for (let j = i + 1; j < chips.length; j++) {
        const a = chips[i];
        const b = chips[j];
        const ox = (a.w + b.w) / 2 + 3 - Math.abs(a.cx - b.cx);
        const oy = (a.h + b.h) / 2 + 2 - Math.abs(a.cy - b.cy);
        if (ox <= 0 || oy <= 0) continue;

        moved = true;
        // Separate along each chip's own free axis: vertical cables carry
        // their labels side by side, horizontal cables stack them.
        const push = 0.55;
        if (a.axis === 'y' && b.axis === 'y') {
          const dir = a.cx <= b.cx ? -1 : 1;
          a.cx += dir * ox * push;
          b.cx -= dir * ox * push;
        } else if (a.axis === 'x' && b.axis === 'x') {
          const dir = a.cy <= b.cy ? -1 : 1;
          a.cy += dir * oy * push;
          b.cy -= dir * oy * push;
        } else if (ox < oy) {
          const dir = a.cx <= b.cx ? -1 : 1;
          a.cx += dir * ox * push;
          b.cx -= dir * ox * push;
        } else {
          const dir = a.cy <= b.cy ? -1 : 1;
          a.cy += dir * oy * push;
          b.cy -= dir * oy * push;
        }
      }
    }
    if (!moved) break;
  }
  return chips;
}

function portChip(text, at, toward, theme, media) {
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(26, Math.max(14, len * 0.3));
  const spec = chipSpec(text, at.x + (dx / len) * off, at.y + (dy / len) * off, theme, {
    fill: theme.bgAlt,
    stroke: theme.strokeSoft,
    text: theme.media[media] ?? theme.textMuted,
    size: 9,
    mono: true,
    // A vertical cable leaves its label free to slide horizontally.
    axis: Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x',
    // Port names are the first thing to go when zoomed out: at a third of
    // full size a 9px label is already illegible.
    detail: true,
  });
  offsetOffCable(spec, dx, dy);
  return spec;
}

function chipSpec(text, cx, cy, theme, { fill, stroke, text: color, size, mono, axis, detail = false }) {
  const t = String(text);
  return {
    text: t,
    cx,
    cy,
    w: t.length * (mono ? size * 0.62 : size * 0.56) + 12,
    h: size + 8,
    fill,
    stroke,
    color,
    size,
    mono,
    axis,
    detail,
  };
}

function drawChip(c) {
  return (
    `<g class="nd-chip${c.detail ? ' nd-detail-chip' : ''}" pointer-events="none">` +
    `<rect x="${r(c.cx - c.w / 2)}" y="${r(c.cy - c.h / 2)}" width="${r(c.w)}" height="${r(c.h)}" rx="${r(c.h / 2)}" ` +
    `fill="${c.fill}" fill-opacity="0.94" stroke="${c.stroke}" stroke-width="0.8"/>` +
    `<text x="${r(c.cx)}" y="${r(c.cy + c.size * 0.36)}" text-anchor="middle" font-size="${c.size}" ` +
    `fill="${c.color}"${c.mono ? ` font-family="${esc(DATA_FONT)}"` : ''}>${esc(c.text)}</text>` +
    `</g>`
  );
}

function contentBounds(graph, placed, groups, chips) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x, y, w, h) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  };
  for (const b of placed.nodes.values()) add(b.x, b.y, b.w, b.h);
  if (groups.usable) for (const g of groups.hulls) add(g.x, g.y - 12, g.w, g.h + 12);
  for (const route of placed.edges.values()) {
    for (const p of route.points) add(p.x, p.y, 0, 0);
  }
  for (const c of chips) add(c.cx - c.w / 2, c.cy - c.h / 2, c.w, c.h);
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: placed.width, h: placed.height };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ---- nodes ----------------------------------------------------------- */

function deviceCard(n, box, graph, theme, { zoneBadge, interactive, show = detailFlags('full') }) {
  const color = theme.role[n.role] ?? theme.textMuted;
  const { x, y, w, h } = box;
  const up = theme.uppercase;
  const vendor = VENDOR_MARK[n.vendor] ?? '';

  const ports = show.chassis ? portStrip(n, graph, box, theme) : '';
  const zone = zoneBadge && n.detail.zone ? n.detail.zone : null;

  const sub = [n.sublabel, zone ? `· ${zone}` : ''].filter(Boolean).join(' ');

  return (
    `<g class="nd-node" data-node="${esc(n.id)}" data-role="${esc(n.role)}"${
      interactive ? ' tabindex="0"' : ''
    }>` +
    `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${theme.radius}" ` +
    `fill="${theme.surface}" stroke="${theme.stroke}" stroke-width="${theme.strokeWidth}"/>` +
    // accent rail: role identity, read before any text
    `<path d="M${r(x)} ${r(y + theme.radius)} a${theme.radius} ${theme.radius} 0 0 1 ${theme.radius} -${theme.radius} ` +
    `L${r(x + theme.radius)} ${r(y + h)} a${theme.radius} ${theme.radius} 0 0 1 -${theme.radius} -${theme.radius} z" ` +
    `fill="${color}"/>` +
    `<rect x="${r(x + 3)}" y="${r(y)}" width="3" height="${r(h)}" fill="${color}" fill-opacity="0.35"/>` +
    icon(n.role, x + 16, y + h / 2 - 11, 22, color, theme.strokeWidth) +
    `<text x="${r(x + 46)}" y="${r(y + 28)}" font-size="13.5" font-weight="650" ` +
    `font-family="${esc(theme.fontDisplay)}" letter-spacing="${up ? '0.06em' : '0.01em'}" ` +
    `fill="${theme.text}">${esc(up ? n.label.toUpperCase() : n.label)}</text>` +
    (sub && show.sub
      ? `<text class="nd-detail-sub" x="${r(x + 46)}" y="${r(y + 44)}" font-size="10.5" ` +
        `fill="${theme.textMuted}">${esc(sub)}</text>`
      : '') +
    (vendor && show.vendor
      ? `<text class="nd-detail-vendor" x="${r(x + w - 10)}" y="${r(y + 15)}" text-anchor="end" font-size="8" ` +
        `font-weight="600" letter-spacing="0.12em" fill="${theme.textFaint}">${esc(vendor)}</text>`
      : '') +
    (n.detail.mgmt_ip && show.sub
      ? `<text class="nd-detail-sub" x="${r(x + w - 10)}" y="${r(y + h - 9)}" text-anchor="end" font-size="9" ` +
        `font-family="${esc(DATA_FONT)}" fill="${theme.textFaint}">${esc(n.detail.mgmt_ip)}</text>`
      : '') +
    ports +
    `</g>`
  );
}

/**
 * The signature: a faceplate port strip. One segment per cabled interface,
 * coloured by the media on that cable. Reading it tells you how many ports
 * are in use and whether they are copper, fiber or virtual.
 */
/**
 * The cabled ports of a device, in graph order, with the media of the cable
 * on each one.
 *
 * Shared with the isometric renderer, where the same list becomes the ports
 * on the front of the chassis. Both views have to read the faceplate from one
 * place or they will drift apart the first time either is touched.
 */
export function usedPorts(node, graph) {
  return graph.edges
    .filter((e) => e.a === node.id || e.b === node.id)
    .map((e) => ({ port: e.a === node.id ? e.aPort : e.bPort, media: e.media }))
    .filter((p) => p.port);
}

function portStrip(n, graph, box, theme) {
  const used = usedPorts(n, graph);
  if (used.length === 0) return '';

  const segW = 9;
  const gap = 3;
  const padX = 5;
  const padY = 3;
  const available = box.w - 46 - 14;
  const max = Math.max(1, Math.floor((available - padX * 2 + gap) / (segW + gap)) - 1);
  const shown = used.slice(0, max);

  const inner = shown.length * segW + (shown.length - 1) * gap;
  const housingW = inner + padX * 2;
  const housingH = 4 + padY * 2;
  const hx = box.x + 46;
  const hy = box.y + box.h - housingH - 6;

  const segs = shown
    .map((p, i) => {
      const c = theme.media[p.media] ?? theme.textFaint;
      return (
        `<rect x="${r(hx + padX + i * (segW + gap))}" y="${r(hy + padY)}" width="${segW}" height="4" rx="1" ` +
        `fill="${c}"><title>${esc(p.port)} · ${esc(p.media)}</title></rect>`
      );
    })
    .join('');

  const more =
    used.length > shown.length
      ? `<text x="${r(hx + housingW + 5)}" y="${r(hy + housingH - 1)}" font-size="8" ` +
        `font-family="${esc(DATA_FONT)}" fill="${theme.textFaint}">+${used.length - shown.length}</text>`
      : '';

  return (
    `<g class="nd-ports nd-detail-chassis" pointer-events="none">` +
    `<rect x="${r(hx)}" y="${r(hy)}" width="${r(housingW)}" height="${r(housingH)}" rx="2" ` +
    `fill="${theme.bgAlt}" stroke="${theme.strokeSoft}" stroke-width="0.7"/>` +
    segs +
    more +
    `</g>`
  );
}

/**
 * A system outside this diagram. Drawn as a card so it reads as a thing that
 * runs somewhere, but with a dashed edge, because nothing here documents its
 * insides — the boundary of the drawing is a fact worth showing.
 */
function externalCard(n, box, theme, interactive, show) {
  const color = theme.role.external ?? theme.textMuted;
  const up = theme.uppercase;
  const { x, y, w, h } = box;
  const textX = x + (show.chassis ? 42 : 12);
  return (
    `<g class="nd-node" data-node="${esc(n.id)}" data-role="external"${
      interactive ? ' tabindex="0"' : ''
    }>` +
    `<rect x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${theme.radius}" ` +
    `fill="${theme.surfaceAlt}" stroke="${color}" stroke-width="${theme.strokeWidth}" ` +
    `stroke-dasharray="6 4" stroke-opacity="0.9"/>` +
    (show.chassis ? icon('external', x + 12, y + h / 2 - 11, 22, color, theme.strokeWidth) : '') +
    `<text x="${r(textX)}" y="${r(y + h / 2 - 2)}" font-size="12.5" font-weight="650" ` +
    `font-family="${esc(theme.fontDisplay)}" letter-spacing="${up ? '0.06em' : '0.01em'}" ` +
    `fill="${theme.text}">${esc(up ? n.label.toUpperCase() : n.label)}</text>` +
    (n.sublabel && show.sub
      ? `<text class="nd-detail-sub" x="${r(textX)}" y="${r(y + h / 2 + 13)}" font-size="9.5" ` +
        `letter-spacing="0.06em" fill="${theme.textMuted}">${esc(n.sublabel.toUpperCase())}</text>`
      : '') +
    (show.vendor
      ? `<text class="nd-detail-vendor" x="${r(x + w - 10)}" y="${r(y + 14)}" text-anchor="end" font-size="7.5" ` +
        `letter-spacing="0.12em" fill="${theme.textFaint}">EXTERNAL</text>`
      : '') +
    `</g>`
  );
}

/** VLAN and network nodes: data, not hardware. Drawn as a tag, not a card. */
function dataCard(n, box, theme, interactive) {
  const color = theme.role[n.role] ?? theme.role.network;
  const { x, y, w, h } = box;
  const notch = 10;
  const d =
    `M${r(x + notch)} ${r(y)} H${r(x + w - 4)} a4 4 0 0 1 4 4 V${r(y + h - 4)} a4 4 0 0 1 -4 4 ` +
    `H${r(x + notch)} L${r(x)} ${r(y + h / 2)} Z`;

  return (
    `<g class="nd-node" data-node="${esc(n.id)}" data-role="${esc(n.role)}"${
      interactive ? ' tabindex="0"' : ''
    }>` +
    `<path d="${d}" fill="${theme.surfaceAlt}" stroke="${color}" stroke-width="${theme.strokeWidth}" stroke-opacity="0.75"/>` +
    `<circle cx="${r(x + notch + 8)}" cy="${r(y + h / 2)}" r="3" fill="${color}"/>` +
    `<text x="${r(x + notch + 20)}" y="${r(y + h / 2 - 3)}" font-size="12.5" font-weight="650" ` +
    `font-family="${esc(DATA_FONT)}" fill="${theme.text}">${esc(n.label)}</text>` +
    (n.sublabel
      ? `<text x="${r(x + notch + 20)}" y="${r(y + h / 2 + 12)}" font-size="9.5" letter-spacing="0.06em" ` +
        `fill="${theme.textMuted}">${esc(n.sublabel.toUpperCase())}</text>`
      : '') +
    (n.badges.length
      ? `<text x="${r(x + w - 10)}" y="${r(y + h - 8)}" text-anchor="end" font-size="9" ` +
        `font-family="${esc(DATA_FONT)}" fill="${theme.textFaint}">${esc(n.badges.join(' '))}</text>`
      : '') +
    `</g>`
  );
}

/* ---- legend and title block ------------------------------------------ */

export function legendRow(graph, theme, x, y) {
  let cx = x;
  const items = graph.legend.map((l) => {
    const color = theme.media[l.kind] ?? theme.role[l.kind] ?? theme.textMuted;
    const dash = dashFor(l.kind, theme);
    const width = weightFor(l.kind, theme);
    const s =
      `<g><path d="M${r(cx)} ${r(y + 12)} h26" stroke="${color}" stroke-width="${r(width)}" ` +
      `stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
      `<text x="${r(cx + 33)}" y="${r(y + 16)}" font-size="10.5" fill="${theme.textMuted}">${esc(l.label)}</text></g>`;
    cx += 33 + l.label.length * 6.1 + 26;
    return s;
  });
  return `<g class="nd-legend">${items.join('')}</g>`;
}

export function titleBlockEl(graph, theme, x, y, w, placed) {
  const meta = graph.meta ?? {};
  const cells = [
    ['LAYER', graph.layer.toUpperCase()],
    ['DRAWING', graph.subtitle.replace(/^Layer \d+ — /, '')],
    ['REVISION', meta.version ?? '—'],
    ['DATE', meta.updated ?? '—'],
    ['LAYOUT', placed.source === 'frozen' ? 'MANUAL' : 'AUTO'],
  ];
  const h = 72;
  const colW = Math.min(150, (w - 300) / cells.length);

  let cx = x + 300;
  const cellSvg = cells
    .map(([k, v]) => {
      const s =
        `<g><text x="${r(cx)}" y="${r(y + 28)}" font-size="8.5" letter-spacing="0.14em" ` +
        `fill="${theme.textFaint}">${esc(k)}</text>` +
        `<text x="${r(cx)}" y="${r(y + 48)}" font-size="11.5" font-family="${esc(DATA_FONT)}" ` +
        `fill="${theme.textMuted}">${esc(truncate(v, 18))}</text>` +
        `<path d="M${r(cx - 16)} ${r(y + 14)} V${r(y + h - 14)}" stroke="${theme.strokeSoft}" stroke-width="1"/></g>`;
      cx += colW;
      return s;
    })
    .join('');

  return (
    `<g class="nd-titleblock">` +
    `<path d="M${r(x)} ${r(y)} H${r(x + w)}" stroke="${theme.strokeSoft}" stroke-width="1"/>` +
    `<text x="${r(x)}" y="${r(y + 30)}" font-size="17" font-weight="700" ` +
    `font-family="${esc(theme.fontDisplay)}" fill="${theme.text}">${esc(graph.title)}</text>` +
    (meta.owner
      ? `<text x="${r(x)}" y="${r(y + 50)}" font-size="10.5" fill="${theme.textMuted}">${esc(meta.owner)}</text>`
      : '') +
    cellSvg +
    `</g>`
  );
}

/* ---- geometry -------------------------------------------------------- */

export function roundedPath(pts, radius) {
  if (pts.length === 2) return `M${r(pts[0].x)} ${r(pts[0].y)} L${r(pts[1].x)} ${r(pts[1].y)}`;
  let d = `M${r(pts[0].x)} ${r(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const r1 = Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2);
    const p1 = along(cur, prev, r1);
    const p2 = along(cur, next, r1);
    d += ` L${r(p1.x)} ${r(p1.y)} Q${r(cur.x)} ${r(cur.y)} ${r(p2.x)} ${r(p2.y)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${r(last.x)} ${r(last.y)}`;
  return d;
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
function along(from, to, d) {
  const len = dist(from, to) || 1;
  return { x: from.x + ((to.x - from.x) / len) * d, y: from.y + ((to.y - from.y) / len) * d };
}
function midpointOf(pts) {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
  let half = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i - 1], pts[i]);
    if (half <= seg) {
      const p = along(pts[i - 1], pts[i], half);
      return { ...p, dx: pts[i].x - pts[i - 1].x, dy: pts[i].y - pts[i - 1].y };
    }
    half -= seg;
  }
  const i = Math.floor(pts.length / 2);
  return { ...pts[i], dx: 1, dy: 0 };
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
export function r(n) {
  return Math.round(n * 100) / 100;
}
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
