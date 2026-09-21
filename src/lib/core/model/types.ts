/**
 * Shared model types. One declaration of the shape that flows through the whole
 * pipeline — loader, validator, layer derivation, renderers, CLI and Studio —
 * so an edit that breaks the contract is a type error, not a runtime surprise.
 *
 * Fields are deliberately permissive (most optional): the loader fills defaults,
 * and different producers supply different subsets. The invariants that actually
 * matter are enforced by validateModel(), not by the types.
 */

export type DeviceRole =
  | 'internet' | 'wan' | 'router' | 'firewall' | 'loadbalancer'
  | 'core' | 'distribution' | 'access' | 'wireless'
  | 'server' | 'hypervisor' | 'storage' | 'container' | 'service'
  | 'client' | 'appliance';

export type Vendor =
  | 'cisco' | 'paloalto' | 'fortinet' | 'juniper' | 'arista'
  | 'microsoft' | 'linux' | 'vmware' | 'proxmox' | 'aws' | 'azure'
  | 'git' | 'generic';

export type InterfaceMode = 'access' | 'trunk' | 'routed' | 'loopback' | 'svi' | 'mgmt' | 'wan';
export type Media = 'copper' | 'fiber' | 'virtual' | 'wireless' | 'wan' | 'console';
export type SiteKind = 'dc' | 'branch' | 'cloud' | 'lab' | 'edge';
export type ZoneKind = 'trust' | 'dmz' | 'untrust' | 'mgmt' | 'oob' | 'internal' | 'external';
export type ExternalKind =
  | 'identity' | 'saas' | 'vendor' | 'internal-service' | 'directory'
  | 'pki' | 'monitoring' | 'unknown';
export type DependencyKind =
  | 'transport' | 'compute' | 'auth' | 'dns' | 'ntp' | 'pki' | 'logging'
  | 'monitoring' | 'api' | 'database' | 'storage' | 'backup' | 'management'
  | 'sync' | 'license' | 'other';
export type DependencyStrength = 'hard' | 'soft';
export type RoutingKind = 'static' | 'default' | 'bgp' | 'ospf' | 'eigrp' | 'nat' | 'vpn' | 'peering';

export interface Meta {
  title: string;
  subtitle?: string;
  owner?: string;
  version?: string;
  updated?: string;
  theme?: string;
}

export interface Site { id: string; label?: string; kind?: SiteKind; }
export interface Zone { id: string; label?: string; site?: string; kind?: ZoneKind; }

export interface Vlan {
  id: number;
  name?: string;
  subnet?: string;
  gateway?: string;
  zone?: string;
  purpose?: string;
}

export interface Subnet {
  cidr: string;
  name?: string;
  vlan?: number;
  gateway?: string;
  vrf?: string;
  zone?: string;
  dhcp?: boolean;
}

export interface NetInterface {
  name: string;
  mode?: InterfaceMode;
  speed?: string;
  ip?: string;
  vlans?: number[];
  native_vlan?: number;
  description?: string;
}

export interface Service { name: string; port?: number; proto?: string; notes?: string; }

export interface Device {
  id: string;
  label?: string;
  role: DeviceRole;
  vendor?: Vendor;
  model?: string;
  os?: string;
  site?: string;
  zone?: string;
  mgmt_ip?: string;
  interfaces?: NetInterface[];
  services?: Service[];
  tags?: string[];
  notes?: string;
}

export interface External {
  id: string;
  label?: string;
  kind?: ExternalKind;
  owner?: string;
  url?: string;
  services?: Service[];
  notes?: string;
}

export interface Link {
  a: string;
  b: string;
  media?: Media;
  speed?: string;
  lag?: string;
}

export interface Routing {
  from: string;
  to: string;
  kind?: RoutingKind;
  detail?: string;
  bidirectional?: boolean;
}

export interface Dependency {
  from: string;
  to: string;
  kind: DependencyKind;
  strength: DependencyStrength;
  description?: string;
}

/** Frozen coordinates for one layer, keyed by node id. */
export interface LayoutLayer { nodes: Record<string, { x: number; y: number }>; }
export type Layout = Record<string, LayoutLayer>;

/**
 * A named manual layout: hand-placed coordinates for one or more layers. Auto
 * layout (ELK) is the implicit default and is never stored — it is the absence
 * of a chosen manual layout.
 */
export interface NamedLayout { id: string; name: string; layers: Layout; }

export interface Model {
  meta: Meta;
  sites: Site[];
  zones: Zone[];
  vlans: Vlan[];
  subnets: Subnet[];
  devices: Device[];
  links: Link[];
  routing: Routing[];
  externals: External[];
  dependencies: Dependency[];
  /** Legacy single manual layout (written by `netlas freeze`); shown as "Manual". */
  layout: Layout;
  /** Named manual layouts created in Studio. */
  layouts?: NamedLayout[];
  /** Id of the layout rendered outside Studio. Absent or "auto" means ELK. */
  defaultLayout?: string;
}

/** A model as it may arrive before normalisation: collections optional. */
export type PartialModel = { meta: Meta } & Partial<Omit<Model, 'meta'>>;

export type LayerId = 'l1' | 'l2' | 'l3' | 'dep';

export interface Diagnostic {
  code: string;
  subject: string;
  message: string;
  path?: string;
  fix?: string;
}

export interface Diagnostics {
  ok: boolean;
  errors: Diagnostic[];
  warnings: Diagnostic[];
}
