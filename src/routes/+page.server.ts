import { activeWorkspace } from '$lib/server/workspace.ts';
import type { PageServerLoad } from './$types';

/** The overview shows every design as a card and the links between them. */
export const load: PageServerLoad = () => {
  const { ws, links, dangling } = activeWorkspace();
  return {
    designs: ws.designs.map((d) => ({
      id: d.id,
      title: d.title,
      subtitle: d.model.meta.subtitle ?? '',
      devices: d.model.devices.length,
      vlans: d.model.vlans.length,
      ok: d.diagnostics.ok,
      errors: d.diagnostics.errors.length,
      warnings: d.diagnostics.warnings.length,
    })),
    links: links.map((l) => ({ from: l.fromDesign, node: l.fromNode, to: l.to, kind: l.kind, description: l.description })),
    dangling: dangling.map((d) => ({ from: d.link.from, to: d.link.to, reason: d.reason })),
  };
};
