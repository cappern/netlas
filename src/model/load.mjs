import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

/**
 * Parse a netdia model from YAML or JSON text.
 * Does not validate; call validateModel() for that.
 */
export function parseModel(text, source = '<inline>') {
  let raw;
  try {
    raw = yaml.load(text, { filename: source });
  } catch (err) {
    const e = new Error(`Cannot parse ${source}: ${err.message}`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  if (raw === null || raw === undefined) {
    const e = new Error(`${source} is empty`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error(`${source} must contain a YAML mapping at the top level`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  return normalize(raw);
}

export function loadModel(path) {
  const abs = resolve(path);
  return parseModel(readFileSync(abs, 'utf8'), abs);
}

/**
 * Apply the same defaults to a model built in memory as to one parsed from a
 * file. Any producer — the YAML loader, the NetBox resolver, a future
 * importer — must come through here, or it will hand downstream code an
 * object that is subtly a different shape.
 */
export function normalizeModel(raw) {
  return normalize(raw);
}

/**
 * Fill in defaults and derived conveniences without inventing facts.
 *
 * This object literal is a whitelist: a top-level key that is not listed here
 * is dropped before validateModel() ever sees it, and because the schema runs
 * against the *normalized* model its additionalProperties:false cannot report
 * the loss. Any new top-level key must be added here or it vanishes silently.
 */
function normalize(raw) {
  const m = {
    meta: { ...raw.meta },
    sites: raw.sites ?? [],
    zones: raw.zones ?? [],
    devices: raw.devices ?? [],
    links: raw.links ?? [],
    vlans: raw.vlans ?? [],
    subnets: raw.subnets ?? [],
    routing: raw.routing ?? [],
    externals: raw.externals ?? [],
    dependencies: raw.dependencies ?? [],
    layout: raw.layout ?? {},
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

function inferMode(iface) {
  if (Array.isArray(iface.vlans) && iface.vlans.length > 1) return 'trunk';
  if (/^(vlan|irb|svi)/i.test(iface.name)) return 'svi';
  if (/^(lo|loopback)/i.test(iface.name)) return 'loopback';
  if (/^(mgmt|management|ma\d)/i.test(iface.name)) return 'mgmt';
  if (iface.ip) return 'routed';
  if (iface.vlan !== undefined) return 'access';
  return 'access';
}

/** Split "dev:Gi1/0/1" into { device, iface }. */
export function parseEndpoint(ep) {
  const idx = ep.indexOf(':');
  if (idx === -1) return { device: ep, iface: null };
  return { device: ep.slice(0, idx), iface: ep.slice(idx + 1) };
}

/** Stable index over a model for fast lookups. */
export function indexModel(model) {
  const devices = new Map(model.devices.map((d) => [d.id, d]));
  const zones = new Map(model.zones.map((z) => [z.id, z]));
  const sites = new Map(model.sites.map((s) => [s.id, s]));
  const vlans = new Map(model.vlans.map((v) => [v.id, v]));
  const subnets = new Map(model.subnets.map((s) => [s.cidr, s]));
  const externals = new Map((model.externals ?? []).map((e) => [e.id, e]));
  const ifaceOf = (devId, name) =>
    devices.get(devId)?.interfaces.find((i) => i.name === name) ?? null;
  const serviceOf = (holderId, name) => {
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
export function resolveDepEndpoint(ep, ix) {
  const whole = (id) =>
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

