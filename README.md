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
| ISO | same graph as L1 | The same cabling as an isometric floor plan |

Change a trunk's VLAN list and all three layers update together, because there
is nowhere else for the fact to live.

## Commands

```
netdia validate <model.yaml> [--json]
netdia svg      <model.yaml> --layer l1|l2|l3 [-o file.svg] [--theme <id>] [--detail <level>]
netdia iso      <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
netdia render   <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
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

Two worked examples ship with the project:

| File | Scale | Purpose |
|---|---|---|
| `examples/iac-lab.netdia.yaml` | 11 devices | A lab: Palo Alto and Cisco firewalls, Cisco switches, Windows and Linux servers, a hypervisor, a Git host |
| `examples/enterprise-dc.netdia.yaml` | 59 devices, 68 links, 16 VLANs | A redundant data centre: dual WAN, HA perimeter, two cores, four distribution and four leaf switches, twelve access switches, hypervisors, storage, DMZ |

The larger example exists to exercise layout, labelling and zoning at scale;
it is covered by its own test file.

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

Node spacing is set wide enough that two neighbouring devices in different
security zones leave a visible gutter between their zone boxes — zones that
touch read as one merged region.

A tier wider than eight devices is wrapped onto extra rows. A server farm is
one tier by role, and drawing two dozen hosts as a single row produces a
diagram several times wider than it is tall, legible only by panning. Members
are ordered by their upstream neighbour before wrapping, so the hosts on one
leaf switch stay together instead of being scattered by declaration order. The
isometric view inherits this for free, because it derives its rows from the
flat layout.

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

## Isometric L1

`netdia iso` draws the physical layer as a 2.5D floor plan: devices are slabs
standing on their security zone's floor plate, cables run through the space
between them, and a painter's-algorithm depth sort makes a slab in front hide
the cable behind it. It is ordinary SVG, so it prints and exports like every
other layer.

Placement is its own compact grid rather than a reprojection of the flat L1
layout. Projecting the flat layout directly is the obvious approach and it
looks wrong: the diagonal projection stretches a tiered drawing across a
bounding box that is mostly empty. The grid keeps the two facts that carry
meaning — which tier a device sits in, and its left-to-right order within that
tier — and drops only the pixel spacing, which carried none.

It is a projection of the flat layout — the same node positions and the same
cable routes, scaled to 0.8. That matters more than it sounds. An earlier
version re-placed nodes on its own grid and routed cables with a naive
two-segment router, and 70% of cable segments ended up crossing a chassis they
had nothing to do with. ELK already routes orthogonally around obstacles, so
reprojecting brings that to zero.

Devices wear a real chassis rather than a flat icon. Detail is drawn *into*
the isometric faces through a transform in face-local units, so a switch shows
a port row coloured by each cable's actual media, a firewall shows brick
courses, a server shows drive bays and storage shows drive carriers. A 2D glyph
pasted onto a 3D solid is what makes a drawing look assembled rather than
designed, so there isn't one — role is carried by the shape of the box.

The port row reads from the same `usedPorts()` the flat view's port strip uses,
so the faceplate and the strip cannot drift apart.

Zone floor plates are drawn only when they do not overlap. Grid rows follow
tiers, not zones, so a zone's members are not always contiguous; two
overlapping plates would claim a device stands in both zones at once. When
that happens the plates are dropped and each slab carries its zone as text.

Labels stay screen-aligned. Skewing text into the isometric plane looks clever
in one screenshot and is unreadable everywhere else.

## Level of detail

Large diagrams carry detail that is only meaningful up close. netdia can drop
it, in the viewer through the **Auto / Full / Mid / Low** control, and in a
static export through `--detail`.

| Level | Dropped |
|---|---|
| `full` | nothing |
| `mid` | vendor marks, secondary text, the glow filter |
| `low` | + chassis detail, port strips, port-name chips |

The rule for what may be dropped is not taste: an element qualifies only when
it is already illegible at the zoom that triggers the level. A 7.5px vendor
mark has gone by 85% zoom; a port is a smudge below 45%. The device name, its
role colour, the cable media colour and the topology are never dropped, so
nothing a reader could actually have read is taken away — there is a test for
exactly that.

It is also the cheapest performance lever in the project. On the 59-device
example, dropping to `low` takes the visible layer from 1633 painted elements
to 833 and from 350 text elements to 66, and `mid` alone switches off 61
Gaussian-blur filters — an SVG filter is re-rasterised on every repaint. In
the viewer `Auto` follows the zoom, and picking a level pins it.

Static exports shrink accordingly: the enterprise L1 goes 177 KB → 79 KB.

## Viewer

`netdia render` produces one HTML file with no external requests — no CDN, no
web fonts, no network at all. It opens from a USB stick in a plant room.

Tabs for L1, L2, L3, ISO and 3D; pan and zoom; a level-of-detail control;
click-to-inspect on both devices and links; search across hostnames, IPs,
VLAN ids and port names; SVG and PNG export; and print-to-PDF.

Links are clickable, and the inspector says something true for the layer you
are on rather than calling everything a cable:

| Layer | What a link means | Wording |
|---|---|---|
| L1 | a physical cable | "SW-CORE-1 `Eth1/11` <-> SW-DIST-1 `Te1/0/1`", media, speed, LAG members, and the VLANs the trunk carries |
| L2 | VLAN membership | "SW-DIST-1 **is a member of** VLAN 10", or **is the gateway for** when the device has the SVI |
| L3 | an attachment or an adjacency | "SW-CORE-1 `Vlan10` `10.20.10.1/24` **attaches to** `10.20.10.0/24`", or "RTR-WAN-1 **routes via** Internet" |

The VLANs carried on a cable are derived, not authored: they are the
intersection of the two endpoint interfaces' VLAN sets. Endpoint names in the
link inspector are clickable, so you can walk a path hop by hop.

Dragging that starts on a cable still pans; only a click that does not move
selects the link.

Panning coalesces to one transform per animation frame, and only the visible
layer is promoted to its own compositing layer — doing that to all four would
multiply the memory a large diagram needs. The ISO tab shares L1's inspector data,
so clicking a slab shows the same device detail as clicking its flat card.

The 3D tab stacks L1, L2 and L3 as three floors. A device keeps its position
across every floor it appears on and a vertical tie line runs through those
copies, which is the one thing a flat diagram cannot show: that the cable in
L1, the VLAN in L2 and the gateway in L3 are the same box in the rack.

three.js is inlined but lazy-loaded, so 2D opens instantly. It costs about
530 KB of the ~720 KB example file; `--no-3d` brings that to ~185 KB, and
`--no-iso` drops the isometric drawing as well.

## Icons

Device glyphs are drawn in this repository rather than imported from a vendor
icon set, because the official Cisco and Palo Alto libraries carry usage terms
that do not survive redistribution inside a generated artifact. Vendor identity
is carried by a short text mark, which is accurate and unrestricted.

## Testing

```bash
npm test
```

64 tests covering validation rules, layer derivation, tier ordering, zone-hull
and zone-plate fallbacks, minimum zone gutters on each axis, SVG
well-formedness in every theme, XML escaping, viewBox containment for both
renderers, isometric depth ordering, face-matrix orientation, faceplate/port
agreement between the two views, freeze round-trips, and a scale suite that
holds the 59-device example to a readable aspect ratio, keeps isometric cable
crossings under 5%, proves that lowering detail never removes a device, a
cable or a name, and asserts that edge detail never repeats a fact the edge
already carries.

## Layout of the repository

```
bin/netdia.mjs        CLI
src/model/            schema, loader, validator, layer derivation
src/layout/           ELK layout, role tiers, freeze
src/render2d/         flat SVG renderer, isometric renderer, icon set
src/render3d/         three.js stacked-layer scene (+ prebuilt bundle)
src/theme/            theme tokens
src/viewer/           HTML viewer shell, CSS, runtime
examples/             worked example
```
