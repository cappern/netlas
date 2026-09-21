import { deriveLayer, layersFor } from '$lib/core/model/derive.ts';
import { layoutGraph } from '$lib/core/layout/index.ts';
import { renderSvg } from '$lib/core/render2d/svg.ts';
import { renderIsometric } from '$lib/core/render2d/isometric.ts';
import { getTheme } from '$lib/core/theme/themes.ts';
import { buildImpactMap } from '$lib/core/model/impact.ts';
import { normalizeModel, frozenLayers } from '$lib/core/model/load.ts';
import type { Model, PartialModel, LayerId } from '$lib/core/model/types.ts';
import type { Graph } from '$lib/core/model/derive.ts';
import type { Placed } from '$lib/core/layout/index.ts';
import type { Theme } from '$lib/core/theme/themes.ts';

export interface NodeBox { x: number; y: number; w: number; h: number; }
export interface LayerGeometry {
  width: number;
  height: number;
  source: string;
  nodes: Record<string, NodeBox>;
}
export interface LegendItem { kind: string; label: string; color: string; }
export interface RenderedNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: string;
  role?: string;
  detail?: unknown;
  color: string;
}
export interface RenderedEdge {
  id: string;
  a: string;
  b: string;
  kind: string;
  aPort?: string;
  bPort?: string;
  media?: string;
  speed?: string;
  label?: string;
  directed?: boolean;
  detail?: unknown;
  color: string;
}
export interface RenderedLayer {
  id: string;
  label: string;
  word: string;
  subtitle?: string;
  svg: string;
  geometry: LayerGeometry;
  legend: LegendItem[];
  nodes: RenderedNode[];
  edges: RenderedEdge[];
}
export interface ThemeCss {
  id: string;
  mode: string;
  bg: string;
  surface: string;
  surfaceRaised: string;
  strokeStrong: string;
  text: string;
  textMuted: string;
  fontBody: string;
}
export interface RenderResult {
  theme: ThemeCss;
  layers: RenderedLayer[];
  impact: Record<string, unknown>;
}

/**
 * Derive → layout → render every drawable layer of a model. Pure and
 * isomorphic: the same code produces the first paint on the server and every
 * live re-render in the browser (elkjs runs in a worker there). Each layer
 * carries its interactive SVG, the node/edge detail the inspector reads, and
 * the node geometry the editor overlay needs to place drag handles.
 */
export async function renderLayers(
  rawModel: Model | PartialModel,
  opts: { layoutId?: string; themeId?: string } = {},
): Promise<RenderResult> {
  // Edits build partial shapes (a new device without an interfaces array); the
  // renderer assumes full shape, so normalise first — the same defaults the
  // file loader applies. Idempotent for an already-loaded model.
  const model = normalizeModel(rawModel);
  const theme = getTheme(opts.themeId ?? model.meta.theme);
  const frozen = frozenLayers(model, opts.layoutId);

  const layers: RenderedLayer[] = [];
  for (const id of layersFor(model)) {
    const graph = deriveLayer(model, id);
    const placed = await layoutGraph(graph, { frozen: frozen?.[id] });
    layers.push(shape(id, graph, placed, theme, renderSvg(graph, placed, theme, { interactive: true, titleBlock: false })));
  }

  const l1 = layers.find((l) => l.id === 'l1');
  if (l1) {
    const graph = deriveLayer(model, 'l1');
    const placed = await layoutGraph(graph, { frozen: frozen?.l1 });
    layers.push(
      shape('iso', { ...graph, subtitle: 'Isometric physical view' }, placed, theme,
        renderIsometric(graph, placed, theme, { interactive: true, titleBlock: false })),
    );
  }

  return { theme: themeCss(theme), layers, impact: buildImpactMap(model) };
}

/**
 * Render a single layer. Used during a node drag, where re-deriving every
 * layer each frame would be wasteful — only the layer on screen needs to move,
 * and once a layer is frozen its layout is a cheap re-route, not a solve.
 */
export async function renderLayer(
  rawModel: Model | PartialModel,
  layerId: string,
  opts: { layoutId?: string; themeId?: string } = {},
): Promise<RenderedLayer> {
  const model = normalizeModel(rawModel);
  const theme = getTheme(opts.themeId ?? model.meta.theme);
  const base = (layerId === 'iso' ? 'l1' : layerId) as LayerId;
  const graph = deriveLayer(model, base);
  const placed = await layoutGraph(graph, { frozen: frozenLayers(model, opts.layoutId)?.[base] });
  if (layerId === 'iso') {
    return shape('iso', { ...graph, subtitle: 'Isometric physical view' }, placed, theme,
      renderIsometric(graph, placed, theme, { interactive: true, titleBlock: false }));
  }
  return shape(layerId, graph, placed, theme, renderSvg(graph, placed, theme, { interactive: true, titleBlock: false }));
}

const LAYER_WORD: Record<string, string> = { l1: 'Physical', l2: 'VLANs', l3: 'Routing', iso: 'Isometric', dep: 'Dependencies' };

function shape(id: string, graph: Graph, placed: Placed, theme: Theme, svg: string): RenderedLayer {
  // Geometry drives the editor overlay: absolute-positioned handles aligned to
  // the same coordinate space the SVG is drawn in.
  const geometry: LayerGeometry = { width: placed.width, height: placed.height, source: placed.source, nodes: {} };
  for (const [nid, box] of placed.nodes) geometry.nodes[nid] = { x: box.x, y: box.y, w: box.w, h: box.h };

  return {
    id,
    label: id === 'iso' ? 'ISO' : id.toUpperCase(),
    word: LAYER_WORD[id] ?? id,
    subtitle: graph.subtitle,
    svg,
    geometry,
    legend: graph.legend.map((l) => ({
      ...l,
      color: theme.media[l.kind] ?? theme.role[l.kind] ?? theme.textMuted,
    })),
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      sublabel: n.sublabel,
      kind: n.kind,
      role: n.role,
      detail: n.detail,
      color: theme.role[n.role] ?? theme.textMuted,
    })),
    edges: graph.edges.map((e) => ({
      id: e.id, a: e.a, b: e.b,
      kind: e.kind, aPort: e.aPort ?? undefined, bPort: e.bPort ?? undefined,
      media: e.media, speed: e.speed,
      label: e.label, directed: e.directed, detail: e.detail,
      color: theme.media[e.media] ?? theme.stroke,
    })),
  };
}

function themeCss(theme: Theme): ThemeCss {
  return {
    id: theme.id, mode: theme.mode, bg: theme.bg,
    surface: theme.surface, surfaceRaised: theme.surfaceRaised,
    strokeStrong: theme.strokeStrong, text: theme.text,
    textMuted: theme.textMuted, fontBody: theme.fontBody,
  };
}
