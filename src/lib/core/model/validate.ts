import Ajv from 'ajv';
import { parseEndpoint, indexModel, resolveDepEndpoint } from './load.ts';
import type { ModelIndex, DepEndpoint } from './load.ts';
import type { Model, Device, NetInterface, Diagnostic, Diagnostics } from './types.ts';
// Import attribute (Node 22+, and Vite bundles it) so the schema travels with
// the module — a readFileSync path breaks once the bundler moves this chunk.
import schema from './model.schema.json' with { type: 'json' };

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/**
 * @returns {{ ok: boolean, errors: Diagnostic[], warnings: Diagnostic[] }}
 * Diagnostic = { code, subject, message, fix? }
 */
export function validateModel(model: Model): Diagnostics {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  if (!validateSchema(model)) {
    for (const e of validateSchema.errors ?? []) {
      errors.push({
        code: 'SCHEMA',
        subject: e.instancePath || '/',
        message: `${e.instancePath || 'model'} ${e.message}${
          e.params?.allowedValues ? ` (allowed: ${e.params.allowedValues.join(', ')})` : ''
        }`,
      });
    }
    // Schema failures make semantic checks unreliable.
    return { ok: false, errors, warnings };
  }

  const ix = indexModel(model);
  checkUniqueIds(model, errors);
  checkReferences(model, ix, errors);
  checkLinks(model, ix, errors, warnings);
  checkAddressing(model, ix, errors, warnings);
  checkConnectivity(model, ix, warnings);
  checkDependencies(model, ix, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

function dupes<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const dup = new Set<T>();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

function checkUniqueIds(model: Model, errors: Diagnostic[]): void {
  const groups: [string, Array<Record<string, unknown>>, string][] = [
    ['device', model.devices as unknown as Array<Record<string, unknown>>, 'id'],
    ['zone', model.zones as unknown as Array<Record<string, unknown>>, 'id'],
    ['site', model.sites as unknown as Array<Record<string, unknown>>, 'id'],
    ['vlan', model.vlans as unknown as Array<Record<string, unknown>>, 'id'],
    ['subnet', model.subnets as unknown as Array<Record<string, unknown>>, 'cidr'],
    ['external', (model.externals ?? []) as unknown as Array<Record<string, unknown>>, 'id'],
  ];
  for (const [kind, list, key] of groups) {
    for (const d of dupes(list.map((x) => x[key]))) {
      errors.push({
        code: 'DUPLICATE_ID',
        subject: `${kind}:${d}`,
        message: `Duplicate ${kind} ${key} "${d}"`,
        fix: `Give each ${kind} a unique ${key}`,
      });
    }
  }
  // Devices and externals share one namespace, because a dependency endpoint
  // resolves against both. A collision makes the endpoint ambiguous, and the
  // per-list check above cannot see across lists.
  const deviceIds = new Set(model.devices.map((d) => d.id));
  for (const e of model.externals ?? []) {
    if (deviceIds.has(e.id)) {
      errors.push({
        code: 'ID_COLLISION',
        subject: `external:${e.id}`,
        message: `"${e.id}" is both a device and an external; dependency endpoints could not tell them apart`,
        fix: 'Rename one of them',
      });
    }
  }
  for (const d of model.devices) {
    for (const n of dupes((d.interfaces ?? []).map((i) => i.name))) {
      errors.push({
        code: 'DUPLICATE_INTERFACE',
        subject: `${d.id}:${n}`,
        message: `Device "${d.id}" defines interface "${n}" more than once`,
      });
    }
  }
}

function checkReferences(model: Model, ix: ModelIndex, errors: Diagnostic[]): void {
  const ref = (kind: 'zone' | 'site', id: string | undefined, subject: string): void => {
    if (id === undefined) return;
    const pool = kind === 'zone' ? ix.zones : ix.sites;
    if (!pool.has(id)) {
      errors.push({
        code: 'UNKNOWN_REF',
        subject,
        message: `${subject} references ${kind} "${id}" which is not defined`,
        fix: `Add a ${kind} with id "${id}" or correct the reference`,
      });
    }
  };
  for (const d of model.devices) {
    ref('zone', d.zone, `device:${d.id}`);
    ref('site', d.site, `device:${d.id}`);
    for (const i of d.interfaces ?? []) ref('zone', (i as { zone?: string }).zone, `device:${d.id}:${i.name}`);
  }
  for (const z of model.zones) ref('site', z.site, `zone:${z.id}`);
  for (const v of model.vlans) ref('zone', v.zone, `vlan:${v.id}`);
  for (const r of model.routing) {
    for (const side of ['from', 'to'] as const) {
      if (!ix.devices.has(r[side])) {
        errors.push({
          code: 'UNKNOWN_REF',
          subject: `routing:${r.from}->${r.to}`,
          message: `Routing ${side} "${r[side]}" is not a defined device`,
        });
      }
    }
  }
  for (const d of model.devices) {
    for (const i of d.interfaces ?? []) {
      for (const vid of ifaceVlans(i)) {
        if (!ix.vlans.has(vid)) {
          errors.push({
            code: 'UNKNOWN_VLAN',
            subject: `${d.id}:${i.name}`,
            message: `Interface "${d.id}:${i.name}" uses VLAN ${vid} which is not declared under vlans:`,
            fix: `Add "- id: ${vid}" to vlans:`,
          });
        }
      }
    }
  }
}

export function ifaceVlans(i: NetInterface & { vlan?: number }): number[] {
  const out = new Set<number>();
  if (i.vlan !== undefined) out.add(i.vlan);
  for (const v of i.vlans ?? []) out.add(v);
  if (i.native_vlan !== undefined) out.add(i.native_vlan);
  if (i.mode === 'svi') {
    const n = Number(String(i.name).replace(/[^0-9]/g, ''));
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

function checkLinks(model: Model, ix: ModelIndex, errors: Diagnostic[], warnings: Diagnostic[]): void {
  const portUse = new Map<string, number>();
  model.links.forEach((l, n) => {
    const subject = `link[${n}] ${l.a} <-> ${l.b}`;
    for (const side of ['a', 'b'] as const) {
      const { device, iface } = parseEndpoint(l[side]);
      const dev = ix.devices.get(device);
      if (!dev) {
        errors.push({
          code: 'DANGLING_LINK',
          subject,
          message: `Link endpoint "${l[side]}" references unknown device "${device}"`,
        });
        continue;
      }
      if (iface) {
        if (!ix.ifaceOf(device, iface)) {
          errors.push({
            code: 'UNKNOWN_INTERFACE',
            subject,
            message: `Device "${device}" has no interface "${iface}"`,
            fix: `Declare it under devices[${device}].interfaces`,
          });
          continue;
        }
        const key = `${device}:${iface}`;
        portUse.set(key, (portUse.get(key) ?? 0) + 1);
      } else if (dev.role !== 'internet') {
        warnings.push({
          code: 'PORTLESS_LINK',
          subject,
          message: `Endpoint "${l[side]}" has no interface; L1 will show it without a port label`,
          fix: `Use "${device}:<interface>" for a full physical diagram`,
        });
      }
    }
    if (parseEndpoint(l.a).device === parseEndpoint(l.b).device) {
      warnings.push({ code: 'SELF_LINK', subject, message: `Link connects "${l.a}" to itself` });
    }
  });
  for (const [key, count] of portUse) {
    if (count > 1) {
      errors.push({
        code: 'PORT_REUSE',
        subject: key,
        message: `Physical port "${key}" is used by ${count} links`,
        fix: 'A physical port terminates exactly one cable; use a LAG or distinct ports',
      });
    }
  }
}

function checkAddressing(model: Model, ix: ModelIndex, errors: Diagnostic[], warnings: Diagnostic[]): void {
  const nets: { cidr: string; subject: string }[] = [];
  for (const v of model.vlans) if (v.subnet) nets.push({ cidr: v.subnet, subject: `vlan:${v.id}` });
  for (const s of model.subnets) nets.push({ cidr: s.cidr, subject: `subnet:${s.cidr}` });

  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      if (nets[i].cidr === nets[j].cidr) continue;
      if (overlaps(nets[i].cidr, nets[j].cidr)) {
        errors.push({
          code: 'SUBNET_OVERLAP',
          subject: `${nets[i].subject} / ${nets[j].subject}`,
          message: `${nets[i].cidr} overlaps ${nets[j].cidr}`,
          fix: 'Re-address one of them, or put them in different VRFs and model that explicitly',
        });
      }
    }
  }

  for (const v of model.vlans) {
    if (v.gateway && v.subnet && !contains(v.subnet, v.gateway)) {
      errors.push({
        code: 'GATEWAY_OUTSIDE_SUBNET',
        subject: `vlan:${v.id}`,
        message: `Gateway ${v.gateway} is outside VLAN ${v.id} subnet ${v.subnet}`,
      });
    }
    if (!v.subnet) {
      warnings.push({
        code: 'VLAN_WITHOUT_SUBNET',
        subject: `vlan:${v.id}`,
        message: `VLAN ${v.id} (${v.name}) has no subnet; it will not appear on L3`,
      });
    }
  }

  for (const d of model.devices) {
    for (const i of d.interfaces ?? []) {
      if (!i.ip) continue;
      const net = networkOf(i.ip);
      const match = nets.find((n) => sameNetwork(n.cidr, net));
      if (!match) {
        warnings.push({
          code: 'UNDECLARED_NETWORK',
          subject: `${d.id}:${i.name}`,
          message: `${i.ip} belongs to ${net}, which is not declared as a VLAN subnet or subnet`,
          fix: `Add "- cidr: ${net}" to subnets: so L3 can group it`,
        });
      }
    }
  }
}

function checkConnectivity(model: Model, ix: ModelIndex, warnings: Diagnostic[]): void {
  // The warning's claim is that the device floats *in the L1 diagram*. A model
  // with no cabling at all has no L1 diagram to float in — a portfolio of
  // systems, for instance — so the claim would be false for every device in
  // it. Absence of the whole layer is louder feedback than a warning per node.
  if (model.links.length === 0) return;

  const linked = new Set<string>();
  for (const l of model.links) {
    linked.add(parseEndpoint(l.a).device);
    linked.add(parseEndpoint(l.b).device);
  }
  for (const d of model.devices) {
    if (!linked.has(d.id) && d.role !== 'internet') {
      warnings.push({
        code: 'ISOLATED_DEVICE',
        subject: `device:${d.id}`,
        message: `Device "${d.id}" has no links and will float in the L1 diagram`,
      });
    }
  }
}

/* ---- dependencies ----------------------------------------------------- */

function checkDependencies(model: Model, ix: ModelIndex, errors: Diagnostic[], warnings: Diagnostic[]): void {
  const deps = model.dependencies ?? [];
  const referenced = new Set<string | null>();
  const consumes = new Set<string | null>();
  const provides = new Set<string | null>();

  deps.forEach((dep, n) => {
    const subject = `dependency[${n}] ${dep.from} -> ${dep.to}`;
    const ends: Record<string, DepEndpoint> = {};

    for (const side of ['from', 'to'] as const) {
      const r = resolveDepEndpoint(dep[side], ix);
      ends[side] = r;
      if (!r.kind) {
        errors.push({
          code: 'UNKNOWN_DEPENDENCY_ENDPOINT',
          subject,
          message: `Dependency ${side} "${dep[side]}" is neither a device nor an external system`,
          fix: `Declare it under devices: or externals:, or write "<id>:<service>"`,
        });
        continue;
      }
      referenced.add(r.holder);
      if (r.kind === 'external') (side === 'from' ? consumes : provides).add(r.holder);
      if (r.service && !ix.serviceOf(r.holder!, r.service)) {
        errors.push({
          code: 'UNKNOWN_SERVICE',
          subject,
          message: `"${r.holder}" declares no service named "${r.service}"`,
          fix: `Add "- name: ${r.service}" under ${r.holder}.services`,
        });
      }
    }

    if (ends.from.holder && ends.from.holder === ends.to.holder) {
      errors.push({
        code: 'SELF_DEPENDENCY',
        subject,
        message: `"${ends.from.holder}" is declared as depending on itself`,
        fix: 'A dependency records what one system needs from another',
      });
    }
  });

  const consumesAndProvides = [...consumes].filter((id) => provides.has(id));

  for (const cycle of hardCycles(deps, ix)) {
    warnings.push({
      code: 'DEPENDENCY_CYCLE',
      subject: `dependency:${cycle[0]}`,
      message: `Hard dependency cycle: ${cycle.join(' -> ')}`,
      fix: 'If this is real, say so in description:; nothing in the cycle can start without the rest',
    });
  }

  // The dep layer pins an external either above everything (it consumes) or
  // below everything (it provides). One that does both cannot be placed so
  // that every arrow still points downward, and the layer's only reading rule
  // would break silently.
  for (const id of consumesAndProvides) {
    warnings.push({
      code: 'EXTERNAL_BOTH_WAYS',
      subject: `external:${id}`,
      message: `External "${id}" is both a consumer and a provider, so the DEP layer cannot draw every arrow pointing downward`,
      fix: 'Split it into two externals, or model the consuming side as a device',
    });
  }

  for (const e of model.externals ?? []) {
    if (!referenced.has(e.id)) {
      warnings.push({
        code: 'UNUSED_EXTERNAL',
        subject: `external:${e.id}`,
        message: `External "${e.id}" is declared but no dependency points at it`,
        fix: 'Reference it from dependencies:, or remove it',
      });
    }
  }
}

/**
 * Cycles over hard dependencies only. Soft ones are excluded because a soft
 * cycle degrades rather than deadlocks, and reporting it would bury the case
 * that actually cannot boot.
 *
 * Plain three-colour DFS: white (absent), grey (on stack), black (done).
 * Roots are visited in declaration order so the reported cycle is stable.
 */
function hardCycles(deps: Model['dependencies'], ix: ModelIndex): string[][] {
  const out = new Map<string, string[]>();
  const holderOf = (ep: string): string | null => resolveDepEndpoint(ep, ix).holder;

  // A Set, so N identical declared rows do not become N redundant traversals.
  const adj = new Map<string, Set<string>>();
  const order: string[] = [];
  for (const d of deps) {
    if (d.strength !== 'hard') continue;
    const a = holderOf(d.from);
    const b = holderOf(d.to);
    if (!a || !b || a === b) continue;
    if (!adj.has(a)) { adj.set(a, new Set()); order.push(a); }
    if (!adj.has(b)) { adj.set(b, new Set()); order.push(b); }
    adj.get(a)!.add(b);
  }

  // Iterative rather than recursive: a long dependency chain is a plausible
  // model, and a validator that dies with a RangeError on one is worse than
  // no validator. The frame carries its own child iterator so the traversal
  // order is identical to the recursive form.
  const state = new Map<string, 'grey' | 'black'>();
  const stack: string[] = [];
  for (const root of order) {
    if (state.has(root)) continue;
    const frames: { id: string; next: Iterator<string> }[] = [{ id: root, next: (adj.get(root) ?? new Set<string>()).values() }];
    state.set(root, 'grey');
    stack.push(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const step = frame.next.next();
      if (step.done) {
        frames.pop();
        stack.pop();
        state.set(frame.id, 'black');
        continue;
      }
      const next = step.value;
      if (state.get(next) === 'grey') {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        if (!out.has(cycleKey(cycle))) out.set(cycleKey(cycle), cycle);
      } else if (!state.has(next)) {
        state.set(next, 'grey');
        stack.push(next);
        frames.push({ id: next, next: (adj.get(next) ?? new Set<string>()).values() });
      }
    }
  }
  return [...out.values()];
}

/**
 * Identify a cycle by its rotation, not by its set of members: a -> b -> c -> a
 * and a -> c -> b -> a run through the same three systems but are two
 * different outages, and collapsing them would hide one.
 */
function cycleKey(cycle: string[]): string {
  const ring = cycle.slice(0, -1);
  let at = 0;
  for (let i = 1; i < ring.length; i++) if (ring[i] < ring[at]) at = i;
  return ring.slice(at).concat(ring.slice(0, at)).join('|');
}

/* ---- IPv4 helpers ---------------------------------------------------- */

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc * 256 + Number(o)) >>> 0, 0) >>> 0;
}
export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function maskInt(bits: number): number {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}
export function networkOf(cidr: string): string {
  const [ip, bits] = cidr.split('/');
  const b = Number(bits);
  return `${intToIp((ipToInt(ip) & maskInt(b)) >>> 0)}/${b}`;
}
function sameNetwork(a: string, b: string): boolean {
  return networkOf(a) === networkOf(b);
}
export function contains(cidr: string, ip: string): boolean {
  const [net, bits] = cidr.split('/');
  const m = maskInt(Number(bits));
  return ((ipToInt(net) & m) >>> 0) === ((ipToInt(ip) & m) >>> 0);
}
function overlaps(a: string, b: string): boolean {
  const [na, ba] = a.split('/');
  const [nb, bb] = b.split('/');
  const bits = Math.min(Number(ba), Number(bb));
  const m = maskInt(bits);
  return ((ipToInt(na) & m) >>> 0) === ((ipToInt(nb) & m) >>> 0);
}

export function formatDiagnostics({ errors, warnings }: { errors: Diagnostic[]; warnings: Diagnostic[] }): string {
  const lines: string[] = [];
  for (const e of errors) lines.push(`  error  [${e.code}] ${e.message}${e.fix ? `\n         fix: ${e.fix}` : ''}`);
  for (const w of warnings) lines.push(`  warn   [${w.code}] ${w.message}${w.fix ? `\n         fix: ${w.fix}` : ''}`);
  return lines.join('\n');
}
