# netlas model reference

Every field and enum for a `*.netlas.yaml` model. The authoritative schema is
`src/lib/core/model/model.schema.json`; this is the readable companion. Most
fields are optional — the loader fills defaults and `validate` enforces the
invariants that matter. Only `meta.title` and `devices` are required.

## Top-level keys

| Key | Type | Notes |
|---|---|---|
| `meta` | object | **Required.** `title` (required), `subtitle`, `owner`, `version`, `updated`, `theme` |
| `sites` | list | Physical locations |
| `zones` | list | Security/broadcast zones (drawn as hulls around members) |
| `vlans` | list | VLAN definitions |
| `subnets` | list | IP subnets |
| `devices` | list | **Required.** The nodes of L1 |
| `links` | list | Physical cabling (L1) |
| `routing` | list | L3 adjacencies/routes |
| `externals` | list | Off-diagram systems a dependency can point to |
| `dependencies` | list | What each system needs to work (DEP layer) |
| `layout` / `layouts` / `defaultLayout` | — | **Do not hand-write.** Managed by the Studio / `netlas freeze` |

## Layers (derived automatically)

| Layer | Appears when | Derived from |
|---|---|---|
| L1 | there are devices | `devices` + `links` |
| L2 | any interface has VLANs, or `vlans` exist | interface VLAN membership |
| L3 | any interface has an IP, or `subnets`/`routing` exist | interface IPs + `routing` |
| DEP | `dependencies` exist | `dependencies` |
| ISO | there are devices | same graph as L1 (isometric) |

## Device

```yaml
- id: sw-core-1          # required, unique; [A-Za-z0-9][A-Za-z0-9._:-]*
  label: Core 1          # defaults to id
  role: core             # required — see roles below (sets vertical tier)
  vendor: cisco          # see vendors
  model: C9300
  os: IOS-XE 17.9
  site: hq               # -> sites[].id
  zone: trust            # -> zones[].id
  mgmt_ip: 10.0.0.10
  interfaces:
    - name: Gi1/0/1      # required within an interface
      mode: trunk        # access|trunk|routed|loopback|svi|mgmt|wan
      speed: 10G
      ip: 10.0.0.1/24
      vlans: [10, 20]
      native_vlan: 1
      description: uplink
  services:
    - { name: radius, port: 1812, proto: udp }
  tags: [rack-a]
  notes: free text
```

**Device roles** (ordered by tier, top→bottom):
`internet` · `wan` · `router` · `firewall` · `loadbalancer` · `core` ·
`distribution` · `access` · `wireless` · `server` · `hypervisor` · `storage` ·
`container` · `service` · `client` · `appliance`

**Vendors:** `cisco` `paloalto` `fortinet` `juniper` `arista` `microsoft`
`linux` `vmware` `proxmox` `aws` `azure` `git` `generic`

**Interface modes:** `access` `trunk` `routed` `loopback` `svi` `mgmt` `wan`

## Link (L1 cabling)

```yaml
- a: fw-1:eth1           # device or device:interface
  b: sw-core-1:Gi1/0/1
  media: fiber           # copper|fiber|virtual|wireless|wan|console
  speed: 10G             # 100M|1G|2.5G|5G|10G|25G|40G|100G|400G
  lag: po1               # optional link-aggregation group label
```

Name the interface on both ends for a full physical diagram; a portless link
still draws but warns (`PORTLESS_LINK`).

## Site / Zone / VLAN / Subnet

```yaml
sites:   [ { id: hq, label: HQ Data Centre, kind: dc } ]     # kind: dc|branch|cloud|lab|edge
zones:   [ { id: trust, label: Trust, site: hq, kind: trust } ]
                                                            # kind: trust|dmz|untrust|mgmt|oob|internal|external
vlans:   [ { id: 10, name: Users, subnet: 10.10.10.0/24, gateway: 10.10.10.1, zone: trust } ]
                                                            # any VLAN id used on an interface MUST be declared here (UNKNOWN_VLAN otherwise)
subnets: [ { cidr: 10.10.10.0/24, name: Users, vlan: 10, gateway: 10.10.10.1, vrf: default, zone: trust } ]
```

## Routing (L3)

```yaml
- from: r1
  to: r2
  kind: bgp              # static|default|bgp|ospf|eigrp|nat|vpn|peering
  detail: AS65001 <-> AS65002
  bidirectional: true
```

## Externals + Dependencies (DEP)

```yaml
externals:
  - id: entra
    label: Entra ID
    kind: identity        # identity|saas|vendor|internal-service|directory|pki|monitoring|unknown
    url: https://login.microsoftonline.com
dependencies:
  - from: fw-1            # device, external, or holder:service
    to: entra
    kind: auth            # transport|compute|auth|dns|ntp|pki|logging|monitoring|api|database|storage|backup|management|sync|license|other
    strength: hard        # hard|soft  (required — no default)
    description: SAML SSO for admin login
```

Endpoint resolution: a whole-string match against device/external ids wins
first; otherwise the last `:` splits `holder:service` (holder ids may contain
colons).

## CLI

```
netlas validate  <model.yaml> [--json]
netlas svg       <model.yaml> --layer l1|l2|l3|dep [-o file.svg] [--theme <id>] [--detail <level>]
netlas iso       <model.yaml> [-o file.svg] [--theme <id>] [--detail <level>]
netlas render    <model.yaml> [-o file.html] [--theme <id>] [--no-3d] [--no-iso]
netlas freeze    <model.yaml> [--layer l1|l2|l3|dep|all] [--reset]
netlas workspace <dir> [-o out-dir] [--theme <id>] [--no-3d] [--no-iso]
netlas themes
```

Invoke as `node bin/netlas.ts <cmd>` from the repo root (or `netlas <cmd>` if the
package is linked).

**Themes:** `signal` (default, dark NOC) · `blueprint` (dark cyanotype) ·
`paper` (light print) · `graphite` · `aurora`

**Detail levels:** `full` (default) · `mid` · `low` — lower levels drop what is
illegible when zoomed out (vendor marks, secondary text, port detail) but never
the device name, role, or cabling.

## Workspace manifest

```yaml
# workspace.netlas.yaml
name: Lab Portfolio
designs:
  - { id: iac-lab, file: iac-lab.netlas.yaml, title: IaC Lab }
  - { id: ise, file: ise.netlas.yaml, title: ISE Dependencies }
links:
  - from: iac-lab:sw-acc-1    # design:node
    to: ise                   # design (optionally design:node)
    kind: drilldown
    description: Access switch authenticates against the ISE deployment
```
