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
| DEP | `dependencies` | What each system needs to keep working |

Change a trunk's VLAN list and all three layers update together, because there
is nowhere else for the fact to live.

## Commands

```
netdia validate <model.yaml> [--json]
netdia svg      <model.yaml> --layer l1|l2|l3|dep [-o file.svg] [--theme <id>] [--detail <level>]
netdia iso      <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
netdia render   <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
netdia freeze   <model.yaml> [--layer l1|l2|l3|dep|all] [--reset]
netdia themes

netdia netbox portfolio      [-o file] [--theme <id>] [--yaml]
netdia netbox system <slug>  [-o file] [--theme <id>] [--yaml]
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

Three worked examples ship with the project:

| File | Scale | Purpose |
|---|---|---|
| `examples/iac-lab.netdia.yaml` | 11 devices | A lab: Palo Alto and Cisco firewalls, Cisco switches, Windows and Linux servers, a hypervisor, a Git host |
| `examples/enterprise-dc.netdia.yaml` | 59 devices, 68 links, 16 VLANs | A redundant data centre: dual WAN, HA perimeter, two cores, four distribution and four leaf switches, twelve access switches, hypervisors, storage, DMZ |
| `examples/ise-dependencies.netdia.yaml` | 11 devices, 3 externals, 17 dependencies | A Cisco ISE policy service and everything that leans on it |

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

## Dependencies

L1, L2 and L3 answer "what is this connected to". They do not answer the
question someone actually asks at 03:00, which is "if this box is down, what
stops working". That fact lives nowhere in a cabling diagram, so it gets its
own block and its own layer:

```yaml
externals:
  - { id: entra, label: Microsoft Entra ID, kind: identity, owner: Identity Services }

dependencies:
  - { from: sw-acc-1, to: "ise-psn-1:radius", kind: auth, strength: hard,
      description: 802.1X and MAB on every access port }
  - { from: ise-psn-1, to: "srv-ntp-1:ntp", kind: ntp, strength: hard }
  - { from: ise-pan-1, to: entra, kind: auth, strength: soft }
```

An endpoint is a device, an external system, or `<id>:<service>` naming one of
the services that device already declares. `externals:` exists so that Entra
ID, a vendor SaaS or a central directory can be an endpoint without becoming a
device that floats, unlabelled and uncabled, in the L1 drawing.

`strength` is required. `hard` means the consumer stops; `soft` means it
degrades. There is deliberately no default: defaulting to `hard` would make
every blast radius over-report, and defaulting to `soft` would hide the
outage. It is one word, and it is the word that carries the meaning.

The DEP layer draws consumers above providers with the arrow pointing at what
is needed. Several services between the same pair — LDAPS and Kerberos to the
same directory — collapse into one edge labelled `ldaps +1`, the same way
parallel cables collapse into a LAG, because two edges between the same two
boxes are routed onto the same line and draw on top of each other.

The tab and the file appear only when the model declares dependencies. An
empty dependency diagram is not an empty drawing, it is a claim that nothing
depends on anything.

Clicking any device, on **any** layer, lists **Used by** and **Depends on**
with the service, the strength and the reason, and each entry jumps to that
system on the DEP layer. Those are direct neighbours only. Following the chain
further and presenting the result as fact would give an inference the same
weight as something a human actually wrote down.

Validation refuses a dependency on a system or a service that is not declared,
a system that depends on itself, and an id shared between a device and an
external — the two share one namespace, so a collision makes the endpoint
ambiguous. A cycle of hard dependencies is a warning, not an error: mutual
dependencies are real, and the drawing's job is to show that nothing in the
cycle can start without the rest.

## NetBox

A model you type by hand is a second source of truth for facts something else
already owns, and two sources of truth for one cable is exactly the drift this
project was written against. Where NetBox is in use, netdia reads from it
instead:

```bash
export NETBOX_URL="http://localhost:8000"
export NETBOX_TOKEN="Bearer nbt_xxxx.yyyy"     # NetBox 4.7+; "Token xxxx" before that

netdia netbox portfolio -o out/portfolio.html  # the systems and what they need
netdia netbox system ise -o out/ise.html       # one system's cabling and addressing
```

The division of labour follows what each tool can actually hold. NetBox owns
inventory: devices, cables, interfaces, addresses, VLANs. It has no concept of
one service depending on another — its `Service` is an L7 listener bound to a
box — so that is what netdia's model adds, and it is the only thing a human
writes by hand.

| Concept | Where it lives |
|---|---|
| A system | A NetBox **tenant** |
| Which system a device belongs to | `Device.tenant` — one box, one system |
| What a system needs to work | `dependencies`, a JSON custom field on the tenant |
| Risk card: owner, criticality, RTO/RPO, last reviewed | Custom fields on the tenant |
| Layout curation | `layout:` in a netdia file — the one thing NetBox has no place for |

The `dependencies` custom field is validated by netdia's own JSON Schema,
pasted into NetBox's `validation_schema`. NetBox then rejects a missing
`strength`, an unknown `kind` or a stray key at the point of entry, so the
same contract holds whether a fact arrives through the API or the UI.

Membership and delivery are different relations, and conflating them is the
usual modelling mistake. `core-01` **belongs to** Kjernenett — one owner. That
Kontornett, OT-nett and Gjestenett all **depend on** Kjernenett is three
edges. The multiplicity lives in the edge, not in the membership, which is
also what makes "infrastructure is itself a service" fall out for free: a
network and a platform are both tenants, differing only in their group.

The resolver produces the same plain object the YAML loader produces, so every
layer, renderer and viewer works unchanged — and `--yaml` writes that object
out, which is how you pin a drawing to a revision or diff what NetBox changed.

A layer appears only when the facts to draw it exist. A portfolio has no
cabling, so it has no L1 tab; a NetBox with no VLANs produces no L2. An empty
tab would assert an absence nobody stated.

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

Tabs for L1, L2, L3, DEP, ISO and 3D; pan and zoom; a level-of-detail control;
click-to-inspect on both devices and links; search across hostnames, IPs,
VLAN ids and port names; SVG and PNG export; and print-to-PDF.

Links are clickable, and the inspector says something true for the layer you
are on rather than calling everything a cable:

| Layer | What a link means | Wording |
|---|---|---|
| L1 | a physical cable | "SW-CORE-1 `Eth1/11` <-> SW-DIST-1 `Te1/0/1`", media, speed, LAG members, and the VLANs the trunk carries |
| L2 | VLAN membership | "SW-DIST-1 **is a member of** VLAN 10", or **is the gateway for** when the device has the SVI |
| L3 | an attachment or an adjacency | "SW-CORE-1 `Vlan10` `10.20.10.1/24` **attaches to** `10.20.10.0/24`", or "RTR-WAN-1 **routes via** Internet" |
| DEP | a thing one system needs | "SW-ACC-1 **needs** ISE-PSN-1", the services it runs over, and the author's reason |

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

117 tests covering validation rules, layer derivation, tier ordering, zone-hull
and zone-plate fallbacks, minimum zone gutters on each axis, SVG
well-formedness in every theme, XML escaping, viewBox containment for both
renderers, isometric depth ordering, face-matrix orientation, faceplate/port
agreement between the two views, freeze round-trips, and a scale suite that
holds the 59-device example to a readable aspect ratio, keeps isometric cable
crossings under 5%, proves that lowering detail never removes a device, a
cable or a name, asserts that edge detail never repeats a fact the edge
already carries, a dependency suite that locks the endpoint grammar, the
merge, the cycle report and the agreement between the impact panel's counts
and the arrows actually drawn, and a NetBox suite that pins the vocabulary
mapping and resolves a fake API into a model that renders.

## Layout of the repository

```
bin/netdia.mjs        CLI
src/model/            schema, loader, validator, layer derivation, impact map
src/netbox/           REST client and the NetBox -> model resolver
src/layout/           ELK layout, role tiers, freeze
src/render2d/         flat SVG renderer, isometric renderer, icon set
src/render3d/         three.js stacked-layer scene (+ prebuilt bundle)
src/theme/            theme tokens
src/viewer/           HTML viewer shell, CSS, runtime
examples/             worked examples
```
