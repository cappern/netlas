import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModel } from '../src/lib/core/model/load.ts';
import { validateModel } from '../src/lib/core/model/validate.ts';

const BASE = `
meta: { title: T }
vlans:
  - { id: 10, subnet: 10.0.10.0/24, gateway: 10.0.10.1 }
devices:
  - id: a
    role: access
    interfaces: [{ name: Gi1, vlan: 10 }, { name: Gi2, vlan: 10 }]
  - id: b
    role: server
    interfaces: [{ name: eth0, vlan: 10, ip: 10.0.10.5/24 }]
links:
  - { a: "a:Gi1", b: "b:eth0" }
`;

const codes = (r) => [...r.errors, ...r.warnings].map((d) => d.code);

function check(yaml) {
  return validateModel(parseModel(yaml));
}

test('a well-formed model validates clean', () => {
  const r = check(BASE);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.warnings, []);
});

test('rejects a link to an undeclared interface', () => {
  const r = check(BASE.replace('b: "b:eth0"', 'b: "b:eth9"'));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('UNKNOWN_INTERFACE'));
});

test('rejects a link to an unknown device', () => {
  const r = check(BASE.replace('b: "b:eth0"', 'b: "ghost:eth0"'));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('DANGLING_LINK'));
});

test('rejects one physical port terminating two cables', () => {
  const r = check(`${BASE}  - { a: "a:Gi1", b: "b:eth0" }\n`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('PORT_REUSE'));
});

test('rejects a VLAN used on an interface but never declared', () => {
  const r = check(BASE.replace('{ name: Gi2, vlan: 10 }', '{ name: Gi2, vlan: 77 }'));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('UNKNOWN_VLAN'));
});

test('rejects overlapping subnets', () => {
  const r = check(`${BASE}
subnets:
  - { cidr: 10.0.0.0/8 }
`);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('SUBNET_OVERLAP'));
});

test('rejects a gateway outside its own subnet', () => {
  const r = check(BASE.replace('gateway: 10.0.10.1', 'gateway: 10.9.9.1'));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('GATEWAY_OUTSIDE_SUBNET'));
});

test('rejects duplicate device ids', () => {
  const r = check(BASE.replace('  - id: b\n', '  - id: a\n'));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('DUPLICATE_ID'));
});

test('warns about an isolated device rather than failing', () => {
  const r = check(`${BASE}
  - { a: "a:Gi2", b: "b:eth0" }
`.replace('devices:', 'devices:\n  - { id: lonely, role: server }').replace('  - { a: "a:Gi2", b: "b:eth0" }\n', ''));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(codes(r).includes('ISOLATED_DEVICE'));
});

test('warns when an interface IP has no declared network', () => {
  const r = check(BASE.replace('ip: 10.0.10.5/24', 'ip: 192.168.5.5/24'));
  assert.ok(codes(r).includes('UNDECLARED_NETWORK'));
});

test('rejects an unknown role with the allowed values in the message', () => {
  const r = check(BASE.replace('role: server', 'role: toaster'));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /allowed:/);
});

test('an internet cloud without ports does not raise a port warning', () => {
  const r = check(`
meta: { title: T }
devices:
  - { id: net, role: internet }
  - id: fw
    role: firewall
    interfaces: [{ name: e1 }]
links:
  - { a: net, b: "fw:e1" }
`);
  assert.equal(r.ok, true);
  assert.ok(!codes(r).includes('PORTLESS_LINK'));
});

test('parse errors are reported, not thrown as stack traces', () => {
  assert.throws(() => parseModel('a: [unclosed', 'x.yaml'), /Cannot parse/);
  assert.throws(() => parseModel('', 'x.yaml'), /empty/);
  assert.throws(() => parseModel('- just\n- a list', 'x.yaml'), /mapping/);
});
