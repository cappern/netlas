/**
 * Device glyphs on a 24x24 grid.
 *
 * These are drawn here rather than imported from a vendor icon set on
 * purpose: Cisco's and Palo Alto's official icon libraries carry usage
 * terms that do not survive redistribution inside a generated artifact.
 * Vendor identity is instead carried by a short text mark on the node,
 * which is accurate and unrestricted.
 *
 * Every glyph is stroke-only so it inherits the node's role colour, and
 * every glyph shares one 1.6 stroke weight so a diagram never looks like
 * it was assembled from three different icon families.
 */

const G: Record<string, string> = {
  internet: `
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M3.5 12h17"/>
    <path d="M12 3.5c2.6 2.4 4 5.4 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.4-4-8.5s1.4-6.1 4-8.5z"/>`,

  wan: `
    <path d="M5 15.5h14"/>
    <path d="M7.5 15.5V11a4.5 4.5 0 0 1 9 0v4.5"/>
    <circle cx="12" cy="6.5" r="2"/>
    <path d="M3 19.5h18"/>`,

  router: `
    <rect x="3" y="9" width="18" height="10" rx="2"/>
    <path d="M8 6.5 8 2.5M8 2.5l-2 2M8 2.5l2 2"/>
    <path d="M16 2.5 16 6.5M16 6.5l-2-2M16 6.5l2-2"/>
    <path d="M7 14h2M11 14h2M15 14h2"/>`,

  firewall: `
    <rect x="3" y="5" width="18" height="14" rx="1.5"/>
    <path d="M3 9.7h18M3 14.3h18"/>
    <path d="M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19"/>`,

  core: `
    <rect x="2.5" y="7" width="19" height="10" rx="2"/>
    <path d="M6 11.2h7M13 11.2l-2-1.6M13 11.2l-2 1.6"/>
    <path d="M18 12.8h-7M11 12.8l2-1.6M11 12.8l2 1.6"/>
    <path d="M5 4.5v2.5M19 4.5v2.5M5 17v2.5M19 17v2.5"/>`,

  distribution: `
    <rect x="2.5" y="7.5" width="19" height="9" rx="2"/>
    <path d="M6 11h7M13 11l-2-1.6M13 11l-2 1.6"/>
    <path d="M18 13h-7M11 13l2-1.6M11 13l2 1.6"/>`,

  access: `
    <rect x="2.5" y="8" width="19" height="8" rx="1.8"/>
    <path d="M5.5 12h13"/>
    <path d="M7 16v2M10 16v2M13 16v2M16 16v2"/>`,

  wireless: `
    <rect x="6" y="13" width="12" height="7" rx="1.8"/>
    <path d="M9 16.5h6"/>
    <path d="M8.2 9.8a5.4 5.4 0 0 1 7.6 0"/>
    <path d="M5.6 7a9 9 0 0 1 12.8 0"/>`,

  loadbalancer: `
    <rect x="9" y="2.5" width="6" height="5" rx="1.2"/>
    <rect x="2.5" y="16.5" width="6" height="5" rx="1.2"/>
    <rect x="15.5" y="16.5" width="6" height="5" rx="1.2"/>
    <path d="M12 7.5v4M12 11.5H5.5v5M12 11.5h6.5v5"/>`,

  server: `
    <rect x="4" y="3" width="16" height="6" rx="1.4"/>
    <rect x="4" y="11" width="16" height="6" rx="1.4"/>
    <path d="M7 6h5M7 14h5"/>
    <circle cx="16.5" cy="6" r="0.9"/>
    <circle cx="16.5" cy="14" r="0.9"/>
    <path d="M8 19.5h8"/>`,

  hypervisor: `
    <rect x="2.5" y="4" width="19" height="16" rx="2"/>
    <rect x="5.5" y="7" width="5.5" height="4.5" rx="0.8"/>
    <rect x="13" y="7" width="5.5" height="4.5" rx="0.8"/>
    <rect x="5.5" y="13.5" width="5.5" height="3.5" rx="0.8"/>
    <rect x="13" y="13.5" width="5.5" height="3.5" rx="0.8"/>`,

  storage: `
    <ellipse cx="12" cy="6" rx="8" ry="3"/>
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>`,

  container: `
    <path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7z"/>
    <path d="M3.5 7 12 11.3 20.5 7M12 11.3V21.2"/>`,

  service: `
    <circle cx="12" cy="12" r="3.2"/>
    <path d="M12 2.8v3.4M12 17.8v3.4M21.2 12h-3.4M6.2 12H2.8"/>
    <path d="M18.5 5.5 16.1 7.9M7.9 16.1l-2.4 2.4M18.5 18.5l-2.4-2.4M7.9 7.9 5.5 5.5"/>`,

  appliance: `
    <rect x="3" y="6" width="18" height="12" rx="2"/>
    <path d="M6.5 10h6M6.5 14h4"/>
    <circle cx="17.5" cy="12" r="1.6"/>`,

  client: `
    <rect x="2.5" y="4" width="19" height="12" rx="1.8"/>
    <path d="M8 20h8M12 16v4"/>
    <path d="M6 8h7"/>`,

  vlan: `
    <path d="M3 8.5a2 2 0 0 1 2-2h8.4l7.1 5.5-7.1 5.5H5a2 2 0 0 1-2-2z"/>
    <circle cx="7.3" cy="12" r="1.4"/>`,

  network: `
    <path d="M3 9h18"/>
    <path d="M7 9v3.5M12 9v3.5M17 9v3.5"/>
    <rect x="4.6" y="12.5" width="4.8" height="4" rx="1"/>
    <rect x="14.6" y="12.5" width="4.8" height="4" rx="1"/>
    <path d="M12 12.5v6"/>`,

  external: `
    <path d="M6.5 18.5h11a4 4 0 0 0 .6-7.95 6 6 0 0 0-11.5-1.6A3.9 3.9 0 0 0 6.5 18.5z"/>
    <path d="M12 8.5v6"/>
    <path d="M9.5 12 12 14.5 14.5 12"/>`,
};

G.internet = G.internet.trim();

/** Roles that share a glyph. */
const ALIAS: Record<string, string> = {
  distribution: 'distribution',
  container: 'container',
};

export function iconPaths(role: string): string {
  return (G[ALIAS[role] ?? role] ?? G.appliance).trim();
}

/**
 * Render a glyph as an SVG group, scaled and translated into place.
 * `size` is the target edge length in diagram units.
 */
export function icon(role: string, x: number, y: number, size: number, color: string, strokeWidth = 1.6): string {
  const s = size / 24;
  return (
    `<g transform="translate(${r(x)} ${r(y)}) scale(${r(s)})" ` +
    `fill="none" stroke="${color}" stroke-width="${r(strokeWidth / s)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${iconPaths(role)}</g>`
  );
}

/** Short, unrestricted text mark. Never a logo. */
export const VENDOR_MARK: Record<string, string> = {
  cisco: 'CISCO',
  paloalto: 'PALO ALTO',
  fortinet: 'FORTINET',
  juniper: 'JUNIPER',
  arista: 'ARISTA',
  microsoft: 'WINDOWS',
  linux: 'LINUX',
  vmware: 'VMWARE',
  proxmox: 'PROXMOX',
  aws: 'AWS',
  azure: 'AZURE',
  git: 'GIT',
  generic: '',
};

function r(n: number): number {
  return Math.round(n * 1000) / 1000;
}
