---
name: netlas
description: >
  Author, validate and render netlas network diagrams from one declarative YAML
  model. Use when the user wants to draw or document a network — L1 cabling, L2
  VLANs, L3 IP/routing, dependencies, or an isometric view — or asks to create,
  edit, validate, or render a *.netlas.yaml model or a netlas workspace. Also
  use to turn a described or discovered topology (e.g. from Meraki) into a
  diagram.
user-invocable: true
argument-hint: "[what to draw, or a model path]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# netlas

netlas turns **one YAML model** of a network into L1/L2/L3 diagrams, an
isometric view, and a dependency map — rendered as SVG or a self-contained
interactive HTML viewer. You describe the network once; netlas derives every
layer and lays it out automatically.

This skill lives in the netlas repo, so run every command from the **repo root**
with the bundled CLI. It needs Node ≥ 23 and a one-time `npm install`.

## When to use

- The user wants to draw, document, or update a network diagram.
- The user hands you a `*.netlas.yaml` model or a workspace folder to render, fix, or extend.
- You have a topology from somewhere else (Meraki, a description, an inventory) and want a diagram from it.

## The workflow — always author, then validate, then render

1. **Author or edit** a `*.netlas.yaml` model (see the model shape below and
   `reference.md` for every field and enum). Study `examples/*.netlas.yaml` for
   idiomatic models before writing a new one.
2. **Validate** — never render an unvalidated model:
   ```bash
   node bin/netlas.ts validate path/to/model.netlas.yaml
   ```
   Fix every error and read the warnings (they catch portless links, isolated
   devices, unresolved references). Validation is the contract; the renderer
   assumes a valid model.
3. **Render** the output the user asked for:
   ```bash
   node bin/netlas.ts render path/to/model.netlas.yaml -o out/model.html   # interactive HTML (all layers + 3D)
   node bin/netlas.ts svg    path/to/model.netlas.yaml --layer l1 -o out/l1.svg
   node bin/netlas.ts iso    path/to/model.netlas.yaml -o out/iso.svg
   ```
   Add `--no-3d` to skip the 3D view (otherwise run `npm run build:3d` once).
   Use `--theme <id>` and `--detail full|mid|low` to taste.

## The model in one glance

```yaml
meta:
  title: Branch A
  theme: signal            # optional: signal|blueprint|paper|graphite|aurora
sites:
  - { id: hq, label: HQ, kind: dc }
zones:
  - { id: trust, label: Trust, site: hq, kind: trust }
vlans:                     # any VLAN used on an interface MUST be declared here
  - { id: 10, name: Users, subnet: 10.10.10.0/24 }
  - { id: 20, name: Voice, subnet: 10.10.20.0/24 }
devices:
  - id: fw-1
    role: firewall         # role sets the vertical tier — see reference.md
    vendor: paloalto
    site: hq
    zone: trust
    interfaces:
      - { name: eth1, mode: routed, ip: 10.0.0.1/24 }
  - id: sw-core-1
    role: core
    vendor: cisco
    interfaces:
      - { name: Gi1/0/1, mode: trunk, vlans: [10, 20] }
links:
  - { a: fw-1:eth1, b: sw-core-1:Gi1/0/1, media: fiber, speed: 10G }
```

- **Layers are derived, never drawn by hand:** L1 from `devices`+`links`, L2 from
  interface VLAN membership, L3 from interface IPs + `routing`/`subnets`, DEP
  from `dependencies`, ISO from the L1 graph. Add the source data and the layer
  appears.
- **Declare what you reference:** every VLAN used on an interface must exist
  under `vlans:` (else `UNKNOWN_VLAN`); an interface IP outside any declared
  subnet only warns. `validate` lists the exact fix for each.
- **Link/dependency endpoints** are `device` or `device:interface`. A link to a
  full physical diagram should name the interface on both ends.
- **Layout is automatic (ELK) by default.** Do not write a `layout:` block by
  hand — it is for manual placement done in the Studio, or via `netlas freeze`.

See **`reference.md`** for the full field list and every enum (roles, vendors,
interface modes, media, zone/site/dependency kinds, routing kinds, themes).

## Workspaces (many linked designs)

A workspace is a folder with a `workspace.netlas.yaml` manifest listing several
designs and the cross-design links between them, so a device in one diagram can
drill into another. `examples/portfolio/` is a working example.

```bash
node bin/netlas.ts workspace examples/portfolio -o out/portfolio
```

## Studio (live visual editor)

For interactive editing (add/link/drag devices, multiple layouts, live YAML):
```bash
npm run studio            # http://localhost:5173
NETLAS_WORKSPACE=path/to/folder npm run studio   # open a specific workspace
```

## Rules

- Run commands from the repo root; the CLI is `node bin/netlas.ts` (or `netlas` if the package is linked).
- Always `validate` before `render`; surface warnings, don't hide them.
- Write output under `out/` unless the user says otherwise.
- Prefer extending the model over post-editing SVG — the model is the single source of truth.
- When unsure of a valid value, check `reference.md`, `src/lib/core/model/model.schema.json`, or the `examples/`.
