import { writeFileSync } from 'node:fs';
import { json, error } from '@sveltejs/kit';
import { loadWorkspace, checkDesign, saveDesign } from '$lib/core/workspace/index.ts';
import { formatDiagnostics } from '$lib/core/model/validate.ts';
import { workspaceDir } from '$lib/server/workspace.ts';
import type { RequestHandler } from './$types';

/** Save a design's YAML, but only if it still parses and validates. */
export const PUT: RequestHandler = async ({ params, request }) => {
  const { yaml } = await request.json();
  if (typeof yaml !== 'string') error(400, 'Expected a yaml string');

  const ws = loadWorkspace(workspaceDir());
  const design = ws.designs.find((d) => d.id === params.id);
  if (!design) error(404, `No design "${params.id}"`);

  let checked;
  try {
    checked = checkDesign(yaml, design.file);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }
  if (!checked.diagnostics.ok) {
    return json(
      { error: `${checked.diagnostics.errors.length} validation error(s)`, errors: checked.diagnostics.errors },
      { status: 400 },
    );
  }

  // Write the text as authored so comments and formatting survive.
  writeFileSync(design.file, yaml);
  return json({ ok: true, warnings: checked.diagnostics.warnings, diagnostics: formatDiagnostics(checked.diagnostics) });
};

/**
 * Persist a model edited visually in the editor. The client sends the whole
 * model as JSON; saveDesign validates a normalised copy and dumps YAML, so a
 * visual edit can never write a model that would not load again.
 */
export const PATCH: RequestHandler = async ({ params, request }) => {
  const { model } = await request.json();
  if (!model || typeof model !== 'object') error(400, 'Expected a model object');

  const ws = loadWorkspace(workspaceDir());
  const design = ws.designs.find((d) => d.id === params.id);
  if (!design) error(404, `No design "${params.id}"`);

  const diagnostics = saveDesign(design.file, model);
  if (!diagnostics.ok) {
    return json({ error: `${diagnostics.errors.length} validation error(s)`, errors: diagnostics.errors }, { status: 400 });
  }
  return json({ ok: true, warnings: diagnostics.warnings });
};
