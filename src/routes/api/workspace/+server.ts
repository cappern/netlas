import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { json, error } from '@sveltejs/kit';
import { parseManifest, manifestPath } from '$lib/core/workspace/index.ts';
import type { Manifest } from '$lib/core/workspace/index.ts';
import { workspaceDir } from '$lib/server/workspace.ts';
import type { RequestHandler } from './$types';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A minimal, valid starter model for a freshly added design: just a title.
 *  The author fills it in from the palette — no placeholder devices to delete. */
function starterYaml(title: string): string {
  return `meta:\n  title: ${title}\ndevices: []\n`;
}

function readManifest(): { mpath: string; manifest: Manifest } {
  const mpath = manifestPath(workspaceDir());
  const manifest = parseManifest(readFileSync(mpath, 'utf8'), mpath);
  return { mpath, manifest };
}

function writeManifest(mpath: string, manifest: Manifest): void {
  writeFileSync(mpath, yaml.dump(manifest, { lineWidth: 100, noRefs: true }));
}

/**
 * Mutations on the workspace manifest: add a design, add a link, remove a link.
 * The default action (no `action`) adds a design, so the overview's simple
 * "Add design" form can post just { id, title }.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json();
  const action = body.action ?? 'add-design';
  const { mpath, manifest } = readManifest();
  const dir = workspaceDir();

  if (action === 'add-design') {
    const id = String(body.id ?? '').trim();
    const title = String(body.title ?? '').trim() || id;
    if (!SLUG.test(id)) return json({ error: 'id must be a slug (a-z, 0-9, dashes)' }, { status: 400 });
    if (manifest.designs.some((d) => d.id === id)) return json({ error: `design "${id}" already exists` }, { status: 400 });

    const file = `${id}.netlas.yaml`;
    const abs = join(dir, file);
    if (!existsSync(abs)) writeFileSync(abs, starterYaml(title));
    manifest.designs.push({ id, file, title });
    writeManifest(mpath, manifest);
    return json({ ok: true, id });
  }

  if (action === 'add-link') {
    const { from, to, kind, description } = body;
    if (!from || !to) return json({ error: 'from and to are required' }, { status: 400 });
    if (!manifest.designs.some((d) => d.id === to)) return json({ error: `no design "${to}"` }, { status: 400 });
    manifest.links.push({ from, to, ...(kind ? { kind } : {}), ...(description ? { description } : {}) });
    writeManifest(mpath, manifest);
    return json({ ok: true });
  }

  if (action === 'remove-link') {
    const { from, to } = body;
    manifest.links = manifest.links.filter((l) => !(l.from === from && l.to === to));
    writeManifest(mpath, manifest);
    return json({ ok: true });
  }

  error(400, `Unknown action "${action}"`);
};
