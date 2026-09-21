import yaml from 'js-yaml';
import type { Model, Device, NetInterface, Zone, Site, Vlan, Subnet, External, Service, Layout } from './types.ts';

/** The implicit, never-stored automatic layout (ELK). */
export const AUTO_LAYOUT = 'auto';
/** The synthetic id under which a legacy `model.layout` block is exposed. */
export const MANUAL_LAYOUT = 'manual';

export interface LayoutOption { id: string; name: string; }

/** True when a legacy `model.layout` block actually holds coordinates. */
function hasLegacyLayout(model: Model): boolean {
  return !!model.layout && Object.keys(model.layout).length > 0;
}

/** Every selectable layout: Auto first, then the legacy manual block, then named. */
export function layoutOptions(model: Model): LayoutOption[] {
  const opts: LayoutOption[] = [{ id: AUTO_LAYOUT, name: 'Auto' }];
  if (hasLegacyLayout(model)) opts.push({ id: MANUAL_LAYOUT, name: 'Manual' });
  for (const l of model.layouts ?? []) opts.push({ id: l.id, name: l.name });
  return opts;
}

/** The layout id used outside Studio. Defaults to Auto, or the legacy block. */
export function defaultLayoutId(model: Model): string {
  if (model.defaultLayout) return model.defaultLayout;
  return hasLegacyLayout(model) ? MANUAL_LAYOUT : AUTO_LAYOUT;
}

/** Frozen per-layer coordinates for a chosen layout, or undefined for Auto. */
export function frozenLayers(model: Model, layoutId?: string): Layout | undefined {
  const id = layoutId ?? defaultLayoutId(model);
  if (id === AUTO_LAYOUT) return undefined;
  if (id === MANUAL_LAYOUT) return hasLegacyLayout(model) ? model.layout : undefined;
  return (model.layouts ?? []).find((l) => l.id === id)?.layers;
}

/** An error carrying a machine-readable code, as produced across the loader. */
export interface CodedError extends Error {
  code?: string;
}

/** Stable lookup index built over a model for fast reference resolution. */
export interface ModelIndex {
  devices: Map<string, Device>;
  zones: Map<string, Zone>;
  sites: Map<string, Site>;
  vlans: Map<number, Vlan>;
  subnets: Map<string, Subnet>;
  externals: Map<string, External>;
  ifaceOf: (devId: string, name: string) => NetInterface | null;
  serviceOf: (holderId: string, name: string) => Service | null;
}

/** A resolved dependency endpoint. */
export interface DepEndpoint {
  holder: string | null;
  service: string | null;
  kind: 'device' | 'external' | null;
  raw: string;
}

/**
 * Parse a netlas model from YAML or JSON text.
 * Does not validate; call validateModel() for that.
 */
export function parseModel(text: string, source = '<inline>'): Model {
  let raw: unknown;
  try {
    raw = yaml.load(text, { filename: source });
  } catch (err) {
    const e: CodedError = new Error(`Cannot parse ${source}: ${(err as Error).message}`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  if (raw === null || raw === undefined) {
    const e: CodedError = new Error(`${source} is empty`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const e: CodedError = new Error(`${source} must contain a YAML mapping at the top level`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  return normalize(raw as Record<string, unknown>);
}

/**
 * Apply the same defaults to a model built in memory as to one parsed from a
 * file. Any producer — the YAML loader, the Studio editor, a future
 * importer — must come through here, or it will hand downstream code an
 * object that is subtly a different shape.
 */
export function normalizeModel(raw: Model | Record<string, unknown>): Model {
  return normalize(raw as Record<string, unknown>);
}

/**
 * Fill in defaults and derived conveniences without inventing facts.
 *
 * This object literal is a whitelist: a top-level key that is not listed here
 * is dropped before validateModel() ever sees it, and because the schema runs
 * against the *normalized* model its additionalProperties:false cannot report
 * the loss. Any new top-level key must be added here or it vanishes silently.
 */
function normalize(raw: Record<string, unknown>): Model {
  const r = raw as Partial<Model> & Record<string, unknown>;
  const m: Model = {
    meta: { ...(r.meta as Model['meta']) },
    sites: r.sites ?? [],
    zones: r.zones ?? [],
    devices: r.devices ?? [],
    links: r.links ?? [],
    vlans: r.vlans ?? [],
    subnets: r.subnets ?? [],
    routing: r.routing ?? [],
    externals: r.externals ?? [],
    dependencies: r.dependencies ?? [],
    layout: r.layout ?? {},
    // Optional and only carried through when present, so a design that never
    // used named layouts keeps a clean YAML file (no empty `layouts: []`).
    ...(Array.isArray(r.layouts) && r.layouts.length ? { layouts: r.layouts } : {}),
    ...(r.defaultLayout ? { defaultLayout: r.defaultLayout } : {}),
  };
  for (const d of m.devices) {
    d.label ??= d.id;
    d.vendor ??= 'generic';
    d.interfaces ??= [];
    for (const i of d.interfaces) {
      i.mode ??= inferMode(i);
    }
  }
  for (const s of m.sites) s.label ??= s.id;
  for (const z of m.zones) z.label ??= z.id;
  for (const v of m.vlans) v.name ??= `VLAN${v.id}`;
  for (const e of m.externals) {
    // nodeSize() reads node.label.length unguarded.
    e.label ??= e.id;
    e.kind ??= 'unknown';
    e.services ??= [];
  }
  // `kind` defaults to the neutral value, as media and routing kind do.
  // `strength` deliberately has no default: it is required by the schema,
  // because defaulting to the severest value would make every blast radius
  // over-report, and defaulting to the mildest would hide real risk.
  for (const dep of m.dependencies) dep.kind ??= 'other';
  return m;
}

function inferMode(iface: NetInterface & { vlan?: number }): NetInterface['mode'] {
  if (Array.isArray(iface.vlans) && iface.vlans.length > 1) return 'trunk';
  if (/^(vlan|irb|svi)/i.test(iface.name)) return 'svi';
  if (/^(lo|loopback)/i.test(iface.name)) return 'loopback';
  if (/^(mgmt|management|ma\d)/i.test(iface.name)) return 'mgmt';
  if (iface.ip) return 'routed';
  if (iface.vlan !== undefined) return 'access';
  return 'access';
}

/** Split "dev:Gi1/0/1" into { device, iface }. */
export function parseEndpoint(ep: string): { device: string; iface: string | null } {
  const idx = ep.indexOf(':');
  if (idx === -1) return { device: ep, iface: null };
  return { device: ep.slice(0, idx), iface: ep.slice(idx + 1) };
}

/** Stable index over a model for fast lookups. */
export function indexModel(model: Model): ModelIndex {
  const devices = new Map<string, Device>(model.devices.map((d) => [d.id, d]));
  const zones = new Map<string, Zone>(model.zones.map((z) => [z.id, z]));
  const sites = new Map<string, Site>(model.sites.map((s) => [s.id, s]));
  const vlans = new Map<number, Vlan>(model.vlans.map((v) => [v.id, v]));
  const subnets = new Map<string, Subnet>(model.subnets.map((s) => [s.cidr, s]));
  const externals = new Map<string, External>((model.externals ?? []).map((e) => [e.id, e]));
  const ifaceOf = (devId: string, name: string): NetInterface | null =>
    devices.get(devId)?.interfaces?.find((i) => i.name === name) ?? null;
  const serviceOf = (holderId: string, name: string): Service | null => {
    const holder = devices.get(holderId) ?? externals.get(holderId);
    return holder?.services?.find((s) => s.name === name) ?? null;
  };
  return { devices, zones, sites, vlans, subnets, externals, ifaceOf, serviceOf };
}

/**
 * Resolve a dependency endpoint against the device + external namespace.
 *
 * Deliberately not parseEndpoint(): a link endpoint is device:interface and
 * interface names never contain a colon, so splitting on the *first* colon is
 * safe there. Here the left side may itself contain a colon — definitions/id
 * permits it — so a whole-string match must win before any splitting, and the
 * split is on the LAST colon so that "dc1:ise:radius" reads as the service
 * "radius" on the device "dc1:ise".
 *
 * @returns {{ holder: string|null, service: string|null, kind: 'device'|'external'|null, raw: string }}
 */
export function resolveDepEndpoint(ep: string, ix: ModelIndex): DepEndpoint {
  const whole = (id: string): 'device' | 'external' | null =>
    ix.devices.has(id) ? 'device' : ix.externals.has(id) ? 'external' : null;

  const direct = whole(ep);
  if (direct) return { holder: ep, service: null, kind: direct, raw: ep };

  const cut = ep.lastIndexOf(':');
  if (cut > 0) {
    const holder = ep.slice(0, cut);
    const found = whole(holder);
    if (found) return { holder, service: ep.slice(cut + 1), kind: found, raw: ep };
  }
  return { holder: null, service: null, kind: null, raw: ep };
}

