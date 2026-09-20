import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModel, parseModel, resolveDepEndpoint, indexModel } from '../src/model/load.mjs';
import { validateModel } from '../src/model/validate.mjs';
import { deriveLayer, layersFor, LAYERS, ALL_LAYERS } from '../src/model/derive.mjs';
import { buildImpactMap } from '../src/model/impact.mjs';
import { layoutGraph } from '../src/layout/index.mjs';
import { renderSvg } from '../src/render2d/svg.mjs';
import { getTheme, THEME_IDS } from '../src/theme/themes.mjs';

const model = loadModel(new URL('../examples/ise-dependencies.netdia.yaml', import.meta.url).pathname);

/** A minimal valid model, so a test can add exactly one broken fact to it. */
function withDeps(body) {
  return parseModel(`
meta: { title: T }
devices:
  - id: a
    role: server
    services: [{ name: radius, port: 1812 }]
  - id: b
    role: access
${body}
`);
}

const codes = (m) => validateModel(m).errors.map((e) => e.code);
const warnCodes = (m) => validateModel(m).warnings.map((w) => w.code);

/* ---- the loader is where a new top-level key goes to die --------------- */

test('externals and dependencies survive normalization', () => {
  // normalize() builds the model from a fixed object literal, and the schema
  // runs against that result — so a key it forgets is dropped silently and
  // additionalProperties:false never sees it. This is the regression guard.
  assert.ok(Array.isArray(model.externals));
  assert.ok(model.externals.length > 0, 'externals reached the model');
  assert.ok(model.dependencies.length > 0, 'dependencies reached the model');
  assert.equal(model.externals.find((e) => e.id === 'entra').label, 'Microsoft Entra ID');
});

test('an external without a label falls back to its id', () => {
  // nodeSize() reads node.label.length unguarded.
  const m = withDeps(`externals: [{ id: ext }]
dependencies: [{ from: b, to: ext, kind: other, strength: soft }]`);
  assert.equal(m.externals[0].label, 'ext');
});

/* ---- endpoint grammar -------------------------------------------------- */

test('a dependency endpoint resolves whole-string before it splits', () => {
  // definitions/id permits a colon inside an id, so splitting first — the way
  // a link endpoint does — would read "dc1:ise" as device "dc1".
  const m = parseModel(`
meta: { title: T }
devices:
  - { id: "dc1:ise", role: server, services: [{ name: radius }] }
externals:
  - { id: "entra:prod" }
dependencies: []
`);
  const ix = indexModel(m);
  assert.deepEqual(resolveDepEndpoint('dc1:ise', ix), {
    holder: 'dc1:ise', service: null, kind: 'device', raw: 'dc1:ise',
  });
  assert.deepEqual(resolveDepEndpoint('entra:prod', ix), {
    holder: 'entra:prod', service: null, kind: 'external', raw: 'entra:prod',
  });
  // Only once no whole-string match exists does it split, and then on the last
  // colon, so the service is the rightmost segment.
  assert.deepEqual(resolveDepEndpoint('dc1:ise:radius', ix), {
    holder: 'dc1:ise', service: 'radius', kind: 'device', raw: 'dc1:ise:radius',
  });
  assert.equal(resolveDepEndpoint('nope:radius', ix).kind, null);
});

/* ---- validation -------------------------------------------------------- */

test('a dependency on an undeclared system is an error', () => {
  const m = withDeps('dependencies: [{ from: b, to: ghost, kind: auth, strength: hard }]');
  assert.ok(codes(m).includes('UNKNOWN_DEPENDENCY_ENDPOINT'));
});

test('a dependency on an undeclared service is an error', () => {
  const m = withDeps('dependencies: [{ from: b, to: "a:tacacs", kind: auth, strength: hard }]');
  assert.ok(codes(m).includes('UNKNOWN_SERVICE'));
});

test('a system cannot depend on itself', () => {
  const m = withDeps('dependencies: [{ from: a, to: "a:radius", kind: auth, strength: hard }]');
  assert.ok(codes(m).includes('SELF_DEPENDENCY'));
});

test('a device and an external cannot share an id', () => {
  // They share one namespace because a dependency endpoint resolves against
  // both, and the per-list duplicate check cannot see across lists.
  const m = withDeps(`externals: [{ id: a }]
dependencies: [{ from: b, to: "a:radius", kind: auth, strength: hard }]`);
  assert.ok(codes(m).includes('ID_COLLISION'));
});

test('strength is required, because guessing severity falsifies every impact answer', () => {
  const m = withDeps('dependencies: [{ from: b, to: "a:radius", kind: auth }]');
  assert.ok(codes(m).includes('SCHEMA'));
});

test('a hard dependency cycle warns but still renders', () => {
  const m = withDeps(`dependencies:
  - { from: a, to: b, kind: api, strength: hard }
  - { from: b, to: a, kind: api, strength: hard }`);
  const r = validateModel(m);
  assert.equal(r.ok, true, 'a real cycle is documentable, not an error');
  assert.ok(r.warnings.some((w) => w.code === 'DEPENDENCY_CYCLE'));
  assert.equal(deriveLayer(m, 'dep').edges.length, 2);
});

test('a soft cycle is not reported, because it degrades rather than deadlocks', () => {
  const m = withDeps(`dependencies:
  - { from: a, to: b, kind: api, strength: soft }
  - { from: b, to: a, kind: api, strength: soft }`);
  assert.ok(!warnCodes(m).includes('DEPENDENCY_CYCLE'));
});

test('an external that consumes is drawn above what it consumes', async () => {
  // Externals default to the bottom of the drawing because they are usually
  // providers. One that consumes has to go to the top, or the arrow runs
  // upward and contradicts the layer's only reading rule.
  const m = parseModel(`
meta: { title: T }
devices: [{ id: a, role: server, services: [{ name: api }] }]
externals: [{ id: partner }]
dependencies: [{ from: partner, to: "a:api", kind: api, strength: hard }]
`);
  const g = deriveLayer(m, 'dep');
  const p = await layoutGraph(g);
  assert.ok(p.nodes.get('partner').y < p.nodes.get('a').y);
});

test('an external that both consumes and provides is flagged as undrawable', () => {
  const m = parseModel(`
meta: { title: T }
devices: [{ id: a, role: server, services: [{ name: api }] }]
externals: [{ id: hub }]
dependencies:
  - { from: hub, to: "a:api", kind: api, strength: hard }
  - { from: a, to: hub, kind: api, strength: soft }
`);
  assert.ok(warnCodes(m).includes('EXTERNAL_BOTH_WAYS'));
});

test('a deep dependency chain does not blow the validator stack', () => {
  // A recursive walk died with a RangeError here; a long chain is a plausible
  // model and a validator that crashes on one is worse than no validator.
  const n = 20000;
  const devices = [];
  const deps = [];
  for (let i = 0; i < n; i++) devices.push(`  - { id: d${i}, role: server }`);
  for (let i = 0; i < n - 1; i++) {
    deps.push(`  - { from: d${i}, to: d${i + 1}, kind: api, strength: hard }`);
  }
  const m = parseModel(`meta: { title: T }\ndevices:\n${devices.join('\n')}\ndependencies:\n${deps.join('\n')}\n`);
  assert.equal(validateModel(m).ok, true);
});

test('two different cycles over the same systems are two different outages', () => {
  const m = parseModel(`
meta: { title: T }
devices: [{ id: a, role: server }, { id: b, role: server }, { id: c, role: server }]
dependencies:
  - { from: a, to: b, kind: api, strength: hard }
  - { from: b, to: c, kind: api, strength: hard }
  - { from: c, to: a, kind: api, strength: hard }
  - { from: a, to: c, kind: api, strength: hard }
  - { from: c, to: b, kind: api, strength: hard }
  - { from: b, to: a, kind: api, strength: hard }
`);
  const cycles = validateModel(m).warnings.filter((w) => w.code === 'DEPENDENCY_CYCLE');
  // Keying on the set of members rather than the rotation would collapse
  // a -> b -> c -> a and a -> c -> b -> a into one report.
  assert.ok(cycles.length >= 2, `only ${cycles.length} cycle(s) reported`);
});

test('an external nobody references is a warning', () => {
  const m = withDeps(`externals: [{ id: unused }]
dependencies: [{ from: b, to: "a:radius", kind: auth, strength: hard }]`);
  assert.ok(warnCodes(m).includes('UNUSED_EXTERNAL'));
});

test('a device that only appears in dependencies still warns that it is uncabled', () => {
  // Weakening ISOLATED_DEVICE to accept dependency participation would remove
  // the only check that catches a device wired nowhere. The model has to have
  // an L1 for the warning's claim ("will float in the L1 diagram") to be true,
  // so c and d are cabled and a is not.
  const m = parseModel(`
meta: { title: T }
devices:
  - { id: a, role: server, services: [{ name: radius }] }
  - { id: c, role: core, interfaces: [{ name: Gi1 }] }
  - { id: d, role: access, interfaces: [{ name: Gi1 }] }
links: [{ a: "c:Gi1", b: "d:Gi1" }]
dependencies: [{ from: d, to: "a:radius", kind: auth, strength: hard }]
`);
  const isolated = validateModel(m).warnings.filter((w) => w.code === 'ISOLATED_DEVICE');
  assert.deepEqual(isolated.map((w) => w.subject), ['device:a']);
});

test('the dependency example is valid and clean', () => {
  const r = validateModel(model);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
});

/* ---- the layer --------------------------------------------------------- */

test('a layer appears only when the model carries the facts to draw it', () => {
  // Emitting a tab for a layer the model says nothing about asserts an
  // absence the author never stated.
  assert.deepEqual(layersFor(model), ALL_LAYERS);
  assert.deepEqual(layersFor({}), []);

  // A portfolio of systems: dependencies but no cabling, no VLANs, no IPs.
  const portfolio = parseModel(`
meta: { title: T }
devices: [{ id: a, role: server, services: [{ name: api }] }, { id: b, role: service }]
dependencies: [{ from: b, to: "a:api", kind: api, strength: hard }]
`);
  assert.deepEqual(layersFor(portfolio), ['dep']);

  // A pure cabling record: links, but nothing addressed or depended upon.
  const cabling = parseModel(`
meta: { title: T }
devices:
  - { id: a, role: core, interfaces: [{ name: Gi1 }] }
  - { id: b, role: access, interfaces: [{ name: Gi1 }] }
links: [{ a: "a:Gi1", b: "b:Gi1" }]
`);
  assert.deepEqual(layersFor(cabling), ['l1']);
});

test('the dep layer carries every participant and nothing else', () => {
  const g = deriveLayer(model, 'dep');
  const ids = new Set(g.nodes.map((n) => n.id));
  assert.ok(ids.has('ise-psn-1'));
  assert.ok(ids.has('entra'), 'externals are nodes here');
  assert.ok(ids.has('sw-acc-1'), 'a consumer is a participant too');
  // A device that is cabled but takes part in no dependency has no business
  // on this layer, however central it is to the physical drawing.
  const bystander = parseModel(`
meta: { title: T }
devices:
  - { id: a, role: server, services: [{ name: radius }] }
  - { id: b, role: access }
  - { id: c, role: core }
dependencies: [{ from: b, to: "a:radius", kind: auth, strength: hard }]
`);
  const only = deriveLayer(bystander, 'dep').nodes.map((n) => n.id);
  assert.deepEqual(only.sort(), ['a', 'b'], 'c takes part in nothing');
  for (const e of g.edges) {
    assert.ok(ids.has(e.a), `${e.id} points at a missing ${e.a}`);
    assert.ok(ids.has(e.b), `${e.id} points at a missing ${e.b}`);
  }
});

test('several services to one provider merge into one edge, as parallel cables do', () => {
  // Two edges between the same pair land on the same orthogonal route and
  // draw on top of each other, which is why L1 merges LAGs.
  const g = deriveLayer(model, 'dep');
  const ad = g.edges.filter((e) => e.a === 'ise-psn-1' && e.b === 'srv-ad-1');
  const auth = ad.find((e) => e.detail.dependencyKind === 'auth');
  assert.equal(auth.detail.services.length, 2, 'ldaps and kerberos');
  assert.equal(auth.label, 'ldaps +1');
  // dns is a different kind, so it keeps its own colour and its own edge.
  assert.equal(ad.length, 2);
  assert.equal(ad.find((e) => e.detail.dependencyKind === 'dns').label, 'dns');
});

test('kind is part of the merge key, so an edge colour stays decidable', () => {
  // Merging two kinds into one edge would leave theme.media[e.media] and the
  // legend describing a relationship the edge no longer only represents.
  const m = withDeps(`dependencies:
  - { from: b, to: "a:radius", kind: auth, strength: hard }
  - { from: b, to: a, kind: logging, strength: hard }`);
  const edges = deriveLayer(m, 'dep').edges;
  assert.equal(edges.length, 2, 'same pair, same strength, different kind: two edges');
  assert.deepEqual(
    edges.map((e) => e.detail.dependencyKind).sort(),
    ['auth', 'logging'],
  );
});

test('a dependency edge carries no port, so it never reaches the faceplate', () => {
  // usedPorts() feeds the physical port strip. A service name is prose and
  // would be drawn there as if it were an RJ45.
  for (const e of deriveLayer(model, 'dep').edges) {
    assert.equal(e.aPort, null);
    assert.equal(e.bPort, null);
    assert.equal(e.directed, true, 'the arrow is what says which way the need runs');
  }
});

test('the consumer is drawn above the provider', async () => {
  const g = deriveLayer(model, 'dep');
  const p = await layoutGraph(g);
  assert.ok(p.nodes.get('sw-acc-1').y < p.nodes.get('ise-psn-1').y);
  assert.ok(p.nodes.get('ise-psn-1').y < p.nodes.get('srv-ad-1').y);
  assert.ok(p.nodes.get('srv-ad-1').y < p.nodes.get('pki-root').y, 'externals sit at the bottom');
});

test('nodes and edges come out in declaration order, not traversal order', () => {
  // ELK is seeded on model order and freeze writes the resulting coordinates
  // to disk, so an order that depended on graph traversal would churn both
  // the drawing and the diff.
  const g = deriveLayer(model, 'dep');
  assert.deepEqual(
    g.nodes.filter((n) => n.kind === 'external').map((n) => n.id),
    model.externals.map((e) => e.id),
  );
  assert.deepEqual(
    g.nodes.filter((n) => n.kind === 'device').map((n) => n.id),
    model.devices.map((d) => d.id).filter((id) => g.nodes.some((n) => n.id === id)),
  );
  // Edge ids are the index of the dependency row that seeded them, so they
  // are strictly ascending when read in drawing order.
  const seeds = g.edges.map((e) => Number(e.id.slice(4)));
  assert.deepEqual(seeds, [...seeds].sort((x, y) => x - y));
});

test('the dep layer supplies every graph key the renderer reads unguarded', () => {
  const g = deriveLayer(model, 'dep');
  assert.ok(Array.isArray(g.legend) && g.legend.length > 0);
  assert.equal(typeof g.subtitle, 'string');
  assert.equal(typeof g.title, 'string');
  assert.equal(g.layer, 'dep');
  assert.ok(g.meta);
  for (const n of g.nodes) {
    assert.ok(Array.isArray(n.badges), `${n.id} has no badges array`);
    assert.ok(n.role, `${n.id} has no role, so it would fall back to a network colour`);
    assert.equal(typeof n.label, 'string');
  }
  // legendFromEdges would print the literal string "dep-hard".
  assert.ok(g.legend.every((l) => !/^dep-/.test(l.label)));
});

test('the dep layer renders well-formed SVG in every theme', async () => {
  const g = deriveLayer(model, 'dep');
  const p = await layoutGraph(g);
  for (const id of THEME_IDS) {
    const theme = getTheme(id);
    const svg = renderSvg(g, p, theme);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(svg.endsWith('</svg>'), id);
    assert.ok(svg.includes('ISE-PSN-1'), id);
    // blueprint and paper uppercase every node name, as they do for devices.
    assert.ok(/Microsoft Entra ID/i.test(svg), `${id} dropped an external`);
    assert.ok(/IDENTITY SERVICES/i.test(svg), `${id} dropped the external's owner`);
    // Every strength must resolve to a colour and therefore to an arrowhead.
    for (const strength of ['hard', 'soft']) {
      assert.ok(theme.media[`dep-${strength}`], `${id} has no colour for dep-${strength}`);
      assert.ok(svg.includes(`nd-arrow-dep-${strength}`), `${id} lost the dep-${strength} arrow`);
    }
  }
});

/* ---- impact ------------------------------------------------------------ */

test('the impact map answers both directions for a provider', () => {
  const impact = buildImpactMap(model);
  const ise = impact['ise-psn-1'];
  // Every network access device leans on the PSN; pxGrid clients register
  // with the controller persona on the PAN, so they are not here.
  assert.deepEqual(
    ise.usedBy.map((e) => e.id).sort(),
    ['fw-edge-1', 'sw-acc-1', 'sw-core-1', 'wlc-1'],
  );
  assert.ok(ise.dependsOn.some((e) => e.id === 'pki-root' && e.strength === 'hard'));
  const radius = ise.usedBy.find((e) => e.id === 'sw-acc-1');
  assert.deepEqual(radius.services, ['radius']);
  assert.equal(radius.strength, 'hard');
  assert.ok(radius.descriptions.length, 'the why is what makes this documentation');
});

test('the impact map counts systems, not service rows', () => {
  // Three declared rows point ISE at the directory. Counting rows would make
  // the panel say "used by 3" where the drawing shows two arrows, and would
  // over-report severity in exactly the place this feature exists to report
  // it accurately.
  const impact = buildImpactMap(model);
  const ad = impact['srv-ad-1'];
  // Two systems use the directory, over three drawn arrows: ISE needs it for
  // both auth and DNS, and those are separate edges because they are separate
  // kinds. The services collapse, the kinds do not.
  assert.deepEqual([...new Set(ad.usedBy.map((e) => e.id))].sort(), ['dnac-1', 'ise-psn-1']);
  const auth = ad.usedBy.find((e) => e.id === 'ise-psn-1' && e.kind === 'auth');
  assert.deepEqual(auth.services.sort(), ['kerberos', 'ldaps']);
  assert.equal(auth.descriptions.length, 2, 'both reasons survive the merge');
  // Every entry has a counterpart on the other side, and the two directions
  // agree on how many systems there are.
  for (const [id, entry] of Object.entries(impact)) {
    for (const e of entry.usedBy) {
      assert.ok(
        impact[e.id].dependsOn.some((x) => x.id === id && x.kind === e.kind),
        `${e.id} -> ${id} is recorded in one direction only`,
      );
    }
  }
});

test('the impact panel agrees with the number of arrows drawn', () => {
  // Two places to read the same fact is how a payload starts disagreeing
  // with itself; here the two places are a panel and a picture.
  const impact = buildImpactMap(model);
  const edges = deriveLayer(model, 'dep').edges;
  const rows = Object.values(impact).reduce((n, e) => n + e.dependsOn.length, 0);
  assert.equal(rows, edges.length);
});

test('the impact map is keyed on real ids and covers externals too', () => {
  const impact = buildImpactMap(model);
  assert.ok(impact['entra'].usedBy.some((e) => e.id === 'ise-pan-1'));
  assert.equal(impact['entra'].dependsOn.length, 0);
  assert.ok('srv-siem-1' in impact, 'a pure provider still gets an entry');
});

test('a model with no dependencies produces an empty impact map', () => {
  const lab = loadModel(new URL('../examples/iac-lab.netdia.yaml', import.meta.url).pathname);
  assert.deepEqual(buildImpactMap(lab), {});
});
