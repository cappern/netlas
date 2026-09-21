import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadWorkspace,
  parseManifest,
  parseLinkFrom,
  resolveLinks,
  saveWorkspace,
  saveDesign,
  checkDesign,
} from '../src/lib/core/workspace/index.ts';

const PORTFOLIO = new URL('../examples/portfolio', import.meta.url).pathname;

test('loads a workspace with its designs validated', () => {
  const ws = loadWorkspace(PORTFOLIO);
  assert.equal(ws.name, 'Lab Portfolio');
  assert.equal(ws.designs.length, 2);
  const iac = ws.designs.find((d) => d.id === 'iac-lab');
  assert.ok(iac);
  assert.equal(iac.diagnostics.ok, true);
  assert.ok(iac.model.devices.length > 0);
});

test('parseLinkFrom splits design from node on the first colon', () => {
  assert.deepEqual(parseLinkFrom('iac-lab:sw-acc-1'), { design: 'iac-lab', node: 'sw-acc-1' });
  // A node id may itself contain colons; only the design prefix is split off.
  assert.deepEqual(parseLinkFrom('dc:ise:radius'), { design: 'dc', node: 'ise:radius' });
  assert.deepEqual(parseLinkFrom('iac-lab'), { design: 'iac-lab', node: null });
});

test('resolveLinks accepts a valid cross-design link', () => {
  const ws = loadWorkspace(PORTFOLIO);
  const { links, dangling } = resolveLinks(ws);
  assert.equal(dangling.length, 0);
  assert.equal(links.length, 1);
  assert.equal(links[0].fromDesign, 'iac-lab');
  assert.equal(links[0].fromNode, 'sw-acc-1');
  assert.equal(links[0].to, 'ise');
});

test('resolveLinks flags a missing node, a missing source and a missing target', () => {
  const ws = loadWorkspace(PORTFOLIO);
  ws.links = [
    { from: 'iac-lab:does-not-exist', to: 'ise' },
    { from: 'ghost:sw-acc-1', to: 'ise' },
    { from: 'iac-lab:sw-acc-1', to: 'nowhere' },
  ];
  const { links, dangling } = resolveLinks(ws);
  assert.equal(links.length, 0);
  assert.equal(dangling.length, 3);
});

test('parseManifest rejects duplicate design ids and missing fields', () => {
  assert.throws(() => parseManifest('designs:\n  - {id: a, file: a.yaml}\n  - {id: a, file: b.yaml}'), /duplicate/);
  assert.throws(() => parseManifest('designs:\n  - {id: a}'), /needs an id and a file/);
});

test('saveWorkspace and saveDesign round-trip through disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'netlas-ws-'));
  const design = { meta: { title: 'Tiny' }, devices: [{ id: 'a', role: 'core' }, { id: 'b', role: 'server' }], links: [{ a: 'a', b: 'b' }] };
  const designFile = join(dir, 'tiny.netlas.yaml');
  const diag = saveDesign(designFile, design);
  assert.equal(diag.ok, true);

  const ws = {
    dir,
    manifestPath: join(dir, 'workspace.netlas.yaml'),
    name: 'Round Trip',
    designs: [{ id: 'tiny', relFile: 'tiny.netlas.yaml', title: 'Tiny' }],
    links: [],
  };
  saveWorkspace(ws);

  const reloaded = loadWorkspace(dir);
  assert.equal(reloaded.name, 'Round Trip');
  assert.equal(reloaded.designs.length, 1);
  assert.equal(reloaded.designs[0].diagnostics.ok, true);
});

test('checkDesign validates text without writing', () => {
  const { diagnostics } = checkDesign('meta: {title: X}\ndevices:\n  - {id: a, role: core}\n  - {id: b, role: server}\nlinks:\n  - {a: a, b: b}');
  assert.equal(diagnostics.ok, true);
  const bad = checkDesign('meta: {title: X}\ndevices:\n  - {id: a, role: core}\n  - {id: b, role: server}\nlinks:\n  - {a: a, b: ghost}');
  assert.equal(bad.diagnostics.ok, false);
});
