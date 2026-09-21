/**
 * netlas themes.
 *
 * Design position: a network diagram is an engineering drawing, not a slide.
 * The palette is therefore derived from the subject's own world — patch cable
 * colour codes, port LEDs, cyanotype plans, and rack anodising — rather than
 * from a generic brand ramp. Link colour carries meaning in every theme:
 * fiber, copper, WAN, and virtual media keep their real-world identity, so a
 * reader who knows cabling can read the diagram before reading the legend.
 *
 * Each theme is a flat token map. The SVG renderer and the 3D scene both read
 * the same tokens, which is what keeps 2D and 3D visually identical.
 */

const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** Ports, IPs and VLAN ids are data: always monospaced, always tabular. */
export const DATA_FONT: string = MONO;

/** One zone's fill/stroke/text triple. */
export interface ZoneTokens { fill: string; stroke: string; text: string; }

/**
 * A flat token map read identically by the SVG renderer and the 3D scene.
 * Colour maps (role, media) are open string records because callers index them
 * by values the model supplies.
 */
export interface Theme {
  id: string;
  label: string;
  mode: 'dark' | 'light';
  description: string;
  bg: string;
  bgAlt: string;
  grid: string;
  gridAccent: string;
  surface: string;
  surfaceAlt: string;
  surfaceRaised: string;
  stroke: string;
  strokeSoft: string;
  strokeStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  role: Record<string, string>;
  media: Record<string, string>;
  zone: Record<string, ZoneTokens>;
  fontDisplay: string;
  fontBody: string;
  fontData: string;
  radius: number;
  strokeWidth: number;
  edgeWidth: number;
  glow: number;
  gridStyle: 'dot' | 'line' | 'none';
  uppercase?: boolean;
  monochrome?: boolean;
}

/** The set of detail flags that govern level-of-detail rendering. */
export interface DetailFlags {
  level: string;
  vendor: boolean;
  sub: boolean;
  glow: boolean;
  chassis: boolean;
  chip: boolean;
}

const themes: Record<string, Theme> = {};

/* --------------------------------------------------------------------- *
 * signal — the default. A NOC console at 02:00.
 * Ground is a blue-cast slate, not black; node cards sit *above* it as
 * lit panels. Accents are the patch-cable code: OM4 aqua for fiber,
 * ochre for copper, magenta for the WAN circuit.
 * --------------------------------------------------------------------- */
themes.signal = {
  id: 'signal',
  label: 'Signal',
  mode: 'dark',
  description: 'NOC console. Cable-code accents on blue slate.',

  bg: '#0F1620',
  bgAlt: '#0B111A',
  grid: '#1B2533',
  gridAccent: '#222F40',

  surface: '#18222F',
  surfaceAlt: '#1F2B3A',
  surfaceRaised: '#233043',
  stroke: '#33435A',
  strokeSoft: '#263345',
  strokeStrong: '#4A5E7C',

  text: '#E6EDF6',
  textMuted: '#93A4BC',
  textFaint: '#5E718C',

  role: {
    internet: '#8C93A8',
    wan: '#C77DFF',
    router: '#4CC9F0',
    firewall: '#FF6B5B',
    loadbalancer: '#FFB454',
    core: '#4EA8DE',
    distribution: '#5FD0C4',
    access: '#5FD0C4',
    wireless: '#9D8DF1',
    hypervisor: '#7AD98C',
    server: '#7AD98C',
    storage: '#E8C468',
    container: '#7AD98C',
    service: '#7AD98C',
    appliance: '#93A4BC',
    client: '#9AA7BD',
    vlan: '#FFB454',
    network: '#4CC9F0',
    external: '#B1789B',
  },

  media: {
    copper: '#D9A05B',
    fiber: '#4BC3D4',
    virtual: '#8E9BB5',
    wireless: '#9D8DF1',
    wan: '#C77DFF',
    console: '#5E718C',
    tagged: '#4BC3D4',
    untagged: '#8E9BB5',
    gateway: '#FF9F45',
    attached: '#6E809B',
    routing: '#4CC9F0',
    'dep-hard': '#E86A8C',
    'dep-soft': '#8E9BB5',
  },

  zone: {
    trust: { fill: '#12303A', stroke: '#2E6B72', text: '#7ED4C8' },
    dmz: { fill: '#3A2A16', stroke: '#7A5A2A', text: '#E8B96A' },
    untrust: { fill: '#3A1C1C', stroke: '#7A3636', text: '#F0958C' },
    mgmt: { fill: '#1E2440', stroke: '#404C80', text: '#A5B0E8' },
    oob: { fill: '#1E2440', stroke: '#404C80', text: '#A5B0E8' },
    internal: { fill: '#1A2531', stroke: '#35455C', text: '#93A4BC' },
    external: { fill: '#3A1C1C', stroke: '#7A3636', text: '#F0958C' },
  },

  fontDisplay: "'Inter Tight', 'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontData: MONO,

  radius: 10,
  strokeWidth: 1.6,
  edgeWidth: 1.8,
  glow: 0.28,
  gridStyle: 'dot',
};

/* --------------------------------------------------------------------- *
 * blueprint — cyanotype. Network plans descend from building plans, so
 * this one commits: Prussian blue ground, white construction hairlines,
 * no filled surfaces, condensed uppercase labels.
 * --------------------------------------------------------------------- */
themes.blueprint = {
  id: 'blueprint',
  label: 'Blueprint',
  mode: 'dark',
  description: 'Cyanotype construction drawing. Hairlines, no fills.',

  bg: '#0C2B4A',
  bgAlt: '#0A2440',
  grid: '#17436B',
  gridAccent: '#1D5185',

  surface: '#0E3055',
  surfaceAlt: '#123A66',
  surfaceRaised: '#14406F',
  stroke: '#A8CDE8',
  strokeSoft: '#3D6E99',
  strokeStrong: '#EAF4FC',

  text: '#F0F7FD',
  textMuted: '#A8CDE8',
  textFaint: '#6791B5',

  role: {
    internet: '#A8CDE8',
    wan: '#FFD166',
    router: '#EAF4FC',
    firewall: '#FF8B6B',
    loadbalancer: '#FFD166',
    core: '#EAF4FC',
    distribution: '#A8CDE8',
    access: '#A8CDE8',
    wireless: '#A8CDE8',
    hypervisor: '#8FE3C4',
    server: '#8FE3C4',
    storage: '#FFD166',
    container: '#8FE3C4',
    service: '#8FE3C4',
    appliance: '#A8CDE8',
    client: '#A8CDE8',
    vlan: '#FFD166',
    network: '#EAF4FC',
    external: '#A8CDE8',
  },

  media: {
    copper: '#FFD166',
    fiber: '#7FE3F0',
    virtual: '#6791B5',
    wireless: '#C5A3FF',
    wan: '#FF8B6B',
    console: '#3D6E99',
    tagged: '#7FE3F0',
    untagged: '#A8CDE8',
    gateway: '#FFD166',
    attached: '#6791B5',
    routing: '#EAF4FC',
    'dep-hard': '#FF8B6B',
    'dep-soft': '#6791B5',
  },

  zone: {
    trust: { fill: '#0E3A52', stroke: '#7FE3F0', text: '#7FE3F0' },
    dmz: { fill: '#3A3418', stroke: '#FFD166', text: '#FFD166' },
    untrust: { fill: '#43231C', stroke: '#FF8B6B', text: '#FF8B6B' },
    mgmt: { fill: '#1B3363', stroke: '#C5A3FF', text: '#C5A3FF' },
    oob: { fill: '#1B3363', stroke: '#C5A3FF', text: '#C5A3FF' },
    internal: { fill: '#0E3055', stroke: '#3D6E99', text: '#A8CDE8' },
    external: { fill: '#43231C', stroke: '#FF8B6B', text: '#FF8B6B' },
  },

  fontDisplay: "'Archivo Narrow', 'Roboto Condensed', 'Inter Tight', Helvetica, sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontData: MONO,

  radius: 2,
  strokeWidth: 1.1,
  edgeWidth: 1.2,
  glow: 0,
  gridStyle: 'line',
  uppercase: true,
};

/* --------------------------------------------------------------------- *
 * paper — for print and PDF. Cool paper stock, not cream. Two inks only:
 * plan blue and oxide red, the colours of a marked-up as-built drawing.
 * --------------------------------------------------------------------- */
themes.paper = {
  id: 'paper',
  label: 'Paper',
  mode: 'light',
  description: 'Print and PDF. Cool stock, two-ink as-built markup.',

  bg: '#F6F7F5',
  bgAlt: '#EDEFEC',
  grid: '#E2E5E0',
  gridAccent: '#D5D9D3',

  surface: '#FFFFFF',
  surfaceAlt: '#F1F3F0',
  surfaceRaised: '#FFFFFF',
  stroke: '#B9BFB8',
  strokeSoft: '#D5D9D3',
  strokeStrong: '#6B7370',

  text: '#1C2320',
  textMuted: '#5C6663',
  textFaint: '#8C9591',

  role: {
    internet: '#6B7370',
    wan: '#7A3E8C',
    router: '#1B5E8C',
    firewall: '#B5321E',
    loadbalancer: '#B5731E',
    core: '#1B5E8C',
    distribution: '#0F7B6C',
    access: '#0F7B6C',
    wireless: '#5B4AA8',
    hypervisor: '#2E7D32',
    server: '#2E7D32',
    storage: '#8A6D1B',
    container: '#2E7D32',
    service: '#2E7D32',
    appliance: '#5C6663',
    client: '#5C6663',
    vlan: '#B5731E',
    network: '#1B5E8C',
    external: '#7A4B66',
  },

  media: {
    copper: '#B5731E',
    fiber: '#0E7490',
    virtual: '#8C9591',
    wireless: '#5B4AA8',
    wan: '#7A3E8C',
    console: '#8C9591',
    tagged: '#0E7490',
    untagged: '#8C9591',
    gateway: '#B5321E',
    attached: '#8C9591',
    routing: '#1B5E8C',
    'dep-hard': '#B5321E',
    'dep-soft': '#8C9591',
  },

  zone: {
    trust: { fill: '#E8F2EE', stroke: '#8FBDAE', text: '#0F7B6C' },
    dmz: { fill: '#FAF0DC', stroke: '#D9B672', text: '#8A6D1B' },
    untrust: { fill: '#FBEAE6', stroke: '#DFA396', text: '#B5321E' },
    mgmt: { fill: '#EDEBF7', stroke: '#B2A9DC', text: '#5B4AA8' },
    oob: { fill: '#EDEBF7', stroke: '#B2A9DC', text: '#5B4AA8' },
    internal: { fill: '#F1F3F0', stroke: '#C9CFC8', text: '#5C6663' },
    external: { fill: '#FBEAE6', stroke: '#DFA396', text: '#B5321E' },
  },

  fontDisplay: "'Inter Tight', 'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontData: MONO,

  radius: 6,
  strokeWidth: 1.4,
  edgeWidth: 1.5,
  glow: 0,
  gridStyle: 'none',
};

/* --------------------------------------------------------------------- *
 * graphite — monochrome. For formal documents, black-and-white printing,
 * and audits where colour would imply meaning the model does not carry.
 * Media is encoded by dash pattern and weight instead of hue.
 * --------------------------------------------------------------------- */
themes.graphite = {
  id: 'graphite',
  label: 'Graphite',
  mode: 'light',
  description: 'Monochrome. Meaning carried by weight and dash, not hue.',

  bg: '#FFFFFF',
  bgAlt: '#F4F4F4',
  grid: '#ECECEC',
  gridAccent: '#E0E0E0',

  surface: '#FFFFFF',
  surfaceAlt: '#F4F4F4',
  surfaceRaised: '#FFFFFF',
  stroke: '#9A9A9A',
  strokeSoft: '#D2D2D2',
  strokeStrong: '#1A1A1A',

  text: '#111111',
  textMuted: '#5A5A5A',
  textFaint: '#8E8E8E',

  role: {
    internet: '#7A7A7A', wan: '#3A3A3A', router: '#1A1A1A', firewall: '#000000',
    loadbalancer: '#3A3A3A', core: '#1A1A1A', distribution: '#3A3A3A', access: '#3A3A3A',
    wireless: '#5A5A5A', hypervisor: '#3A3A3A', server: '#3A3A3A', storage: '#5A5A5A',
    container: '#3A3A3A', service: '#3A3A3A', appliance: '#7A7A7A', client: '#7A7A7A',
    vlan: '#3A3A3A', network: '#1A1A1A', external: '#5A5A5A',
  },

  media: {
    copper: '#1A1A1A', fiber: '#1A1A1A', virtual: '#8E8E8E', wireless: '#5A5A5A',
    wan: '#000000', console: '#B0B0B0', tagged: '#1A1A1A', untagged: '#8E8E8E',
    gateway: '#000000', attached: '#8E8E8E', routing: '#1A1A1A',
    'dep-hard': '#1A1A1A', 'dep-soft': '#8E8E8E',
  },

  zone: {
    trust: { fill: '#F7F7F7', stroke: '#B0B0B0', text: '#5A5A5A' },
    dmz: { fill: '#F0F0F0', stroke: '#9A9A9A', text: '#3A3A3A' },
    untrust: { fill: '#EAEAEA', stroke: '#7A7A7A', text: '#1A1A1A' },
    mgmt: { fill: '#F7F7F7', stroke: '#B0B0B0', text: '#5A5A5A' },
    oob: { fill: '#F7F7F7', stroke: '#B0B0B0', text: '#5A5A5A' },
    internal: { fill: '#FAFAFA', stroke: '#C8C8C8', text: '#5A5A5A' },
    external: { fill: '#EAEAEA', stroke: '#7A7A7A', text: '#1A1A1A' },
  },

  fontDisplay: "'Inter Tight', 'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontData: MONO,

  radius: 3,
  strokeWidth: 1.3,
  edgeWidth: 1.4,
  glow: 0,
  gridStyle: 'none',
  monochrome: true,
};

/* --------------------------------------------------------------------- *
 * aurora — for the room with the projector. Deep indigo ground, glass
 * node cards, luminous links. This is the theme the 3D view was tuned
 * against; the depth cueing has somewhere to go.
 * --------------------------------------------------------------------- */
themes.aurora = {
  id: 'aurora',
  label: 'Aurora',
  mode: 'dark',
  description: 'Presentation. Glass cards, luminous links, deep indigo.',

  bg: '#0B0E1F',
  bgAlt: '#070917',
  grid: '#171B38',
  gridAccent: '#1F2449',

  surface: '#161B36',
  surfaceAlt: '#1D2345',
  surfaceRaised: '#242B54',
  stroke: '#3A4272',
  strokeSoft: '#2A3059',
  strokeStrong: '#5A63A0',

  text: '#EDEFFF',
  textMuted: '#9AA1D0',
  textFaint: '#666DA0',

  role: {
    internet: '#8E96C8', wan: '#F072B6', router: '#56CFE1', firewall: '#FF5E7D',
    loadbalancer: '#FFB86B', core: '#5390D9', distribution: '#64DFDF', access: '#64DFDF',
    wireless: '#B388FF', hypervisor: '#80FFDB', server: '#80FFDB', storage: '#FFD166',
    container: '#80FFDB', service: '#80FFDB', appliance: '#8E96C8', client: '#9AA1D0',
    vlan: '#FFB86B', network: '#56CFE1', external: '#F072B6',
  },

  media: {
    copper: '#FFB86B', fiber: '#64DFDF', virtual: '#7C84BC', wireless: '#B388FF',
    wan: '#F072B6', console: '#4A5182', tagged: '#64DFDF', untagged: '#7C84BC',
    gateway: '#FFB86B', attached: '#6C74AC', routing: '#56CFE1',
    'dep-hard': '#F072B6', 'dep-soft': '#7C84BC',
  },

  zone: {
    trust: { fill: '#10303A', stroke: '#2F7E83', text: '#80FFDB' },
    dmz: { fill: '#39281A', stroke: '#8A6234', text: '#FFB86B' },
    untrust: { fill: '#3A1830', stroke: '#8A3364', text: '#F072B6' },
    mgmt: { fill: '#1F2352', stroke: '#4A53A8', text: '#B388FF' },
    oob: { fill: '#1F2352', stroke: '#4A53A8', text: '#B388FF' },
    internal: { fill: '#171C3B', stroke: '#333A6B', text: '#9AA1D0' },
    external: { fill: '#3A1830', stroke: '#8A3364', text: '#F072B6' },
  },

  fontDisplay: "'Inter Tight', 'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', Helvetica, sans-serif",
  fontData: MONO,

  radius: 14,
  strokeWidth: 1.5,
  edgeWidth: 2,
  glow: 0.55,
  gridStyle: 'dot',
};

export const THEMES: Record<string, Theme> = themes;
export const THEME_IDS: string[] = Object.keys(themes);
export const DEFAULT_THEME = 'signal';

export function getTheme(id?: string): Theme {
  const t = themes[id ?? DEFAULT_THEME];
  if (!t) {
    throw new Error(`Unknown theme "${id}". Available: ${THEME_IDS.join(', ')}`);
  }
  return t;
}

/** Dash pattern per media type. Monochrome themes lean on this for meaning. */
export function dashFor(media: string, theme: Theme): string | null {
  const mono = theme.monochrome;
  switch (media) {
    case 'fiber': return mono ? '10 3' : null;
    case 'virtual': return '4 4';
    case 'wireless': return '2 4';
    case 'console': return '1 3';
    case 'wan': return mono ? '14 3 2 3' : null;
    case 'tagged': return mono ? '10 3' : null;
    case 'untagged': return null;
    case 'attached': return '5 4';
    case 'routing': return '9 4';
    // A soft dependency is the one fact on the dep layer that colour alone
    // would not carry in a monochrome theme, so it is dashed everywhere.
    case 'dep-soft': return '6 4';
    case 'dep-hard': return null;
    default: return null;
  }
}

/** Relative line weight per media type. */
export function weightFor(media: string, theme: Theme): number {
  const base = theme.edgeWidth;
  switch (media) {
    case 'wan': return base * 1.6;
    case 'fiber': return base * 1.25;
    case 'gateway': return base * 1.5;
    case 'dep-hard': return base * 1.4;
    case 'dep-soft': return base * 0.85;
    case 'console':
    case 'attached':
    case 'untagged': return base * 0.85;
    default: return base;
  }
}

/** Emit theme tokens as CSS custom properties for the HTML viewer. */
export function themeToCss(theme: Theme): string {
  const flat: Record<string, string> = {
    'nd-bg': theme.bg,
    'nd-bg-alt': theme.bgAlt,
    'nd-grid': theme.grid,
    'nd-grid-accent': theme.gridAccent,
    'nd-surface': theme.surface,
    'nd-surface-alt': theme.surfaceAlt,
    'nd-surface-raised': theme.surfaceRaised,
    'nd-stroke': theme.stroke,
    'nd-stroke-soft': theme.strokeSoft,
    'nd-stroke-strong': theme.strokeStrong,
    'nd-text': theme.text,
    'nd-text-muted': theme.textMuted,
    'nd-text-faint': theme.textFaint,
    'nd-font-display': theme.fontDisplay,
    'nd-font-body': theme.fontBody,
    'nd-font-data': theme.fontData,
    'nd-radius': `${theme.radius}px`,
  };
  for (const [k, v] of Object.entries(theme.role)) flat[`nd-role-${k}`] = v;
  for (const [k, v] of Object.entries(theme.media)) flat[`nd-media-${k}`] = v;
  return Object.entries(flat)
    .map(([k, v]) => `  --${k}: ${v};`)
    .join('\n');
}

/**
 * Level of detail.
 *
 * The rule for what may be dropped is not taste: an element qualifies only
 * when it is already illegible at the zoom that triggers the level. A 7.5px
 * vendor mark is gone by 85% zoom; a 6-unit port is a smudge below 45%. The
 * device name, its role colour, the cable media colour and the topology are
 * never dropped, so nothing a reader could have read is taken away.
 */
export const DETAIL_LEVELS: string[] = ['full', 'mid', 'low'];

export function detailFlags(level = 'full'): DetailFlags {
  if (!DETAIL_LEVELS.includes(level)) {
    throw new Error(`Unknown detail level "${level}". Use ${DETAIL_LEVELS.join(', ')}.`);
  }
  return {
    level,
    vendor: level === 'full',
    sub: level === 'full',
    glow: level === 'full',
    chassis: level !== 'low',
    chip: level !== 'low',
  };
}
