import { activeWorkspace } from '$lib/server/workspace.ts';
import type { LayoutServerLoad } from './$types';

/** The sidebar needs the workspace name and its design list on every page. */
export const load: LayoutServerLoad = () => {
  const { ws, links } = activeWorkspace();
  return {
    workspace: {
      name: ws.name,
      designs: ws.designs.map((d) => ({
        id: d.id,
        title: d.title,
        devices: d.model.devices.length,
        ok: d.diagnostics.ok,
        errors: d.diagnostics.errors.length,
      })),
      linkCount: links.length,
    },
  };
};
