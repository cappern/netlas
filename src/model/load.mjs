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

/** Fill in defaults and derived conveniences without inventing facts. */
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
  const ifaceOf = (devId, name) =>
    devices.get(devId)?.interfaces.find((i) => i.name === name) ?? null;
  return { devices, zones, sites, vlans, subnets, ifaceOf };
}
