# netdia

Generate L1, L2 and L3 network diagrams from a single declarative model.

One YAML file describes the network once. netdia derives the three layers from
it, lays them out automatically, and renders them as standalone SVG or as a
self-contained interactive HTML viewer with an optional stacked 3D view.

```bash
npm install
npm run build:3d          # once, and after any change to src/render3d/
node bin/netdia.mjs render examples/iac-lab.netdia.yaml -o out/lab.html
```

## Why one model

Most network documentation drifts because the physical diagram, the VLAN table
and the IP plan are three separate drawings maintained by hand. In netdia they
are three views of one model:

| Layer | Derived from | Shows |
|---|---|---|
| L1 | `devices` + `links` | Cabling, ports, media, LAGs |
| L2 | interface VLAN membership | Broadcast domains, trunks, SVIs |
| L3 | interface IPs + `routing` | Networks, gateways, VRFs, adjacencies |

Change a trunk's VLAN list and all three layers update together, because there
is nowhere else for the fact to live.

## Commands

```
netdia validate <model.yaml> [--json]
netdia svg      <model.yaml> --layer l1|l2|l3 [-o file.svg] [--theme <id>]
netdia render   <model.yaml> [-o file.html] [--theme <id>] [--no-3d]
netdia freeze   <model.yaml> [--layer l1|l2|l3|all] [--reset]
netdia themes
```

`validate` exits non-zero on error, so it drops straight into CI.

## The model

```yaml
meta:   { title: IaC Lab, owner: Platform Engineering, version: "1.4", theme: signal }
sites:  [{ id: lab, kind: lab }]
zones:  [{ id: trust, kind: trust }, { id: dmz, kind: dmz }]

vlans:
  - { id: 20, name: SERVERS, subnet: 10.10.20.0/24, gateway: 10.10.20.1, zone: trust }

devices:
  - id: sw-core-1
    role: core                 # role drives the vertical tier and the glyph
    vendor: cisco
    model: C9300-24T
    zone: trust
    interfaces:
      - { name: Gi1/0/11, mode: trunk, vlans: [10, 20, 99], native_vlan: 99 }
      - { name: Vlan20,   mode: svi,   ip: 10.10.20.1/24 }

links:
  - { a: "sw-core-1:Gi1/0/11", b: "sw-acc-1:Gi1/0/48", media: fiber, speed: 1G }

routing:
  - { from: sw-core-1, to: fw-edge-1, kind: default, detail: "0.0.0.0/0 via 172.16.0.1" }
```

Roles: `internet wan router firewall loadbalancer core distribution access
wireless server hypervisor storage container service client appliance`.
Media: `copper fiber virtual wireless wan console`.

See `examples/iac-lab.netdia.yaml` for a complete lab with Palo Alto and Cisco
firewalls, Cisco switches, Windows and Linux servers, a hypervisor and a Git
host.

## Validation

The schema catches typos; the semantic checks catch the mistakes that actually
produce wrong diagrams:

- a link to a device or interface that does not exist
- one physical port terminating two cables
- a VLAN used on an interface but never declared
- overlapping subnets
- a gateway outside its own subnet
- an interface IP in a network nobody declared
- devices with no links, which would float in L1

Errors block rendering. Warnings are reported and surfaced in the viewer.

## Layout: automatic, then yours

Layout is automatic by default. Nodes are partitioned into tiers by role, so
the drawing reads top-to-bottom the way an engineer thinks rather than the way
a graph solver would arrange it.

When automatic placement is not good enough:

```bash
netdia freeze model.yaml --layer l1     # writes coordinates into layout:
netdia freeze model.yaml --reset        # back to automatic
```

`freeze` writes the solver's chosen coordinates back into the model, where you
can edit them by hand. The model stays the single source of truth and the diff
shows exactly which nodes a human moved. A frozen layout that no longer covers
every node fails loudly rather than silently dropping devices.

## Themes

```
signal      dark    NOC console. Cable-code accents on blue slate.
blueprint   dark    Cyanotype construction drawing. Hairlines, no fills.
paper       light   Print and PDF. Cool stock, two-ink as-built markup.
graphite    light   Monochrome. Meaning carried by weight and dash, not hue.
aurora      dark    Presentation. Glass cards, luminous links, deep indigo.
```

Link colour follows the patch-cable code in every theme, so fiber, copper and
WAN keep their real-world identity. `graphite` deliberately drops hue and
encodes media as dash pattern and line weight instead, for black-and-white
printing and for audits where colour would imply meaning the model does not
carry.

## Viewer

`netdia render` produces one HTML file with no external requests — no CDN, no
web fonts, no network at all. It opens from a USB stick in a plant room.

Layer tabs, pan and zoom, click-to-inspect (interfaces, IPs, VLANs, services),
search across hostnames, IPs, VLAN ids and port names, SVG and PNG export, and
print-to-PDF.

The 3D tab stacks L1, L2 and L3 as three floors. A device keeps its position
across every floor it appears on and a vertical tie line runs through those
copies, which is the one thing a flat diagram cannot show: that the cable in
L1, the VLAN in L2 and the gateway in L3 are the same box in the rack.

three.js is inlined but lazy-loaded, so 2D opens instantly. It costs about
530 KB of the ~680 KB example file; `--no-3d` brings that to ~150 KB.

## Icons

Device glyphs are drawn in this repository rather than imported from a vendor
icon set, because the official Cisco and Palo Alto libraries carry usage terms
that do not survive redistribution inside a generated artifact. Vendor identity
is carried by a short text mark, which is accurate and unrestricted.

## Testing

```bash
npm test
```

Covers validation rules, layer derivation, tier ordering, zone-hull fallback,
SVG well-formedness, XML escaping, viewBox containment, and freeze round-trips.

## Layout of the repository

```
bin/netdia.mjs        CLI
src/model/            schema, loader, validator, layer derivation
src/layout/           ELK layout, role tiers, freeze
src/render2d/         SVG renderer and icon set
src/render3d/         three.js stacked-layer scene (+ prebuilt bundle)
src/theme/            theme tokens
src/viewer/           HTML viewer shell, CSS, runtime
examples/             worked example
```
