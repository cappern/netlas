import test from 'node:test';
import assert from 'node:assert/strict';
import { NetBoxClient, NetBoxError, clientFromEnv } from '../src/netbox/client.mjs';
import {
  mapRole, mapVendor, mapSpeed, mapMedia, mapMode,
  resolvePortfolio, resolveSystem,
} from '../src/netbox/resolve.mjs';
import { validateModel } from '../src/model/validate.mjs';
import { deriveLayer, layersFor } from '../src/model/derive.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { getTheme } from '../src/theme/themes.mjs';

/* ---- vocabulary -------------------------------------------------------- */

test('NetBox device roles map onto netdia roles, and unknown ones do not guess', () => {
  assert.equal(mapRole('core-switch'), 'core');
  assert.equal(mapRole('access-switch'), 'access');
  assert.equal(mapRole('ise-psn'), 'server');
  assert.equal(mapRole('pdu'), 'appliance');
  assert.equal(mapRole('Firewall'), 'firewall');
  // A role netdia has no word for becomes the neutral one rather than a
  // plausible-looking wrong glyph on a box.
  assert.equal(mapRole('coffee-machine'), 'appliance');
  assert.equal(mapRole(undefined), 'appliance');
});

test('vendors fall back to generic instead of inventing a mark', () => {
  assert.equal(mapVendor('Cisco'), 'cisco');
  assert.equal(mapVendor('Palo Alto'), 'paloalto');
  assert.equal(mapVendor('APC'), 'generic');
  assert.equal(mapVendor(undefined), 'generic');
});

test('kbps and interface types both resolve to netdia speed steps', () => {
  assert.equal(mapSpeed(1_000_000, null), '1G');
  assert.equal(mapSpeed(10_000_000, null), '10G');
  assert.equal(mapSpeed(null, '1000base-t'), '1G');
  assert.equal(mapSpeed(null, '10gbase-x-sfpp'), '10G');
  assert.equal(mapSpeed(null, 'virtual'), undefined);
  // A rate between steps reports the step it has actually reached, never one
  // it has not.
  assert.equal(mapSpeed(1_500_000, null), '1G');
});

test('media comes off the interface type NetBox already records', () => {
  assert.equal(mapMedia('1000base-t'), 'copper');
  assert.equal(mapMedia('10gbase-x-sfpp'), 'fiber');
  assert.equal(mapMedia('virtual'), 'virtual');
  assert.equal(mapMedia('ieee802.11ax'), 'wireless');
  assert.equal(mapMedia('lag'), 'virtual');
});

test('802.1Q mode and the mgmt flag map onto netdia interface modes', () => {
  assert.equal(mapMode({ name: 'Gi1', mode: { value: 'access' } }), 'access');
  assert.equal(mapMode({ name: 'Gi1', mode: { value: 'tagged' } }), 'trunk');
  assert.equal(mapMode({ name: 'Gi1', mode: { value: 'tagged-all' } }), 'trunk');
  assert.equal(mapMode({ name: 'Gi1', mgmt_only: true }), 'mgmt');
  assert.equal(mapMode({ name: 'Vlan10', type: { value: 'virtual' } }), 'svi');
  // Nothing known: hand the decision to netdia's own inferMode rather than
  // pick a mode NetBox never stated.
  assert.equal(mapMode({ name: 'Gi1' }), undefined);
});

/* ---- client ------------------------------------------------------------ */

test('the client accepts either token scheme and prefixes a bare key', () => {
  assert.equal(new NetBoxClient({ token: 'Bearer nbt_a.b' }).auth, 'Bearer nbt_a.b');
  assert.equal(new NetBoxClient({ token: 'Token abc' }).auth, 'Token abc');
  assert.equal(new NetBoxClient({ token: 'abc' }).auth, 'Token abc');
});

test('a missing token is explained, not thrown as a 403 later', () => {
  assert.throws(() => clientFromEnv({}), (e) => {
    assert.equal(e.code, 'NETBOX');
    assert.match(e.message, /NETBOX_TOKEN/);
    return true;
  });
});

/* ---- a fake NetBox ----------------------------------------------------- */

/**
 * Enough of NetBox to resolve one system and a portfolio. Written as literal
 * API shapes rather than a mock library, so the test fails when NetBox changes
 * the shape — which is the thing most likely to break this integration.
 */
function fakeClient() {
  const tenants = [
    {
      slug: 'ise', name: 'ISE', group: { slug: 'plattformtjenester', name: 'Plattformtjenester' },
      custom_fields: {
        criticality: { value: 'tier-1' }, environment: { value: 'prod' },
        owner_technical: 'Nettverk', reviewed: '2026-09-20',
        dependencies: [
          { to: 'ad', kind: 'auth', strength: 'hard', service: 'ldaps', why: 'Identitetsoppslag' },
          { to: 'ghost', kind: 'dns', strength: 'hard' },
        ],
      },
    },
    {
      slug: 'ad', name: 'AD', group: { slug: 'plattformtjenester', name: 'Plattformtjenester' },
      custom_fields: { dependencies: [] },
    },
    {
      slug: 'kontornett', name: 'Kontornett',
      group: { slug: 'forretningstjenester', name: 'Forretningstjenester' },
      custom_fields: {
        criticality: { value: 'tier-1' },
        dependencies: [{ to: 'ise', kind: 'auth', strength: 'hard', service: 'radius' }],
      },
    },
  ];

  const dev = (id, name, role, tenant, site) => ({
    id, name, role: { slug: role }, tenant: tenant ? { slug: tenant, name: tenant } : null,
    site: { slug: site, name: site }, device_type: { model: 'SNS-3715', manufacturer: { name: 'Cisco' } },
    primary_ip4: { display: `10.0.0.${id}/24` },
  });
  const devices = [
    dev(1, 'ise-psn-01', 'ise-psn', 'ise', 'dc1'),
    dev(2, 'core-01', 'core-switch', 'kjernenett', 'dc1'),
  ];

  const iface = (id, devId, devName, name, type, extra = {}) => ({
    id, name, device: { id: devId, name: devName }, type: { value: type },
    enabled: true, tagged_vlans: [], connected_endpoints: [], ...extra,
  });
  const ifaces = [
    iface(10, 1, 'ise-psn-01', 'Gi0', '1000base-t', {
      connected_endpoints: [{ name: 'Gi1/0/3', device: { id: 2, name: 'core-01' } }],
      untagged_vlan: { vid: 20, name: 'SERVERS' },
      mode: { value: 'access' },
    }),
    iface(11, 2, 'core-01', 'Gi1/0/3', '1000base-t', {
      connected_endpoints: [{ name: 'Gi0', device: { id: 1, name: 'ise-psn-01' } }],
      untagged_vlan: { vid: 20, name: 'SERVERS' },
      mode: { value: 'access' },
    }),
    iface(12, 2, 'core-01', 'Gi1/0/9', '1000base-t', { enabled: false }),
  ];

  return {
    calls: [],
    async tenants() { return tenants; },
    async tenantGroups() {
      return [
        { slug: 'plattformtjenester', name: 'Plattformtjenester' },
        { slug: 'forretningstjenester', name: 'Forretningstjenester' },
      ];
    },
    async devices(p = {}) {
      this.calls.push(['devices', p]);
      if (p.tenant) return devices.filter((d) => d.tenant?.slug === p.tenant);
      if (p.id) return devices.filter((d) => p.id.includes(d.id));
      return devices;
    },
    async interfaces(p = {}) {
      this.calls.push(['interfaces', p]);
      if (p.tenant) {
        const ids = devices.filter((d) => d.tenant?.slug === p.tenant).map((d) => d.id);
        return ifaces.filter((i) => ids.includes(i.device.id));
      }
      if (p.device_id) return ifaces.filter((i) => p.device_id.includes(i.device.id));
      return ifaces;
    },
    async ipAddresses() {
      return [{
        address: '10.10.20.21/24', assigned_object_type: 'dcim.interface',
        assigned_object: { name: 'Gi0', device: { name: 'ise-psn-01' } },
      }];
    },
    async prefixes() {
      return [{ prefix: '10.10.20.0/24', vlan: { vid: 20 }, description: 'ISE mgmt' }];
    },
    async vlans() { return []; },
  };
}

/* ---- portfolio --------------------------------------------------------- */

test('the portfolio resolves tenants into a valid dependency model', async () => {
  const { model, dangling } = await resolvePortfolio(fakeClient());
  const r = validateModel(model);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(model.devices.map((d) => d.id).sort(), ['ad', 'ise', 'kontornett']);
  // Only the dep layer: a portfolio has no cables, VLANs or addresses, and
  // emitting those tabs would assert an absence nobody stated.
  assert.deepEqual(layersFor(model), ['dep']);
});

test('a dependency on a tenant that does not exist is reported, not drawn', async () => {
  // NetBox validates the shape of the JSON but cannot look the target up.
  // This is the only place that check can happen.
  const { model, dangling } = await resolvePortfolio(fakeClient());
  assert.deepEqual(dangling, ['ise → ghost']);
  assert.ok(!model.dependencies.some((d) => d.to.startsWith('ghost')));
});

test('consumers are drawn above the systems they consume', async () => {
  const { model } = await resolvePortfolio(fakeClient());
  const p = await layoutGraph(deriveLayer(model, 'dep'));
  assert.ok(p.nodes.get('kontornett').y < p.nodes.get('ise').y);
  assert.ok(p.nodes.get('ise').y < p.nodes.get('ad').y);
});

test('a named service becomes a service on the provider, so the edge can name it', async () => {
  const { model } = await resolvePortfolio(fakeClient());
  const ise = model.devices.find((d) => d.id === 'ise');
  assert.deepEqual(ise.services.map((s) => s.name), ['radius']);
  const edge = deriveLayer(model, 'dep').edges.find((e) => e.a === 'kontornett');
  assert.equal(edge.label, 'radius');
  assert.equal(edge.detail.strength, 'hard');
});

test('the risk card survives into the drawing', async () => {
  const { model } = await resolvePortfolio(fakeClient());
  const ise = model.devices.find((d) => d.id === 'ise');
  assert.deepEqual(ise.tags, ['tier-1', 'prod']);
  assert.match(ise.notes, /Teknisk eier: Nettverk/);
  assert.match(ise.notes, /Sist gjennomgått: 2026-09-20/);
  // A system nobody has reviewed says so rather than leaving a blank.
  const ad = model.devices.find((d) => d.id === 'ad');
  assert.match(ad.notes, /Aldri gjennomgått/);
});

test('an empty NetBox says what is missing instead of drawing nothing', async () => {
  const empty = { ...fakeClient(), async tenants() { return []; } };
  await assert.rejects(() => resolvePortfolio(empty), /no tenants/);
});

/* ---- one system -------------------------------------------------------- */

test('a system resolves to a valid model with its cabled neighbours', async () => {
  const { model, stats } = await resolveSystem(fakeClient(), 'ise');
  const r = validateModel(model);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(stats.owned, 1);
  // core-01 belongs to another system but is pulled in, because an L1 diagram
  // whose cables end in mid-air is worse than no L1 diagram.
  assert.equal(stats.neighbours, 1);
  assert.deepEqual(model.devices.map((d) => d.id).sort(), ['core-01', 'ise-psn-01']);
  assert.match(model.devices.find((d) => d.id === 'core-01').notes, /Tilhører kjernenett/);
});

test('the owning system becomes the zone, so scope is visible in the drawing', async () => {
  const { model } = await resolveSystem(fakeClient(), 'ise');
  const g = deriveLayer(model, 'l1').groups;
  assert.deepEqual(
    g.map((x) => [x.id, x.nodes]).sort(),
    [['zone:ise', ['ise-psn-01']], ['zone:kjernenett', ['core-01']]],
  );
});

test('cables are traced once, not twice from each end', async () => {
  const { model } = await resolveSystem(fakeClient(), 'ise');
  assert.equal(model.links.length, 1);
  const l1 = deriveLayer(model, 'l1');
  assert.equal(l1.edges.length, 1);
  assert.equal(l1.edges[0].media, 'copper');
});

test('an admin-down interface is carried through as shutdown', async () => {
  // NetBox knows `enabled`; netdia has a `shutdown` field for exactly this.
  const { model } = await resolveSystem(fakeClient(), 'ise');
  const core = model.devices.find((d) => d.id === 'core-01');
  assert.equal(core.interfaces.find((i) => i.name === 'Gi1/0/9').shutdown, true);
  assert.ok(!core.interfaces.find((i) => i.name === 'Gi1/0/3').shutdown);
});

test('only the sites the drawn devices sit in are declared', async () => {
  const { model } = await resolveSystem(fakeClient(), 'ise');
  assert.deepEqual(model.sites.map((s) => s.id), ['dc1']);
});

test('a system that owns no devices says so', async () => {
  await assert.rejects(() => resolveSystem(fakeClient(), 'ad'), /owns no devices/);
});

test('an unknown system lists the ones that exist', async () => {
  await assert.rejects(() => resolveSystem(fakeClient(), 'nope'), /available: ad, ise, kontornett/);
});

/* ---- end to end -------------------------------------------------------- */

test('what NetBox returns renders without a renderer change', async () => {
  // The whole point of the resolver: it produces the same object shape the
  // YAML loader produces, so nothing downstream knows NetBox exists.
  for (const resolve of [
    () => resolvePortfolio(fakeClient()),
    () => resolveSystem(fakeClient(), 'ise'),
  ]) {
    const { model } = await resolve();
    for (const layer of layersFor(model)) {
      const g = deriveLayer(model, layer);
      const p = await layoutGraph(g);
      const svg = renderSvg(g, p, getTheme('signal'));
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.ok(svg.endsWith('</svg>'));
      const drawn = new Set([...svg.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]));
      assert.equal(drawn.size, g.nodes.length, `${layer} dropped a node`);
    }
  }
});
