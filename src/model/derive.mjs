import { parseEndpoint, indexModel } from './load.mjs';
import { ifaceVlans, contains, networkOf } from './validate.mjs';

/**
 * Every layer compiles to the same neutral graph shape so that layout,
 * the SVG renderer, and the 3D scene all consume one contract.
 *
 * Graph = {
 *   layer, title, subtitle,
 *   groups: [{ id, label, kind, nodes: [nodeId] }],
 *   nodes:  [{ id, label, sublabel, kind, role, vendor, tier, badges, detail }],
 *   edges:  [{ id, a, b, aPort, bPort, label, media, speed, style, directed }],
 *   legend: [{ kind, label }]
 * }
 */

export const LAYERS = ['l1', 'l2', 'l3'];

export function deriveLayer(model, layer) {
  switch (layer) {
    case 'l1': return deriveL1(model);
    case 'l2': return deriveL2(model);
    case 'l3': return deriveL3(model);
    default: throw new Error(`Unknown layer "${layer}". Use l1, l2 or l3.`);
  }
}

/* ---- role tiers: the vertical hierarchy of a network ----------------- */

export const ROLE_TIER = {
  internet: 0,
  wan: 1,
  router: 1,
  firewall: 2,
  loadbalancer: 3,
  core: 3,
  distribution: 4,
  access: 5,
  wireless: 5,
  hypervisor: 6,
  server: 6,
  storage: 6,
  container: 6,
  service: 6,
  appliance: 6,
  client: 7,
};

function tierOf(device) {
  return device.tier ?? ROLE_TIER[device.role] ?? 6;
}

function zoneGroups(model, memberIds) {
  const present = new Set(memberIds);
  return model.zones
    .map((z) => ({
      id: `zone:${z.id}`,
      label: z.label,
      kind: z.kind ?? 'internal',
      nodes: model.devices.filter((d) => d.zone === z.id && present.has(d.id)).map((d) => d.id),
    }))
    .filter((g) => g.nodes.length > 0);
}

function deviceNode(d) {
  const badges = [];
  if (d.stack && d.stack > 1) badges.push(`x${d.stack}`);
  return {
    id: d.id,
    label: d.label,
    sublabel: d.model ?? d.os ?? '',
    kind: 'device',
    role: d.role,
    vendor: d.vendor,
    tier: tierOf(d),
    badges,
    detail: {
      role: d.role,
      vendor: d.vendor,
      model: d.model,
      os: d.os,
      site: d.site,
      zone: d.zone,
      mgmt_ip: d.mgmt_ip,
      notes: d.notes,
      tags: d.tags,
      interfaces: d.interfaces.map((i) => ({
        name: i.name,
        mode: i.mode,
        speed: i.speed,
        ip: i.ip,
        vlans: ifaceVlans(i),
        description: i.description,
      })),
      services: d.services ?? [],
    },
  };
}

/* ---- L1: physical cabling -------------------------------------------- */

function deriveL1(model) {
  const nodes = model.devices.map(deviceNode);
  const byLag = new Map();
  const edges = [];

  model.links.forEach((l, n) => {
    const a = parseEndpoint(l.a);
    const b = parseEndpoint(l.b);
    const key = l.lag ? `lag:${[a.device, b.device].sort().join('~')}:${l.lag}` : null;
    if (key && byLag.has(key)) {
      const e = byLag.get(key);
      e.members += 1;
      e.label = `${l.lag} (${e.members} x ${l.speed ?? '?'})`;
      return;
    }
    const edge = {
      id: `l1-${n}`,
      a: a.device,
      b: b.device,
      aPort: a.iface,
      bPort: b.iface,
      // Speed is deliberately not an edge label: it is already carried by the
      // port strip and the inspector, and repeating it on every cable turns
      // the drawing into a field of chips.
      label: l.label ?? '',
      media: l.media ?? 'copper',
      speed: l.speed,
      style: l.lag ? 'lag' : 'single',
      members: 1,
      directed: false,
    };
    if (key) {
      edge.label = `${l.lag} (1 x ${l.speed ?? '?'})`;
      byLag.set(key, edge);
    }
    edges.push(edge);
  });

  return {
    layer: 'l1',
    title: model.meta.title,
    meta: model.meta,
    subtitle: 'Layer 1 — physical cabling and ports',
    groups: zoneGroups(model, nodes.map((n) => n.id)),
    nodes,
    edges,
    legend: legendFromEdges(edges, 'media'),
  };
}

/* ---- L2: VLAN membership map ----------------------------------------- */

function deriveL2(model) {
  const ix = indexModel(model);
  const members = new Map(); // vlanId -> [{ device, ports, tagged }]

  for (const d of model.devices) {
    for (const i of d.interfaces) {
      const tagged = i.mode === 'trunk';
      for (const vid of ifaceVlans(i)) {
        if (i.mode === 'svi' && !ix.vlans.has(vid)) continue;
        if (!members.has(vid)) members.set(vid, new Map());
        const perDevice = members.get(vid);
        if (!perDevice.has(d.id)) perDevice.set(d.id, { ports: [], tagged: false, svi: false });
        const entry = perDevice.get(d.id);
        if (i.mode === 'svi') entry.svi = true;
        else entry.ports.push(i.name);
        if (tagged) entry.tagged = true;
      }
    }
  }

  const usedDevices = new Set();
  for (const perDevice of members.values()) for (const id of perDevice.keys()) usedDevices.add(id);

  const nodes = model.devices.filter((d) => usedDevices.has(d.id)).map(deviceNode);
  const edges = [];

  const vlanIds = [...members.keys()].sort((a, b) => a - b);
  for (const vid of vlanIds) {
    const v = ix.vlans.get(vid);
    nodes.push({
      id: `vlan:${vid}`,
      label: `VLAN ${vid}`,
      sublabel: v?.name ?? '',
      kind: 'vlan',
      role: 'vlan',
      vendor: 'generic',
      tier: 4,
      badges: v?.subnet ? [v.subnet] : [],
      detail: {
        vlan: vid,
        name: v?.name,
        subnet: v?.subnet,
        gateway: v?.gateway,
        zone: v?.zone,
        purpose: v?.purpose,
        members: [...members.get(vid).keys()],
      },
    });

    for (const [devId, entry] of members.get(vid)) {
      // An SVI is the gateway for the whole VLAN, so listing the trunk ports
      // that also carry it adds length without adding meaning.
      const label = entry.svi
        ? 'SVI'
        : entry.ports.length > 2
          ? `${entry.ports.length} ports`
          : entry.ports.join(', ');
      edges.push({
        id: `l2-${vid}-${devId}`,
        a: devId,
        b: `vlan:${vid}`,
        aPort: null,
        bPort: null,
        label,
        media: entry.tagged ? 'tagged' : 'untagged',
        style: entry.svi ? 'gateway' : 'member',
        directed: false,
      });
    }
  }

  const groups = zoneGroups(model, nodes.filter((n) => n.kind === 'device').map((n) => n.id));
  for (const g of groups) {
    for (const v of model.vlans) {
      if (v.zone && `zone:${v.zone}` === g.id && members.has(v.id)) g.nodes.push(`vlan:${v.id}`);
    }
  }

  return {
    layer: 'l2',
    title: model.meta.title,
    meta: model.meta,
    subtitle: 'Layer 2 — VLANs and broadcast domains',
    groups,
    nodes,
    edges,
    legend: [
      { kind: 'tagged', label: 'Tagged (trunk)' },
      { kind: 'untagged', label: 'Untagged (access)' },
      { kind: 'gateway', label: 'SVI / gateway' },
    ],
  };
}

/* ---- L3: routed topology --------------------------------------------- */

function deriveL3(model) {
  const ix = indexModel(model);

  const networks = new Map(); // cidr -> node
  const addNetwork = (cidr, meta) => {
    const net = networkOf(cidr);
    if (!networks.has(net)) {
      networks.set(net, {
        id: `net:${net}`,
        label: net,
        sublabel: meta?.name ?? '',
        kind: 'network',
        role: 'network',
        vendor: 'generic',
        tier: 4,
        badges: meta?.vrf ? [meta.vrf] : [],
        detail: { cidr: net, ...meta, attached: [] },
      });
    }
    return networks.get(net);
  };

  for (const v of model.vlans) {
    if (v.subnet) addNetwork(v.subnet, { name: v.name, vlan: v.id, gateway: v.gateway, vrf: v.vrf, zone: v.zone });
  }
  for (const s of model.subnets) {
    addNetwork(s.cidr, { name: s.name, gateway: s.gateway, vrf: s.vrf, zone: s.zone, dhcp: s.dhcp });
  }

  const edges = [];
  const routedDevices = new Map();

  for (const d of model.devices) {
    const routed = d.interfaces.filter((i) => i.ip);
    const isRouterish = ['internet', 'firewall', 'router', 'wan', 'core', 'loadbalancer'].includes(d.role);
    if (routed.length === 0 && !isRouterish) continue;
    routedDevices.set(d.id, d);

    for (const i of routed) {
      const net = addNetwork(i.ip, {});
      const isGateway =
        net.detail.gateway && i.ip.split('/')[0] === net.detail.gateway;
      net.detail.attached.push({ device: d.id, iface: i.name, ip: i.ip, gateway: !!isGateway });
      edges.push({
        id: `l3-${d.id}-${i.name}`,
        a: d.id,
        b: net.id,
        aPort: i.name,
        bPort: null,
        // The IP already identifies this attachment. Repeating the interface
        // name beside it doubles the label count for no new fact; it stays
        // available on the node card's port strip and in the inspector.
        showPorts: false,
        label: i.ip,
        media: isGateway ? 'gateway' : 'attached',
        style: isGateway ? 'gateway' : 'attached',
        vrf: i.vrf,
        directed: false,
      });
    }
  }

  for (const r of model.routing) {
    if (!routedDevices.has(r.from)) routedDevices.set(r.from, ix.devices.get(r.from));
    if (!routedDevices.has(r.to)) routedDevices.set(r.to, ix.devices.get(r.to));
    edges.push({
      id: `l3-route-${r.from}-${r.to}-${r.kind ?? 'static'}`,
      a: r.from,
      b: r.to,
      aPort: null,
      bPort: null,
      label: r.detail ?? (r.kind ?? 'static').toUpperCase(),
      media: 'routing',
      style: `route-${r.kind ?? 'static'}`,
      directed: !r.bidirectional,
    });
  }

  const nodes = [
    ...[...routedDevices.values()].filter(Boolean).map(deviceNode),
    ...networks.values(),
  ];

  const vrfs = new Map();
  for (const n of nodes) {
    const vrf = n.detail?.vrf;
    if (!vrf) continue;
    if (!vrfs.has(vrf)) vrfs.set(vrf, { id: `vrf:${vrf}`, label: `VRF ${vrf}`, kind: 'internal', nodes: [] });
    vrfs.get(vrf).nodes.push(n.id);
  }
  const groups = vrfs.size > 0
    ? [...vrfs.values()]
    : zoneGroups(model, nodes.filter((n) => n.kind === 'device').map((n) => n.id));

  return {
    layer: 'l3',
    title: model.meta.title,
    meta: model.meta,
    subtitle: 'Layer 3 — IP networks and routing',
    groups,
    nodes,
    edges,
    legend: [
      { kind: 'gateway', label: 'Default gateway' },
      { kind: 'attached', label: 'Attached interface' },
      { kind: 'routing', label: 'Routing adjacency' },
    ],
  };
}

function legendFromEdges(edges, key) {
  const labels = {
    copper: 'Copper',
    fiber: 'Fiber',
    virtual: 'Virtual',
    wireless: 'Wireless',
    wan: 'WAN circuit',
    console: 'Console',
  };
  const seen = [...new Set(edges.map((e) => e[key]).filter(Boolean))];
  return seen.map((k) => ({ kind: k, label: labels[k] ?? k }));
}
