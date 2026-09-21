import { VENDOR_MARK } from './icons.ts';
import { dashFor, weightFor, DATA_FONT, detailFlags } from '../theme/themes.ts';
import type { Theme, DetailFlags } from '../theme/themes.ts';
import { defs, background, legendRow, titleBlockEl, esc, r, usedPorts } from './svg.ts';
import type { RenderOpts } from './svg.ts';
import type { Placed, Point } from '../layout/index.ts';
import type { Graph, GraphNode, GraphEdge, GraphGroup } from '../model/derive.ts';

/** A 2D point after isometric projection. */
interface P2 { x: number; y: number; }

/** A placement scaled for isometric projection. */
interface IsoPlaced {
  nodes: Map<string, { x: number; y: number; w: number; h: number }>;
  edges: Map<string, { points: Point[] }>;
  source: string;
}

/** One entry in the back-to-front display list. */
interface DisplayItem {
  depth: number;
  bbox: [number, number, number, number];
  svg: string;
  projected?: boolean;
}

/** A zone floor plate rectangle in flat coordinates. */
interface Plate {
  group: GraphGroup;
  index: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Isometric L1.
 *
 * The flat L1 drawing answers "what is cabled to what". This one answers
 * "what does the room look like": devices become slabs standing on their
 * security zone's floor plate, and cables run through the space between
 * them.
 *
 * It is a projection of the flat layout — the same node positions and the
 * same cable routes, scaled down. That matters more than it sounds: ELK
 * routes orthogonally around obstacles, and an earlier version of this file
 * threw those routes away in favour of its own grid and a naive two-segment
 * router. The result was 70% of cable segments crossing a chassis they had
 * nothing to do with. Reprojecting brings that to zero, because the routes
 * were already obstacle-free in the plane they were computed in.
 *
 * Everything is ordinary SVG, so it prints and exports like any other layer.
 */

// True isometric: 30 degrees above the horizon.
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;

const SLAB = 26; // device height, in projected units

/**
 * How far the flat layout is scaled down before projection.
 *
 * 0.8 keeps a device footprint at 150x61 — the size the chassis kits are
 * drawn for — while leaving enough clearance between rows that the slab's
 * own height cannot make a cable in the next aisle appear to cross it.
 */
const K = 0.8;

function project(x: number, y: number, z = 0): P2 {
  return {
    x: (x - y) * COS30,
    y: (x + y) * SIN30 - z,
  };
}

/** The flat layout, scaled. Routes come along unchanged. */
function isometricPlacement(graph: Graph, flat: Placed): IsoPlaced {
  const nodes = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const [id, b] of flat.nodes) {
    nodes.set(id, { x: b.x * K, y: b.y * K, w: b.w * K, h: b.h * K });
  }
  const edges = new Map<string, { points: Point[] }>();
  for (const e of graph.edges) {
    const route = flat.edges.get(e.id);
    if (route) {
      edges.set(e.id, { points: route.points.map((p) => ({ x: p.x * K, y: p.y * K })) });
    }
  }
  return { nodes, edges, source: flat.source };
}

export function renderIsometric(graph: Graph, flatPlaced: Placed, theme: Theme, opts: RenderOpts = {}): string {
  const { titleBlock = true, legend = true, padding = 44, interactive = false, detail = 'full' } = opts;
  const show = detailFlags(detail);
  const placed = isometricPlacement(graph, flatPlaced);

  // A display list painted back to front. Depth is distance along the
  // viewing axis, so a slab in front correctly hides the cable behind it.
  const items: DisplayItem[] = [];

  for (const g of zonePlates(graph, placed, theme)) items.push(g);
  const platesDrawn = items.length > 0;
  for (const e of graph.edges) {
    const route = placed.edges.get(e.id);
    if (route && route.points.length >= 2) items.push(...cableSegments(e, route.points, theme, interactive));
  }
  for (const n of graph.nodes) {
    const box = placed.nodes.get(n.id);
    if (box) items.push(slab(n, box, theme, interactive, { zoneBadge: !platesDrawn, graph, show }));
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
function zonePlates(graph: Graph, placed: IsoPlaced, theme: Theme): DisplayItem[] {
  const plates: Plate[] = [];
  graph.groups.forEach((g, i) => {
    const boxes = g.nodes
      .map((id) => placed.nodes.get(id))
      .filter((b): b is { x: number; y: number; w: number; h: number } => Boolean(b));
    if (boxes.length === 0) return;
    const pad = 20;
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
    const labelW = (g.label ?? g.id).length * 7 + 20;
    const edgeMid = { x: (corners[0].x + corners[3].x) / 2, y: (corners[0].y + corners[3].y) / 2 };
    return {
      // Floors are always behind whatever stands on them.
      depth: -1e6 + index,
      bbox: [
        Math.min(Math.min(...corners.map((p) => p.x)), edgeMid.x - 12 - labelW),
        Math.min(...corners.map((p) => p.y)) - 14,
        Math.max(...corners.map((p) => p.x)),
        Math.max(...corners.map((p) => p.y)),
      ] as [number, number, number, number],
      svg: drawZonePlate({ ...g, corners }, theme),
    };
  });
}

function rectsOverlap(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function drawZonePlate(z: GraphGroup & { corners: P2[] }, theme: Theme): string {
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
    `font-weight="600" letter-spacing="0.09em" fill="${t.text}">${esc((z.label ?? z.id).toUpperCase())}</text>` +
    `</g>`
  );
}

/* ---- cables ----------------------------------------------------------- */

function cableSegments(e: GraphEdge, pts: Point[], theme: Theme, interactive: boolean): DisplayItem[] {
  const color = theme.media[e.media] ?? theme.stroke;
  const dash = dashFor(e.media, theme);
  const width = weightFor(e.media, theme);
  const z = SLAB * 0.55;
  const out: DisplayItem[] = [];

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const pa = project(a.x, a.y, z);
    const pb = project(b.x, b.y, z);
    const d = `M${r(pa.x)} ${r(pa.y)} L${r(pb.x)} ${r(pb.y)}`;
    // A projected cable is a 1-2px diagonal, far below a comfortable click
    // target, so every segment gets a fat invisible companion. Only the first
    // segment is focusable: a nine-segment route would otherwise cost nine
    // tab stops to walk past.
    const hit = interactive
      ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="12" class="nd-edge-hit"/>`
      : '';
    const focus = interactive && i === 1 ? ' tabindex="0" role="button"' : '';
    out.push({
      // Depth is the nearest extent along the viewing axis, the same
      // convention slabs use. A centroid here would sort a long cable against
      // a slab's near corner on a different scale and occlude wrongly.
      depth: Math.max(a.x + a.y, b.x + b.y),
      bbox: [Math.min(pa.x, pb.x), Math.min(pa.y, pb.y), Math.max(pa.x, pb.x), Math.max(pa.y, pb.y)] as [number, number, number, number],
      svg:
        `<g class="nd-edge" data-edge="${esc(e.id)}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" ` +
        `data-media="${esc(e.media)}"${focus}>` +
        hit +
        `<path d="${d}" fill="none" stroke="${color}" ` +
        `stroke-width="${r(width)}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}/>` +
        `</g>`,
      projected: true,
    });
  }
  return out;
}

/* ---- chassis faces ----------------------------------------------------- */

/**
 * Map a face-local coordinate system onto one of the slab's visible faces.
 *
 * Face-local units are the same units as the rest of the drawing — `u` runs
 * along the face's width, `v` runs downward from its top edge — so the matrix
 * scale stays at cos(30°) and an ordinary `stroke-width` still means roughly
 * one pixel. Authoring kits in a 0..1 unit square would scale strokes by the
 * face width and squash circles into 6:1 ellipses.
 *
 * Every matrix has a positive determinant. The east face takes its origin at
 * the near corner and runs `u` away from the viewer for exactly that reason;
 * anchoring it at the far corner mirrors anything asymmetric.
 */
function faceTransform(face: 'south' | 'east' | 'top', x: number, y: number, w: number, h: number, height: number): string {
  let o: P2;
  switch (face) {
    case 'south':
      o = project(x, y + h, height);
      return `matrix(${r(COS30)} ${r(SIN30)} 0 1 ${r(o.x)} ${r(o.y)})`;
    case 'east':
      o = project(x + w, y + h, height);
      return `matrix(${r(COS30)} ${r(-SIN30)} 0 1 ${r(o.x)} ${r(o.y)})`;
    case 'top':
      o = project(x, y, height);
      return `matrix(${r(COS30)} ${r(SIN30)} ${r(-COS30)} ${r(SIN30)} ${r(o.x)} ${r(o.y)})`;
    default:
      throw new Error(`Unknown face "${face}"`);
  }
}

/** Which chassis a role wears. */
function kitFor(role: string): string {
  switch (role) {
    case 'core':
    case 'distribution':
    case 'access':
    case 'wireless':
    case 'router':
    case 'loadbalancer':
      return 'ports';
    case 'firewall':
      return 'firewall';
    case 'server':
    case 'hypervisor':
    case 'container':
    case 'service':
      return 'server';
    case 'storage':
      return 'storage';
    case 'client':
      return 'client';
    case 'internet':
    case 'wan':
      return 'none';
    default:
      return 'vents';
  }
}

/**
 * Chassis detail drawn into the front face.
 *
 * Kit content uses `<rect>` and `<path>` only, never a `points=` attribute:
 * the geometry lives inside a transformed group, and the viewBox test reads
 * `points=` values as though they were global coordinates.
 */
function frontFace(n: GraphNode, graph: Graph, theme: Theme, box: { x: number; y: number; w: number; h: number }, height: number): string {
  const { x, y, w, h } = box;
  const kit = kitFor(n.role);
  if (kit === 'none') return '';

  const accent = theme.role[n.role] ?? theme.textMuted;
  const line = theme.strokeStrong;
  const faint = theme.textFaint;
  const inset = 9;
  const usable = w - inset * 2;
  const parts: string[] = [];

  if (kit === 'ports') {
    // The faceplate carries the same data as the flat view's port strip: one
    // port per cabled interface, coloured by the media on that cable.
    const used = usedPorts(n, graph);
    const pw = 9;
    const gap = 3.5;
    const max = Math.max(1, Math.floor((usable + gap) / (pw + gap)));
    const shown = used.slice(0, max);
    const rows = shown.length ? 1 : 0;
    const py = height / 2 - 3;

    shown.forEach((p, i) => {
      const c = theme.media[p.media] ?? faint;
      parts.push(
        `<rect x="${r(inset + i * (pw + gap))}" y="${r(py)}" width="${pw}" height="6" rx="1" fill="${c}"/>`,
      );
    });
    // Empty bays for the rest of the faceplate, so a lightly cabled switch
    // still looks like a switch rather than a bare box.
    const empty = Math.max(0, Math.min(max, 8) - shown.length);
    for (let i = 0; i < empty; i++) {
      const at = inset + (shown.length + i) * (pw + gap);
      parts.push(
        `<rect x="${r(at)}" y="${r(py)}" width="${pw}" height="6" rx="1" fill="none" ` +
          `stroke="${faint}" stroke-width="0.8" stroke-opacity="0.65"/>`,
      );
    }
    if (rows) {
      parts.push(
        `<rect x="${r(w - inset - 3)}" y="${r(height / 2 - 1.5)}" width="3" height="3" rx="1.5" fill="${accent}"/>`,
      );
    }
  } else if (kit === 'firewall') {
    // Brick courses, the same identity the flat view's firewall glyph uses.
    const courses = 3;
    const bh = (height - 8) / courses;
    for (let c = 0; c < courses; c++) {
      const by = 4 + c * bh;
      const offset = c % 2 ? -14 : 0;
      for (let bx = inset + offset; bx < w - inset; bx += 28) {
        const x0 = Math.max(inset, bx);
        const x1 = Math.min(w - inset, bx + 26);
        if (x1 - x0 < 4) continue;
        parts.push(
          `<rect x="${r(x0)}" y="${r(by)}" width="${r(x1 - x0)}" height="${r(bh - 2)}" rx="1" ` +
            `fill="none" stroke="${accent}" stroke-width="0.9" stroke-opacity="0.8"/>`,
        );
      }
    }
  } else if (kit === 'server') {
    // Two drive bays and a status light: a 2U chassis, front on.
    const bh = 6;
    for (let i = 0; i < 2; i++) {
      const by = height / 2 - bh - 1 + i * (bh + 2);
      parts.push(
        `<rect x="${r(inset)}" y="${r(by)}" width="${r(usable - 16)}" height="${bh}" rx="1" ` +
          `fill="none" stroke="${line}" stroke-width="1" stroke-opacity="0.95"/>`,
      );
      parts.push(
        `<rect x="${r(inset + 3)}" y="${r(by + 1.6)}" width="18" height="2.8" rx="1.4" ` +
          `fill="${line}" fill-opacity="0.8"/>`,
      );
    }
    parts.push(
      `<rect x="${r(w - inset - 3)}" y="${r(height / 2 - 1.5)}" width="3" height="3" rx="1.5" fill="${accent}"/>`,
    );
  } else if (kit === 'storage') {
    // A grid of drive carriers.
    const cols = Math.max(4, Math.min(7, Math.floor(usable / 18)));
    const cw = usable / cols;
    const bh = (height - 10) / 2;
    for (let c = 0; c < cols; c++) {
      for (let row = 0; row < 2; row++) {
        parts.push(
          `<rect x="${r(inset + c * cw + 1)}" y="${r(5 + row * (bh + 1))}" ` +
            `width="${r(cw - 2.5)}" height="${r(bh - 1)}" rx="0.8" fill="none" ` +
            `stroke="${accent}" stroke-width="0.8" stroke-opacity="0.7"/>`,
        );
      }
    }
  } else if (kit === 'client') {
    // A screen on a stand, seen front on.
    const sw = usable * 0.62;
    const sh = height - 10;
    const sx = (w - sw) / 2;
    parts.push(
      `<rect x="${r(sx)}" y="4" width="${r(sw)}" height="${r(sh)}" rx="1.5" fill="none" ` +
        `stroke="${line}" stroke-width="1" stroke-opacity="0.85"/>`,
      `<rect x="${r(sx + 3)}" y="6.5" width="${r(sw - 6)}" height="${r(sh - 5)}" rx="1" ` +
        `fill="${accent}" fill-opacity="0.18"/>`,
    );
  } else {
    // Generic ventilation slots.
    for (let i = 0; i < 3; i++) {
      const vy = height / 2 - 5 + i * 4;
      parts.push(
        `<path d="M${r(inset)} ${r(vy)} H${r(w - inset)}" stroke="${faint}" ` +
          `stroke-width="0.9" stroke-opacity="0.7"/>`,
      );
    }
  }

  if (parts.length === 0) return '';
  return `<g class="nd-detail-chassis" transform="${faceTransform('south', x, y, w, h, height)}">${parts.join('')}</g>`;
}

/**
 * A seam inset from the edge of the lid. Vent slots were the obvious choice
 * and they collided with the device label, which sits on this same face; a
 * seam reads as a machined panel from any angle and cannot fight the text.
 */
function topFace(n: GraphNode, theme: Theme, box: { x: number; y: number; w: number; h: number }, height: number): string {
  const { x, y, w, h } = box;
  if (kitFor(n.role) === 'none') return '';
  const inset = 6;
  return (
    `<g class="nd-detail-chassis" transform="${faceTransform('top', x, y, w, h, height)}">` +
    `<rect x="${inset}" y="${inset}" width="${r(w - inset * 2)}" height="${r(h - inset * 2)}" ` +
    `rx="2" fill="none" stroke="${theme.textFaint}" stroke-width="0.8" stroke-opacity="0.35"/>` +
    `</g>`
  );
}

/* ---- device slabs ------------------------------------------------------ */

function slab(
  n: GraphNode,
  box: { x: number; y: number; w: number; h: number },
  theme: Theme,
  interactive: boolean,
  { zoneBadge = false, graph, show = detailFlags('full') }: { zoneBadge?: boolean; graph?: Graph; show?: DetailFlags } = {},
): DisplayItem {
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
    `<path d="M${r(top[3].x)} ${r(top[3].y)} L${r(top[2].x)} ${r(top[2].y)}" stroke="${accent}" stroke-width="3"/>`;

  // Role is carried by the shape of the chassis itself — a port row, brick
  // courses, drive bays — rather than by a flat icon pasted onto a solid. A
  // 2D glyph sitting on an isometric object is what makes a drawing look
  // assembled rather than designed.
  const chassis =
    isData || !graph || !show.chassis
      ? ''
      : topFace(n, theme, box, height) + frontFace(n, graph, theme, box, height);

  // Text stays screen-aligned. Skewing labels into the isometric plane looks
  // clever for one screenshot and is unreadable in every other situation.
  //
  // Each label is painted over a halo of the background colour, because a
  // cable passing behind a hostname would otherwise cut it in half. The halo
  // is stroke-first so the glyph shapes stay exact.
  const halo = (width: number): string =>
    `paint-order="stroke" stroke="${theme.bg}" stroke-width="${width}" stroke-linejoin="round"`;

  const label = isData
    ? `<text x="${r(centre.x)}" y="${r(centre.y + 3)}" text-anchor="middle" font-size="11.5" ` +
      `font-weight="650" font-family="${esc(DATA_FONT)}" ${halo(3)} fill="${theme.text}">${esc(n.label)}</text>`
    : `<text x="${r(centre.x)}" y="${r(centre.y - 1)}" text-anchor="middle" font-size="12" ` +
      `font-weight="650" font-family="${esc(theme.fontDisplay)}" ${halo(3.5)} fill="${theme.text}">` +
      `${esc(theme.uppercase ? n.label.toUpperCase() : n.label)}</text>` +
      (sub && show.sub
        ? `<text class="nd-detail-sub" x="${r(centre.x)}" y="${r(centre.y + 11)}" text-anchor="middle" ` +
          `font-size="9" ${halo(2.5)} fill="${theme.textMuted}">${esc(sub)}</text>`
        : '') +
      (vendor && show.vendor
        ? `<text class="nd-detail-vendor" x="${r(centre.x)}" y="${r(centre.y - 13)}" text-anchor="middle" ` +
          `font-size="7.5" font-weight="600" letter-spacing="0.12em" ${halo(2.5)} ` +
          `fill="${theme.textFaint}">${esc(vendor)}</text>`
        : '');

  const xs = [...top, ...south, ...east];
  // Labels are screen-aligned and overhang the slab they belong to, so the
  // bounds have to account for the text, not just the polygon.
  const textW = Math.max(n.label.length, sub.length * 0.8) * 7 + 30;
  return {
    // Nearest extent along the viewing axis; cables use the same measure.
    depth: x + w + y + h,
    bbox: [
      Math.min(Math.min(...xs.map((p) => p.x)), centre.x - textW / 2),
      Math.min(...xs.map((p) => p.y)) - 24,
      Math.max(Math.max(...xs.map((p) => p.x)), centre.x + textW / 2),
      Math.max(...xs.map((p) => p.y)),
    ] as [number, number, number, number],
    svg:
      `<g class="nd-node" data-node="${esc(n.id)}" data-role="${esc(n.role)}"${
        interactive ? ' tabindex="0"' : ''
      }>${body}${chassis}${label}</g>`,
    projected: true,
  };
}

/* ---- helpers ----------------------------------------------------------- */

function poly(points: P2[]): string {
  return points.map((p) => `${r(p.x)},${r(p.y)}`).join(' ');
}

function projectedBounds(placed: IsoPlaced, items: DisplayItem[]): { x: number; y: number; w: number; h: number } {
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
