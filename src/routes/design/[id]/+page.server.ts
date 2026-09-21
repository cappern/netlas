import { readFileSync } from 'node:fs';
import { error } from '@sveltejs/kit';
import { activeWorkspace, linksFromDesign } from '$lib/server/workspace.ts';
import { renderLayers } from '$lib/render/pipeline.ts';
import type { PageServerLoad } from './$types';

/** Load one design: its rendered layers, raw YAML, and its cross-design links. */
export const load: PageServerLoad = async ({ params }) => {
  const { ws, links, dangling } = activeWorkspace();
  const design = ws.designs.find((d) => d.id === params.id);
  if (!design) error(404, `No design "${params.id}" in this workspace`);

  const rendered = design.diagnostics.ok
    ? await renderLayers(design.model)
    : { theme: null, layers: [], impact: {} };

  return {
    id: design.id,
    title: design.title,
    meta: design.model.meta,
    // The full model travels to the client so the editor can re-render live.
    model: design.model,
    ok: design.diagnostics.ok,
    diagnostics: {
      errors: design.diagnostics.errors,
      warnings: design.diagnostics.warnings,
    },
    yaml: readFileSync(design.file, 'utf8'),
    ...rendered,
    // Links out of this design, keyed by the node they leave from, plus the
    // set of designs available as link targets.
    outLinks: linksFromDesign(links, design.id),
    targets: ws.designs.filter((d) => d.id !== design.id).map((d) => ({ id: d.id, title: d.title })),
    dangling: dangling.filter((d) => String(d.link.from).split(':')[0] === design.id),
  };
};
