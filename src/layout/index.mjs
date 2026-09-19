import ELK from 'elkjs/lib/elk.bundled.js';

/**
 * Layout contract
 * ---------------
 * Automatic by default, freezable to manual.
 *
 * Nodes are partitioned by `tier`, which comes from the device role
 * (internet -> wan -> firewall -> core -> distribution -> access -> compute
 * -> client). That is what makes a netdia diagram read top-to-bottom the way
 * a network engineer already thinks, instead of the way a generic graph
 * solver would arrange it.
 *
 * Zones are not laid out as ELK containers. They are drawn as hulls around
 * their members after the fact, and the renderer is told to fall back to
 * per-node zone badges when those hulls would overlap. An overlapping zone
 * box is worse than no zone box: it asserts a containment that is not true.
 */

const elk = new ELK();

export const NODE_W = 188;
export const NODE_H = 76;
export const NET_W = 172;
export const NET_H = 62;

/**
 * How many nodes a single tier may hold before it is wrapped onto extra rows.
 *
 * A server farm with two dozen hosts is one tier by role, and drawing it as
 * one row produces a diagram several times wider than it is tall — legible
 * only by panning. Wrapping trades a little vertical height for an aspect
 * ratio a reader can actually take in. The isometric view inherits this for
 * free, because it derives its rows from the flat layout's y coordinate.
 */
export const MAX_TIER_WIDTH = 8;

export const LAYOUT_DEFAULTS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  // Wide enough that two neighbouring nodes in different security zones leave
  // a visible gutter between their zone hulls. Hull padding is 20 per side, so
  // this yields a 40px horizontal gutter; the vertical gutter works out at 38
  // once the hull's label-pill allowance is taken off. Keeping the two axes
  // close to equal is what stops zones reading as one merged region.
  'elk.spacing.nodeNode': '80',
  'elk.spacing.edgeNode': '28',
  'elk.spacing.edgeEdge': '16',
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.semiInteractive': 'true',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.mergeEdges': 'false',
  'elk.partitioning.activate': 'true',
  'elk.padding': '[top=48,left=48,bottom=48,right=48]',
};

export function nodeSize(node) {
  if (node.kind === 'network' || node.kind === 'vlan') return { w: NET_W, h: NET_H };
  const chars = Math.max(node.label.length, (node.sublabel ?? '').length * 0.82);
  const w = Math.min(268, Math.max(NODE_W, Math.round(chars * 8.4) + 76));
  return { w, h: NODE_H };
}

/**
 * @returns {{ nodes: Map<id,{x,y,w,h}>, edges: Map<id,{points:[{x,y}]}>,
 *             width, height, source: 'auto'|'frozen' }}
 */
export async function layoutGraph(graph, { frozen = null, options = {} } = {}) {
  const sizes = new Map(graph.nodes.map((n) => [n.id, nodeSize(n)]));

  if (frozen && frozen.nodes && Object.keys(frozen.nodes).length > 0) {
    const missing = graph.nodes.filter((n) => !frozen.nodes[n.id]);
    if (missing.length === 0) {
      return fromFrozen(graph, frozen, sizes);
    }
    // Partial freeze is a silent correctness trap: report it, use auto.
    const err = new Error(
      `Frozen layout for "${graph.layer}" is missing ${missing.length} node(s): ` +
        `${missing.slice(0, 5).map((n) => n.id).join(', ')}${missing.length > 5 ? '…' : ''}. ` +
        `Run "netdia freeze" again to refresh it, or delete the layout.${graph.layer} block.`,
    );
    err.code = 'STALE_LAYOUT';
    throw err;
  }

  const partition = tierPartitions(graph);

  const elkNodes = graph.nodes.map((n) => {
    const s = sizes.get(n.id);
    return {
      id: n.id,
      width: s.w,
      height: s.h,
      layoutOptions: { 'elk.partitioning.partition': String(partition.get(n.id)) },
    };
  });

  const elkEdges = graph.edges.map((e) => ({
    id: e.id,
    sources: [e.a],
    targets: [e.b],
  }));

  const result = await elk.layout({
    id: 'root',
    layoutOptions: { ...LAYOUT_DEFAULTS, ...options },
    children: elkNodes,
    edges: elkEdges,
  });

  const nodes = new Map();
  for (const n of result.children ?? []) {
    nodes.set(n.id, { x: n.x, y: n.y, w: n.width, h: n.height });
  }

  const edges = new Map();
  for (const e of result.edges ?? []) {
    edges.set(e.id, { points: sectionPoints(e) });
  }

  return {
    nodes,
    edges,
    width: result.width ?? 0,
    height: result.height ?? 0,
    source: 'auto',
  };
}

/**
 * Map every node to an ELK partition, splitting any tier wider than
 * MAX_TIER_WIDTH across consecutive partitions so it wraps onto extra rows.
 *
 * Members are ordered by their upstream neighbour before being chunked, so a
 * wrapped tier keeps siblings together: the hosts hanging off one leaf switch
 * land on the same row instead of being scattered by declaration order.
 *
 * Tiers are multiplied out to leave room for the sub-rows while preserving
 * the original top-to-bottom order between tiers.
 */
function tierPartitions(graph) {
  const SPREAD = 100;
  const tierOf = (n) => n.tier ?? 5;

  const byTier = new Map();
  for (const n of graph.nodes) {
    const t = tierOf(n);
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t).push(n);
  }

  // Each node's upstream anchor: the neighbour sitting closest to the top.
  const anchor = new Map();
  for (const n of graph.nodes) {
    const neighbours = graph.edges
      .filter((e) => e.a === n.id || e.b === n.id)
      .map((e) => graph.nodes.find((x) => x.id === (e.a === n.id ? e.b : e.a)))
      .filter(Boolean)
      .filter((x) => tierOf(x) < tierOf(n))
      .sort((a, b) => tierOf(a) - tierOf(b) || a.id.localeCompare(b.id));
    anchor.set(n.id, neighbours[0]?.id ?? '');
  }

  const partition = new Map();
  for (const [tier, members] of byTier) {
    if (members.length <= MAX_TIER_WIDTH) {
      for (const n of members) partition.set(n.id, tier * SPREAD);
      continue;
    }
    const rows = Math.ceil(members.length / MAX_TIER_WIDTH);
    const perRow = Math.ceil(members.length / rows);
    const ordered = [...members].sort(
      (a, b) => anchor.get(a.id).localeCompare(anchor.get(b.id)) || a.id.localeCompare(b.id),
    );
    ordered.forEach((n, i) => {
      partition.set(n.id, tier * SPREAD + Math.floor(i / perRow));
    });
  }
  return partition;
}

function sectionPoints(elkEdge) {
  const pts = [];
  for (const s of elkEdge.sections ?? []) {
    pts.push(s.startPoint);
    for (const b of s.bendPoints ?? []) pts.push(b);
    pts.push(s.endPoint);
  }
  return dedupe(pts);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - p.x) > 0.01 || Math.abs(prev.y - p.y) > 0.01) out.push(p);
  }
  return out;
}

/** Manual mode: positions come from the model, routes are recomputed. */
function fromFrozen(graph, frozen, sizes) {
  const nodes = new Map();
  let maxX = 0;
  let maxY = 0;
  for (const n of graph.nodes) {
    const p = frozen.nodes[n.id];
    const s = sizes.get(n.id);
    nodes.set(n.id, { x: p.x, y: p.y, w: s.w, h: s.h });
    maxX = Math.max(maxX, p.x + s.w);
    maxY = Math.max(maxY, p.y + s.h);
  }
  const edges = new Map();
  for (const e of graph.edges) {
    edges.set(e.id, { points: orthoRoute(nodes.get(e.a), nodes.get(e.b)) });
  }
  return { nodes, edges, width: maxX + 48, height: maxY + 48, source: 'frozen' };
}

/** Two-segment orthogonal route between box centres, leaving perpendicular. */
export function orthoRoute(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;

  if (Math.abs(dy) >= Math.abs(dx)) {
    const start = { x: ac.x, y: dy > 0 ? a.y + a.h : a.y };
    const end = { x: bc.x, y: dy > 0 ? b.y : b.y + b.h };
    const mid = (start.y + end.y) / 2;
    return dedupe([start, { x: start.x, y: mid }, { x: end.x, y: mid }, end]);
  }
  const start = { x: dx > 0 ? a.x + a.w : a.x, y: ac.y };
  const end = { x: dx > 0 ? b.x : b.x + b.w, y: bc.y };
  const mid = (start.x + end.x) / 2;
  return dedupe([start, { x: mid, y: start.y }, { x: mid, y: end.y }, end]);
}

/**
 * Bounding hulls for groups, plus an honest verdict on whether they can be
 * drawn as containers at all.
 */
export function groupHulls(graph, placed, pad = 20) {
  const hulls = [];
  for (const g of graph.groups) {
    const boxes = g.nodes.map((id) => placed.nodes.get(id)).filter(Boolean);
    if (boxes.length === 0) continue;
    const x = Math.min(...boxes.map((b) => b.x)) - pad;
    const y = Math.min(...boxes.map((b) => b.y)) - pad - 18;
    const x2 = Math.max(...boxes.map((b) => b.x + b.w)) + pad;
    const y2 = Math.max(...boxes.map((b) => b.y + b.h)) + pad;
    hulls.push({ ...g, x, y, w: x2 - x, h: y2 - y, members: boxes.length });
  }

  let overlapping = false;
  for (let i = 0; i < hulls.length && !overlapping; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      if (boxesOverlap(hulls[i], hulls[j])) { overlapping = true; break; }
    }
  }

  // A hull that swallows a node belonging to another group is also a lie.
  if (!overlapping) {
    for (const h of hulls) {
      for (const n of graph.nodes) {
        if (h.nodes.includes(n.id)) continue;
        const b = placed.nodes.get(n.id);
        if (b && boxesOverlap(h, { x: b.x, y: b.y, w: b.w, h: b.h })) { overlapping = true; break; }
      }
      if (overlapping) break;
    }
  }

  return { hulls, usable: !overlapping };
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
