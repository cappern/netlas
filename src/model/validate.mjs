import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { parseEndpoint, indexModel } from './load.mjs';

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL('./model.schema.json', import.meta.url)), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

/**
 * @returns {{ ok: boolean, errors: Diagnostic[], warnings: Diagnostic[] }}
 * Diagnostic = { code, subject, message, fix? }
 */
export function validateModel(model) {
  const errors = [];
  const warnings = [];

  if (!validateSchema(model)) {
    for (const e of validateSchema.errors) {
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

  return { ok: errors.length === 0, errors, warnings };
}

function dupes(values) {
  const seen = new Set();
  const dup = new Set();
  for (const v of values) (seen.has(v) ? dup : seen).add(v);
  return [...dup];
}

function checkUniqueIds(model, errors) {
  for (const [kind, list, key] of [
    ['device', model.devices, 'id'],
    ['zone', model.zones, 'id'],
    ['site', model.sites, 'id'],
    ['vlan', model.vlans, 'id'],
    ['subnet', model.subnets, 'cidr'],
  ]) {
    for (const d of dupes(list.map((x) => x[key]))) {
      errors.push({
        code: 'DUPLICATE_ID',
        subject: `${kind}:${d}`,
        message: `Duplicate ${kind} ${key} "${d}"`,
        fix: `Give each ${kind} a unique ${key}`,
      });
    }
  }
  for (const d of model.devices) {
    for (const n of dupes(d.interfaces.map((i) => i.name))) {
      errors.push({
        code: 'DUPLICATE_INTERFACE',
        subject: `${d.id}:${n}`,
        message: `Device "${d.id}" defines interface "${n}" more than once`,
      });
    }
  }
}

function checkReferences(model, ix, errors) {
  const ref = (kind, id, subject) => {
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
    for (const i of d.interfaces) ref('zone', i.zone, `device:${d.id}:${i.name}`);
  }
  for (const z of model.zones) ref('site', z.site, `zone:${z.id}`);
  for (const v of model.vlans) ref('zone', v.zone, `vlan:${v.id}`);
  for (const r of model.routing) {
    for (const side of ['from', 'to']) {
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
    for (const i of d.interfaces) {
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

export function ifaceVlans(i) {
  const out = new Set();
  if (i.vlan !== undefined) out.add(i.vlan);
  for (const v of i.vlans ?? []) out.add(v);
  if (i.native_vlan !== undefined) out.add(i.native_vlan);
  if (i.mode === 'svi') {
    const n = Number(String(i.name).replace(/[^0-9]/g, ''));
    if (Number.isInteger(n) && n > 0) out.add(n);
  }
  return [...out];
}

function checkLinks(model, ix, errors, warnings) {
  const portUse = new Map();
  model.links.forEach((l, n) => {
    const subject = `link[${n}] ${l.a} <-> ${l.b}`;
    for (const side of ['a', 'b']) {
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

function checkAddressing(model, ix, errors, warnings) {
  const nets = [];
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
    for (const i of d.interfaces) {
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

function checkConnectivity(model, ix, warnings) {
  const linked = new Set();
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

/* ---- IPv4 helpers ---------------------------------------------------- */

export function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc * 256 + Number(o)) >>> 0, 0) >>> 0;
}
export function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
}
function maskInt(bits) {
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}
export function networkOf(cidr) {
  const [ip, bits] = cidr.split('/');
  const b = Number(bits);
  return `${intToIp((ipToInt(ip) & maskInt(b)) >>> 0)}/${b}`;
}
function sameNetwork(a, b) {
  return networkOf(a) === networkOf(b);
}
export function contains(cidr, ip) {
  const [net, bits] = cidr.split('/');
  const m = maskInt(Number(bits));
  return ((ipToInt(net) & m) >>> 0) === ((ipToInt(ip) & m) >>> 0);
}
function overlaps(a, b) {
  const [na, ba] = a.split('/');
  const [nb, bb] = b.split('/');
  const bits = Math.min(Number(ba), Number(bb));
  const m = maskInt(bits);
  return ((ipToInt(na) & m) >>> 0) === ((ipToInt(nb) & m) >>> 0);
}

export function formatDiagnostics({ errors, warnings }) {
  const lines = [];
  for (const e of errors) lines.push(`  error  [${e.code}] ${e.message}${e.fix ? `\n         fix: ${e.fix}` : ''}`);
  for (const w of warnings) lines.push(`  warn   [${w.code}] ${w.message}${w.fix ? `\n         fix: ${w.fix}` : ''}`);
  return lines.join('\n');
}
