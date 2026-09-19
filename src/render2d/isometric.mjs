import { icon, VENDOR_MARK } from './icons.mjs';
import { dashFor, weightFor, DATA_FONT } from '../theme/themes.mjs';
import { defs, background, legendRow, titleBlockEl, esc, r } from './svg.mjs';
import { orthoRoute } from '../layout/index.mjs';

/**
 * Isometric L1.
 *
 * The flat L1 drawing answers "what is cabled to what". This one answers
 * "what does the room look like": devices become slabs standing on their
 * security zone's floor plate, and cables run through the space between
 * them.
 *
 * Placement is its own compact grid rather than a reprojection of the flat
 * layout. Projecting the flat layout directly is the obvious approach and it
 * looks wrong: the diagonal projection stretches a tiered drawing across a
 * bounding box that is mostly empty. The grid keeps the two facts that carry
 * meaning — which tier a device sits in, and its left-to-right order within
 * that tier — and drops only the pixel spacing, which carried none.
 *
 * Everything is ordinary SVG, so it prints and exports like any other layer.
 */

// True isometric: 30 degrees above the horizon.
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

const SLAB = 26; // device height in layout units
const CELL_W = 210; // grid pitch across a tier
const CELL_D = 132; // grid pitch between tiers
const FOOT_W = 150; // device footprint
const FOOT_D = 62;
const SCALE = 1;

function project(x, y, z = 0) {
  return {
    x: (x - y) * COS30 * SCALE,
    y: ((x + y) * SIN30 - z) * SCALE,
  };
}

/**
 * Compact grid placement: one row per tier, ordered within the row by the
 * flat layout's left-to-right order so the two views tell the same story.
 */
function isometricLayout(graph, placed) {
  const rows = new Map();
  for (const n of graph.nodes) {
    const box = placed.nodes.get(n.id);
    if (!box) continue;
    const key = Math.round(box.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ node: n, box });
  }

  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  const widest = Math.max(...ordered.map(([, r_]) => r_.length), 1);

  const nodes = new Map();
  ordered.forEach(([, members], row) => {
    members.sort((a, b) => a.box.x - b.box.x);
    // Centre each row so the arrangement reads as a floor plan, not a ragged list.
    const offset = ((widest - members.length) * CELL_W) / 2;
    members.forEach(({ node }, col) => {
      const isData = node.kind !== 'device';
      const w = isData ? FOOT_W * 0.78 : FOOT_W;
      const d = isData ? FOOT_D * 0.8 : FOOT_D;
      nodes.set(node.id, {
        x: offset + col * CELL_W + (FOOT_W - w) / 2,
        y: row * CELL_D,
        w,
        h: d,
      });
    });
  });

  const edges = new Map();
  for (const e of graph.edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (a && b) edges.set(e.id, { points: orthoRoute(a, b) });
  }

  return { nodes, edges, source: placed.source };
}

export function renderIsometric(graph, flatPlaced, theme, opts = {}) {
  const { titleBlock = true, legend = true, padding = 44, interactive = false } = opts;
  const placed = isometricLayout(graph, flatPlaced);

  // A display list painted back to front. Depth is distance along the
  // viewing axis, so a slab in front correctly hides the cable behind it.
  const items = [];

  for (const g of zonePlates(graph, placed, theme)) items.push(g);
  const platesDrawn = items.length > 0;
  for (const e of graph.edges) {
    const route = placed.edges.get(e.id);
    if (route && route.points.length >= 2) items.push(...cableSegments(e, route.points, theme));
  }
  for (const n of graph.nodes) {
    const box = placed.nodes.get(n.id);
    if (box) items.push(slab(n, box, theme, interactive, { zoneBadge: !platesDrawn }));
  }

  items.sort((a, b) => a.depth - b.depth);

  const bounds = projectedBounds(placed, items);
  const ox = -bounds.x + padding;
  const oy = -bounds.y + padding;

  const blockH = titleBlock ? 96 : 0;
  const legendH = legend ? 44 : 0;
  const w = Math.round(bounds.w + padding * 2);
  const h = Math.round(bounds.h + padding * 2 + blockH + legendH);

  const parts = [
    background(w, h, theme),
    `<g class="nd-content" transform="translate(${r(ox)} ${r(oy)})">`,
    ...items.map((i) => i.svg),
    '</g>',
  ];

  let y = padding + bounds.h + 20;
  if (legend) {
    parts.push(legendRow(graph, theme, padding, y));
    y += legendH;
  }
  if (titleBlock) {
    parts.push(
      titleBlockEl({ ...graph, subtitle: 'Isometric physical view' }, theme, padding, y, bounds.w, placed),
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `font-family="${esc(theme.fontBody)}" role="img" ` +
    `aria-label="${esc(graph.title)} isometric physical view">` +
    defs(theme) +
    parts.join('') +
    '</svg>'
  );
}

/* ---- zone floor plates ------------------------------------------------ */

/**
 * Zone floor plates, but only when they can be drawn truthfully.
 *
 * Grid rows follow tiers, not zones, so a zone's members are not always
 * contiguous. Two overlapping floor plates claim a device stands in both
 * zones at once, which is worse than drawing no plate at all. When that
 * happens the plates are dropped and each slab carries its zone as text.
 */
function zonePlates(graph, placed, theme) {
  const plates = [];
  graph.groups.forEach((g, i) => {
    const boxes = g.nodes.map((id) => placed.nodes.get(id)).filter(Boolean);
    if (boxes.length === 0) return;
    const pad = 30;
    plates.push({
      group: g,
      index: i,
      x0: Math.min(...boxes.map((b) => b.x)) - pad,
      y0: Math.min(...boxes.map((b) => b.y)) - pad,
      x1: Math.max(...boxes.map((b) => b.x + b.w)) + pad,
      y1: Math.max(...boxes.map((b) => b.y + b.h)) + pad,
    });
  });

  for (let i = 0; i < plates.length; i++) {
    for (let j = i + 1; j < plates.length; j++) {
      if (rectsOverlap(plates[i], plates[j])) return [];
    }
    // A plate that covers a device belonging to another zone is equally false.
    for (const n of graph.nodes) {
      if (plates[i].group.nodes.includes(n.id)) continue;
      const b = placed.nodes.get(n.id);
      if (b && rectsOverlap(plates[i], { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h })) return [];
    }
  }

  return plates.map(({ group: g, index, x0, y0, x1, y1 }) => {
    const corners = [project(x0, y0), project(x1, y0), project(x1, y1), project(x0, y1)];
    const labelW = g.label.length * 7 + 20;
    const edgeMid = { x: (corners[0].x + corners[3].x) / 2, y: (corners[0].y + corners[3].y) / 2 };
    return {
      // Floors are always behind whatever stands on them.
      depth: -1e6 + index,
      bbox: [
        Math.min(Math.min(...corners.map((p) => p.x)), edgeMid.x - 12 - labelW),
        Math.min(...corners.map((p) => p.y)) - 14,
        Math.max(...corners.map((p) => p.x)),
        Math.max(...corners.map((p) => p.y)),
      ],
      svg: drawZonePlate({ ...g, corners }, theme),
    };
  });
}

function rectsOverlap(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function drawZonePlate(z, theme) {
  const t = theme.zone[z.kind] ?? theme.zone.internal;
  // Label the plate along its upper-left edge, where a floor plan puts a
  // room name, rather than at the far apex where it reads as unattached.
  const [north, , , west] = z.corners;
  const mid = { x: (north.x + west.x) / 2, y: (north.y + west.y) / 2 };
  return (
    `<g class="nd-zone" data-zone="${esc(z.id)}">` +
    `<polygon points="${poly(z.corners)}" fill="${t.fill}" fill-opacity="0.5" ` +
    `stroke="${t.stroke}" stroke-width="1" stroke-dasharray="6 5"/>` +
    `<text x="${r(mid.x - 12)}" y="${r(mid.y - 6)}" text-anchor="end" font-size="10.5" ` +
    `font-weight="600" letter-spacing="0.09em" fill="${t.text}">${esc(z.label.toUpperCase())}</text>` +
    `</g>`
  );
}

/* ---- cables ----------------------------------------------------------- */

function cableSegments(e, pts, theme) {
  const color = theme.media[e.media] ?? theme.stroke;
  const dash = dashFor(e.media, theme);
  const width = weightFor(e.media, theme);
  const z = SLAB * 0.55;
  const out = [];

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const pa = project(a.x, a.y, z);
    const pb = project(b.x, b.y, z);
    out.push({
      depth: (a.x + a.y + b.x + b.y) / 2,
      bbox: [Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.max(pa.x, pb.x), Math.max(pa.y, pb.y)],
      svg:
        `<g class="nd-edge" data-edge="${esc(e.id)}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" ` +
        `data-media="${esc(e.media)}">` +
        `<path d="M${r(pa.x)} ${r(pa.y)} L${r(pb.x)} ${r(pb.y)}" fill="none" stroke="${color}" ` +
        `stroke-width="${r(width)}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
        `</g>`,
      projected: true,
    });
  }
  return out;
}

/* ---- device slabs ------------------------------------------------------ */

function slab(n, box, theme, interactive, { zoneBadge = false } = {}) {
  const { x, y, w, h } = box;
  const accent = theme.role[n.role] ?? theme.textMuted;
  const isData = n.kind !== 'device';
  const height = isData ? SLAB * 0.5 : SLAB;

  const top = [
    project(x, y, height),
    project(x + w, y, height),
    project(x + w, y + h, height),
    project(x, y + h, height),
  ];
  // The two faces turned toward the viewer.
  const south = [
    project(x, y + h, height),
    project(x + w, y + h, height),
    project(x + w, y + h, 0),
    project(x, y + h, 0),
  ];
  const east = [
    project(x + w, y, height),
    project(x + w, y + h, height),
    project(x + w, y + h, 0),
    project(x + w, y, 0),
  ];

  const centre = project(x + w / 2, y + h / 2, height);
  const vendor = VENDOR_MARK[n.vendor] ?? '';
  const sub = [n.sublabel, zoneBadge && n.detail?.zone ? `· ${n.detail.zone}` : '']
    .filter(Boolean)
    .join(' ');

  const body =
    `<polygon points="${poly(south)}" fill="${theme.surfaceAlt}" stroke="${theme.stroke}" stroke-width="1"/>` +
    `<polygon points="${poly(east)}" fill="${theme.bgAlt}" stroke="${theme.stroke}" stroke-width="1"/>` +
    `<polygon points="${poly(top)}" fill="${theme.surface}" stroke="${theme.stroke}" stroke-width="1"/>` +
    // Accent along the leading edge of the top face: the same role cue the
    // flat view puts on the card's left rail.
    `<path d="M${r(top[3].x)} ${r(top[3].y)} L${r(top[2].x)} ${r(top[2].y)}" stroke="${accent}" stroke-width="3"/>` +
    // Grounding shadow so a slab does not appear to float off its plate.
    '';

  // Text stays screen-aligned. Skewing labels into the isometric plane looks
  // clever for one screenshot and is unreadable in every other situation.
  const label = isData
    ? `<text x="${r(centre.x)}" y="${r(centre.y + 3)}" text-anchor="middle" font-size="11.5" ` +
      `font-weight="650" font-family="${esc(DATA_FONT)}" fill="${theme.text}">${esc(n.label)}</text>`
    : `<text x="${r(centre.x + 14)}" y="${r(centre.y - 1)}" text-anchor="middle" font-size="12" ` +
      `font-weight="650" font-family="${esc(theme.fontDisplay)}" fill="${theme.text}">` +
      `${esc(theme.uppercase ? n.label.toUpperCase() : n.label)}</text>` +
      (sub
        ? `<text x="${r(centre.x + 14)}" y="${r(centre.y + 11)}" text-anchor="middle" font-size="9" ` +
          `fill="${theme.textMuted}">${esc(sub)}</text>`
        : '') +
      (vendor
        ? `<text x="${r(centre.x + 14)}" y="${r(centre.y - 13)}" text-anchor="middle" font-size="7.5" ` +
          `font-weight="600" letter-spacing="0.12em" fill="${theme.textFaint}">${esc(vendor)}</text>`
        : '');

  const glyph = isData
    ? ''
    : icon(n.role, centre.x - w * 0.38, centre.y - 11, 20, accent, theme.strokeWidth);

  const xs = [...top, ...south, ...east];
  // Labels are screen-aligned and overhang the slab they belong to, so the
  // bounds have to account for the text, not just the polygon.
  const textW = Math.max(n.label.length, sub.length * 0.8) * 7 + 30;
  return {
    depth: x + y + w + h,
    bbox: [
      Math.min(Math.min(...xs.map((p) => p.x)), centre.x + 14 - textW / 2),
      Math.min(...xs.map((p) => p.y)) - 24,
      Math.max(Math.max(...xs.map((p) => p.x)), centre.x + 14 + textW / 2),
      Math.max(...xs.map((p) => p.y)),
    ],
    svg:
      `<g class="nd-node" data-node="${esc(n.id)}" data-role="${esc(n.role)}"${
        interactive ? ' tabindex="0"' : ''
      }>${body}${glyph}${label}</g>`,
    projected: true,
  };
}

/* ---- helpers ----------------------------------------------------------- */

function poly(points) {
  return points.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
}

function projectedBounds(placed, items) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const it of items) {
    const [a, b, c, d] = it.bbox;
    x0 = Math.min(x0, a);
    y0 = Math.min(y0, b);
    x1 = Math.max(x1, c);
    y1 = Math.max(y1, d);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 720, h: 420 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
