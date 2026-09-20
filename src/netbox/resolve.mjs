import { NetBoxError } from './client.mjs';
import { normalizeModel } from '../model/load.mjs';

/**
 * Turn NetBox into a netdia model.
 *
 * The whole point of this module is that it produces the *same plain object*
 * that parseModel() produces from YAML. Everything downstream — deriveLayer,
 * layoutGraph, renderSvg, the viewer — is a pure function over that object and
 * needs no knowledge that NetBox exists.
 *
 * Two resolutions, because they answer different questions at different
 * granularities and pretending they are one diagram would serve neither:
 *
 *   resolvePortfolio()  nodes are SYSTEMS (tenants), edges are dependencies.
 *                       This is the risk owner's view.
 *
 *   resolveSystem()     nodes are DEVICES of one system, edges are cables.
 *                       This is the engineer's view.
 */

/* ---- vocabulary mapping ----------------------------------------------- */

/**
 * NetBox device roles are free-form per installation; netdia's are a closed
 * enum. Match on the slug, then fall back to substrings, then to `appliance`.
 * Guessing beyond that would put a wrong glyph and a wrong tier on a box, and
 * a confidently wrong diagram is worse than a plain one.
 */
const ROLE_PATTERNS = [
  [/core/, 'core'],
  [/dist/, 'distribution'],
  [/access|acc-|edge-sw/, 'access'],
  [/wlc|wireless|wifi|\bap\b/, 'wireless'],
  [/firewall|fw|ftd|asa|palo/, 'firewall'],
  [/router|rtr|wan/, 'router'],
  [/balanc|\blb\b|f5/, 'loadbalancer'],
  [/hypervisor|esxi|vmware|proxmox/, 'hypervisor'],
  [/storage|san|nas/, 'storage'],
  [/server|node|srv|ise|dnac|psn|pan|mnt/, 'server'],
  [/pdu|ups|power/, 'appliance'],
  [/client|workstation|laptop/, 'client'],
];

export function mapRole(netboxRole) {
  const key = String(netboxRole ?? '').toLowerCase();
  for (const [re, role] of ROLE_PATTERNS) if (re.test(key)) return role;
  return 'appliance';
}

const VENDORS = {
  cisco: 'cisco', 'palo alto': 'paloalto', paloalto: 'paloalto', fortinet: 'fortinet',
  juniper: 'juniper', arista: 'arista', microsoft: 'microsoft', vmware: 'vmware',
  proxmox: 'proxmox', aws: 'aws', azure: 'azure', linux: 'linux', redhat: 'linux',
};

export function mapVendor(manufacturer) {
  return VENDORS[String(manufacturer ?? '').toLowerCase()] ?? 'generic';
}

/** netdia speeds are an enum; NetBox reports kbps and an interface type. */
const SPEEDS = [
  [400_000_000, '400G'], [100_000_000, '100G'], [40_000_000, '40G'],
  [25_000_000, '25G'], [10_000_000, '10G'], [5_000_000, '5G'],
  [2_500_000, '2.5G'], [1_000_000, '1G'], [100_000, '100M'],
];

export function mapSpeed(kbps, ifaceType) {
  if (kbps) {
    for (const [rate, label] of SPEEDS) if (kbps >= rate) return label;
  }
  const t = String(ifaceType ?? '');
  const m = t.match(/^(\d+)(g|gbase|base)/i);
  if (m) {
    const n = Number(m[1]);
    if (t.startsWith('1000base')) return '1G';
    for (const [, label] of SPEEDS) if (label === `${n}G`) return label;
  }
  if (t.startsWith('1000base')) return '1G';
  if (t.startsWith('100base')) return '100M';
  return undefined;
}

/** Physical medium, read off the interface type NetBox already records. */
export function mapMedia(ifaceType) {
  const t = String(ifaceType ?? '').toLowerCase();
  if (!t) return 'copper';
  if (t.includes('virtual') || t.includes('lag') || t.includes('bridge')) return 'virtual';
  if (t.includes('ieee802.11') || t.includes('wireless')) return 'wireless';
  if (/base-(t|tx)\b/.test(t) || t.includes('base-t')) return 'copper';
  if (/base-(x|sr|lr|er|zr|cr|sx|lx)/.test(t) || t.includes('sfp') || t.includes('qsfp')) return 'fiber';
  return 'copper';
}

/** 802.1Q mode plus a couple of NetBox flags map onto netdia's interface mode. */
export function mapMode(iface) {
  if (iface.mgmt_only) return 'mgmt';
  const mode = iface.mode?.value ?? iface.mode;
  if (mode === 'access') return 'access';
  if (mode === 'tagged' || mode === 'tagged-all') return 'trunk';
  const type = String(iface.type?.value ?? '');
  if (type === 'virtual' && /^(vlan|irb|svi)/i.test(iface.name)) return 'svi';
  if (/^(lo|loopback)/i.test(iface.name)) return 'loopback';
  return undefined; // let netdia's own inferMode decide
}

/* ---- portfolio: systems and what they need ---------------------------- */

/**
 * Tiers place consumers above providers so every dependency arrow points
 * down, which is the dep layer's one reading rule. Group membership is the
 * only signal NetBox carries for this, and it is a good one: a business
 * service sits on a platform service sits on infrastructure.
 */
const GROUP_TIER = {
  forretningstjenester: 1,
  plattformtjenester: 4,
  infrastruktur: 7,
};
const GROUP_ROLE = {
  forretningstjenester: 'service',
  plattformtjenester: 'server',
  infrastruktur: 'core',
};

export async function resolvePortfolio(client, { title = 'Systemportefølje' } = {}) {
  const tenants = await client.tenants();
  if (tenants.length === 0) {
    throw new NetBoxError(
      'NetBox has no tenants, so there is no system catalogue to draw.\n' +
        '  Systems are modelled as tenants; see seed_systems.py.',
    );
  }

  const bySlug = new Map(tenants.map((t) => [t.slug, t]));
  const groupOf = (t) => t.group?.slug ?? 'plattformtjenester';

  const devices = tenants.map((t) => {
    const cf = t.custom_field_data ?? t.custom_fields ?? {};
    const group = groupOf(t);
    const deps = cf.dependencies ?? [];
    const crit = cf.criticality?.value ?? cf.criticality;
    return {
      id: t.slug,
      label: t.name,
      role: GROUP_ROLE[group] ?? 'server',
      vendor: 'generic',
      tier: GROUP_TIER[group] ?? 4,
      zone: group,
      // The risk card. These are the facts a service owner is accountable for,
      // and they ride the existing tags/notes rendering unchanged.
      tags: [crit, cf.environment?.value ?? cf.environment].filter(Boolean),
      notes: [
        cf.owner_business && `Forretningseier: ${cf.owner_business}`,
        cf.owner_technical && `Teknisk eier: ${cf.owner_technical}`,
        cf.rto && `RTO: ${cf.rto}`,
        cf.rpo && `RPO: ${cf.rpo}`,
        cf.reviewed ? `Sist gjennomgått: ${cf.reviewed}` : 'Aldri gjennomgått',
        t.description,
      ].filter(Boolean).join(' · ') || undefined,
      // Each distinct thing this system offers becomes a service, so a
      // dependency can name what it actually consumes.
      services: [...new Set(
        tenants.flatMap((o) => (o.custom_field_data ?? o.custom_fields ?? {}).dependencies ?? [])
          .filter((d) => d.to === t.slug && d.service)
          .map((d) => d.service),
      )].map((name) => ({ name })),
      _deps: deps,
    };
  });

  const groups = await client.tenantGroups();
  const zones = groups.map((g) => ({
    id: g.slug,
    label: g.name,
    kind: g.slug === 'infrastruktur' ? 'internal' : g.slug === 'forretningstjenester' ? 'trust' : 'mgmt',
  }));

  const dependencies = [];
  const dangling = [];
  for (const d of devices) {
    for (const dep of d._deps) {
      if (!bySlug.has(dep.to)) {
        dangling.push(`${d.id} → ${dep.to}`);
        continue;
      }
      // A JSON Schema can validate the shape of `to` but cannot look it up.
      // Resolving against the real catalogue is this module's job.
      const target = devices.find((x) => x.id === dep.to);
      const named = dep.service && target.services.some((s) => s.name === dep.service);
      dependencies.push({
        from: d.id,
        to: named ? `${dep.to}:${dep.service}` : dep.to,
        kind: dep.kind,
        strength: dep.strength,
        ...(dep.why ? { description: dep.why } : {}),
      });
    }
    delete d._deps;
  }

  return {
    model: normalizeModel({
      meta: {
        title,
        subtitle: 'Systemer og hva de trenger for å virke',
        owner: 'NetBox',
        updated: new Date().toISOString().slice(0, 10),
      },
      sites: [],
      zones,
      devices,
      links: [],
      vlans: [],
      subnets: [],
      routing: [],
      externals: [],
      dependencies,
      layout: {},
    }),
    dangling,
  };
}

/* ---- one system: the devices it is made of ---------------------------- */

export async function resolveSystem(client, slug) {
  const tenants = await client.tenants();
  const tenant = tenants.find((t) => t.slug === slug);
  if (!tenant) {
    throw new NetBoxError(
      `No tenant "${slug}" in NetBox. Systems are tenants; available: ` +
        tenants.map((t) => t.slug).sort().join(', '),
    );
  }

  const own = await client.devices({ tenant: slug });
  if (own.length === 0) {
    throw new NetBoxError(
      `Tenant "${slug}" owns no devices, so there is no physical layer to draw.\n` +
        '  Assign devices to the system with Device.tenant.',
    );
  }

  const ownIds = new Set(own.map((d) => d.id));
  const ifaces = await client.interfaces({ tenant: slug });

  // Devices this system is cabled to but does not own. Without them every
  // uplink would dangle, and an L1 diagram whose cables end in mid-air is
  // worse than no L1 diagram.
  const neighbourIds = new Set();
  for (const i of ifaces) {
    for (const ep of i.connected_endpoints ?? []) {
      const id = ep.device?.id;
      if (id && !ownIds.has(id)) neighbourIds.add(id);
    }
  }
  const neighbours = neighbourIds.size
    ? (await client.devices({ id: [...neighbourIds] })).filter((d) => neighbourIds.has(d.id))
    : [];

  const tenantOf = new Map();
  for (const d of [...own, ...neighbours]) tenantOf.set(d.name, d.tenant?.slug ?? null);

  const deviceOf = (d, owned) => ({
    id: d.name,
    label: d.name,
    role: mapRole(d.role?.slug ?? d.role?.name),
    vendor: mapVendor(d.device_type?.manufacturer?.name),
    model: d.device_type?.model,
    site: d.site?.slug,
    zone: d.tenant?.slug ?? 'ukjent',
    mgmt_ip: d.primary_ip4?.display ?? d.primary_ip4?.address,
    notes: [d.description, owned ? null : `Tilhører ${d.tenant?.name ?? 'ukjent system'}`]
      .filter(Boolean).join(' · ') || undefined,
    interfaces: [],
  });

  const devices = [
    ...own.map((d) => deviceOf(d, true)),
    ...neighbours.map((d) => deviceOf(d, false)),
  ];
  const byName = new Map(devices.map((d) => [d.id, d]));

  const neighbourIfaces = neighbourIds.size
    ? await client.interfaces({ device_id: [...neighbourIds] })
    : [];

  const vlanIds = new Map();
  for (const i of [...ifaces, ...neighbourIfaces]) {
    const dev = byName.get(i.device?.name);
    if (!dev) continue;
    const vlans = (i.tagged_vlans ?? []).map((v) => v.vid);
    const untagged = i.untagged_vlan?.vid;
    for (const v of i.tagged_vlans ?? []) vlanIds.set(v.vid, v);
    if (i.untagged_vlan) vlanIds.set(i.untagged_vlan.vid, i.untagged_vlan);

    dev.interfaces.push({
      name: i.name,
      ...(mapMode(i) ? { mode: mapMode(i) } : {}),
      ...(mapSpeed(i.speed, i.type?.value) ? { speed: mapSpeed(i.speed, i.type?.value) } : {}),
      ...(untagged !== undefined ? { vlan: untagged } : {}),
      ...(vlans.length ? { vlans: [...new Set([...vlans, untagged].filter((v) => v !== undefined))] } : {}),
      ...(untagged !== undefined && vlans.length ? { native_vlan: untagged } : {}),
      ...(i.vrf?.name ? { vrf: i.vrf.name } : {}),
      ...(i.lag?.name ? { lag: i.lag.name } : {}),
      ...(i.enabled === false ? { shutdown: true } : {}),
      ...(i.description ? { description: i.description } : {}),
    });
  }

  // Addresses, attached to the interfaces they belong to.
  const ips = await client.ipAddresses({ limit: 500 });
  for (const ip of ips) {
    if (ip.assigned_object_type !== 'dcim.interface') continue;
    const devName = ip.assigned_object?.device?.name;
    const dev = byName.get(devName);
    if (!dev) continue;
    const iface = dev.interfaces.find((x) => x.name === ip.assigned_object.name);
    // netdia carries one address per interface; NetBox permits several. Keep
    // the first and say so rather than silently dropping the rest.
    if (iface && !iface.ip) iface.ip = ip.address;
    else if (iface) iface.description = [iface.description, `+ ${ip.address}`].filter(Boolean).join(' ');
  }

  // Cables, traced. connected_endpoints follows through patch panels, so a
  // pass-through does not appear as a device in the middle of every run.
  const links = [];
  const seen = new Set();
  for (const i of [...ifaces, ...neighbourIfaces]) {
    const a = i.device?.name;
    if (!byName.has(a)) continue;
    for (const ep of i.connected_endpoints ?? []) {
      const b = ep.device?.name;
      if (!byName.has(b)) continue;
      const key = [`${a}:${i.name}`, `${b}:${ep.name}`].sort().join('~');
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        a: `${a}:${i.name}`,
        b: `${b}:${ep.name}`,
        media: mapMedia(i.type?.value),
        ...(mapSpeed(i.speed, i.type?.value) ? { speed: mapSpeed(i.speed, i.type?.value) } : {}),
      });
    }
  }

  const prefixes = await client.prefixes({ limit: 500 });
  const vlans = [...vlanIds.values()].map((v) => {
    const pfx = prefixes.find((p) => p.vlan?.vid === v.vid);
    return {
      id: v.vid,
      name: v.name,
      ...(pfx ? { subnet: pfx.prefix } : {}),
    };
  });

  // Only the sites the drawn devices actually sit in. Declaring NetBox's
  // whole site list would put empty references in every model.
  const siteOf = new Map();
  for (const d of [...own, ...neighbours]) {
    if (d.site?.slug) siteOf.set(d.site.slug, d.site.name);
  }
  const sites = [...siteOf].map(([id, label]) => ({ id, label, kind: 'dc' }));

  const usedZones = new Set(devices.map((d) => d.zone));
  const zones = [...usedZones].map((z) => ({
    id: z,
    label: tenants.find((t) => t.slug === z)?.name ?? z,
    kind: z === slug ? 'trust' : 'internal',
  }));

  const cf = tenant.custom_field_data ?? tenant.custom_fields ?? {};
  return {
    model: normalizeModel({
      meta: {
        title: tenant.name,
        subtitle: [cf.criticality?.value ?? cf.criticality, cf.environment?.value ?? cf.environment]
          .filter(Boolean).join(' · ') || undefined,
        owner: cf.owner_technical ?? undefined,
        updated: new Date().toISOString().slice(0, 10),
      },
      sites,
      zones,
      devices,
      links,
      vlans,
      subnets: prefixes
        .filter((p) => !p.vlan)
        .map((p) => ({ cidr: p.prefix, ...(p.description ? { name: p.description } : {}) })),
      routing: [],
      externals: [],
      dependencies: [],
      layout: {},
    }),
    tenant,
    stats: { owned: own.length, neighbours: neighbours.length, links: links.length },
  };
}
