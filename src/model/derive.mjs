import { parseEndpoint, indexModel, resolveDepEndpoint } from './load.mjs';
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

/**
 * The three structural layers. Every model has them, so the invariants that
 * hold for "all layers" — every node is placed, every edge carries detail —
 * are expressed against this list.
 */
export const LAYERS = ['l1', 'l2', 'l3'];

/** ...plus the layers that exist only when the model carries the facts. */
export const ALL_LAYERS = [...LAYERS, 'dep'];

/**
 * The layers worth drawing for this model.
 *
 * A layer appears only when the model carries the facts to draw it. An empty
 * dependency diagram is not an empty drawing, it is a claim that nothing
 * depends on anything — and the same argument applies to the other three. A
 * portfolio of systems has no cables; a pure cabling record has no routing.
 * Emitting the tab anyway would assert an absence the model never stated.
 */
export function layersFor(model) {
  const has = {
    l1: (model.links ?? []).length > 0,
    l2: (model.vlans ?? []).length > 0
      || (model.devices ?? []).some((d) => (d.interfaces ?? []).some((i) => ifaceVlans(i).length > 0)),
    l3: (model.subnets ?? []).length > 0
      || (model.routing ?? []).length > 0
      || (model.devices ?? []).some((d) => (d.interfaces ?? []).some((i) => i.ip)),
    dep: (model.dependencies ?? []).length > 0,
  };
  return ALL_LAYERS.filter((l) => has[l]);
}

export function deriveLayer(model, layer) {
  switch (layer) {
    case 'l1': return deriveL1(model);
    case 'l2': return deriveL2(model);
    case 'l3': return deriveL3(model);
    case 'dep': return deriveDep(model);
    default: throw new Error(`Unknown layer "${layer}". Use ${ALL_LAYERS.join(', ')}.`);
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
  const ix = indexModel(model);
  const nodes = model.devices.map(deviceNode);
  const byLag = new Map();
  const edges = [];

  // The two ends of a cable only agree on a VLAN if both interfaces carry it;
  // the union would claim the cable transports VLANs one end cannot see.
  const sharedVlans = (a, b) => {
    const ia = a.iface ? ix.ifaceOf(a.device, a.iface) : null;
    const ib = b.iface ? ix.ifaceOf(b.device, b.iface) : null;
    if (!ia || !ib) return [];
    const right = new Set(ifaceVlans(ib));
    return ifaceVlans(ia).filter((v) => right.has(v)).sort((x, y) => x - y);
  };

  model.links.forEach((l, n) => {
    const a = parseEndpoint(l.a);
    const b = parseEndpoint(l.b);
    const key = l.lag ? `lag:${[a.device, b.device].sort().join('~')}:${l.lag}` : null;
    if (key && byLag.has(key)) {
      const e = byLag.get(key);
      e.detail.memberLinks.push({
        aPort: a.iface,
        bPort: b.iface,
        speed: l.speed,
        media: l.media ?? 'copper',
      });
      e.members = e.detail.memberLinks.length;
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
      kind: 'cable',
      // Only facts the edge does not already carry. Media, speed and the two
      // port names live on the edge itself; repeating them here would give the
      // viewer two places to read the same thing from.
      detail: {
        lag: l.lag ?? null,
        memberLinks: l.lag
          ? [{ aPort: a.iface, bPort: b.iface, speed: l.speed, media: l.media ?? 'copper' }]
          : null,
        vlans: sharedVlans(a, b),
      },
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
        kind: 'vlan-member',
        detail: {
          vlan: vid,
          vlanName: v?.name,
          subnet: v?.subnet,
          gateway: v?.gateway,
          tagged: entry.tagged,
          svi: entry.svi,
          // The drawn label collapses to "N ports"; the inspector has room
          // for the real list and is the only place it survives.
          ports: entry.ports.slice(),
        },
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
        kind: 'attachment',
        detail: {
          cidr: net.detail.cidr,
          gateway: !!isGateway,
          vrf: i.vrf ?? net.detail.vrf,
          networkName: net.detail.name,
        },
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
      kind: 'adjacency',
      detail: {
        routingKind: r.kind ?? 'static',
        detail: r.detail,
        bidirectional: !!r.bidirectional,
      },
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

/* ---- DEP: who needs whom --------------------------------------------- */

/**
 * Externals sit below every device role, because they are almost always what
 * something else depends on rather than the other way round. When one is a
 * consumer instead, it has to go above everything, or the arrow would run
 * upwards and contradict the one rule this layer documents: consumers on top.
 */
const EXTERNAL_PROVIDER_TIER = 8;
const EXTERNAL_CONSUMER_TIER = 0;

function externalNode(e, consumes) {
  return {
    id: e.id,
    label: e.label,
    sublabel: e.owner ?? e.kind ?? '',
    kind: 'external',
    role: 'external',
    vendor: 'generic',
    tier: consumes ? EXTERNAL_CONSUMER_TIER : EXTERNAL_PROVIDER_TIER,
    // externalCard draws no badges; the kind is already the sublabel.
    badges: [],
    detail: {
      external: true,
      kind: e.kind,
      owner: e.owner,
      url: e.url,
      notes: e.notes,
      tags: e.tags,
      services: e.services ?? [],
    },
  };
}

function deriveDep(model) {
  const ix = indexModel(model);
  const deps = model.dependencies ?? [];

  const holders = new Set();
  const consumers = new Set();
  for (const d of deps) {
    const from = resolveDepEndpoint(d.from, ix);
    const to = resolveDepEndpoint(d.to, ix);
    if (from.holder) { holders.add(from.holder); consumers.add(from.holder); }
    if (to.holder) holders.add(to.holder);
  }

  // Declaration order, not discovery order: ELK is seeded on model order
  // (elk.layered.considerModelOrder) and freeze writes the result to disk, so
  // a traversal-dependent order would churn both the drawing and the diff.
  const nodes = [
    ...model.devices.filter((d) => holders.has(d.id)).map(deviceNode),
    ...(model.externals ?? [])
      .filter((e) => holders.has(e.id))
      .map((e) => externalNode(e, consumers.has(e.id))),
  ];

  // Several services between the same pair collapse into one edge, exactly as
  // parallel cables collapse into a LAG. Two lines between the same two boxes
  // land on the same orthogonal route and would draw on top of each other.
  // `kind` is part of the key because it picks the edge's colour: merging
  // "auth" with "logging" would leave that undecidable.
  const merged = new Map();
  const edges = [];

  const labelFor = (services, kind) => {
    if (services.length === 0) return kind;
    if (services.length === 1) return services[0].name;
    return `${services[0].name} +${services.length - 1}`;
  };

  deps.forEach((dep, n) => {
    const from = resolveDepEndpoint(dep.from, ix);
    const to = resolveDepEndpoint(dep.to, ix);
    if (!from.holder || !to.holder) return;

    // The service object is the provider's own declaration, not a copy of the
    // dependency row: the reason lives once, in detail.descriptions.
    const service = to.service
      ? { name: to.service, ...(ix.serviceOf(to.holder, to.service) ?? {}) }
      : null;

    const key = `${from.holder}~${to.holder}~${dep.kind}~${dep.strength}`;
    if (merged.has(key)) {
      const e = merged.get(key);
      if (service) e.detail.services.push(service);
      if (dep.description) e.detail.descriptions.push(dep.description);
      e.label = labelFor(e.detail.services, dep.kind);
      return;
    }

    const edge = {
      id: `dep-${n}`,
      a: from.holder,
      b: to.holder,
      aPort: null,
      bPort: null,
      // A service name is prose, not port data, so it rides the centred
      // proportional label chip rather than a monospace port chip — and it
      // never reaches usedPorts(), which draws physical faceplates.
      label: labelFor(service ? [service] : [], dep.kind),
      media: `dep-${dep.strength}`,
      directed: true,
      kind: 'dependency',
      detail: {
        dependencyKind: dep.kind,
        strength: dep.strength,
        // Only what the edge does not already carry. a and b are the two
        // systems and the label is the service, so what remains is the
        // provider's service declarations and the author's reasons.
        services: service ? [service] : [],
        descriptions: dep.description ? [dep.description] : [],
      },
    };
    merged.set(key, edge);
    edges.push(edge);
  });

  return {
    layer: 'dep',
    title: model.meta.title,
    meta: model.meta,
    subtitle: 'Dependencies — what each system needs to work',
    // Externals can never be members of a zone, and a node sitting inside a
    // hull it does not belong to invalidates every hull on the drawing. An
    // honest absence beats a zone box that vanishes depending on layout.
    groups: [],
    nodes,
    edges,
    legend: [
      { kind: 'dep-hard', label: 'Hard — consumer stops without it' },
      { kind: 'dep-soft', label: 'Soft — degraded but running' },
      { kind: 'external', label: 'External system' },
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
