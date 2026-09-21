import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import yaml from 'js-yaml';
import { parseModel, indexModel, normalizeModel } from '../model/load.ts';
import { loadModel } from '../model/load-file.ts';
import { validateModel } from '../model/validate.ts';
import type { Model, Diagnostics } from '../model/types.ts';

/** A design as declared in the manifest. */
export interface DesignEntry {
  id: string;
  file: string;
  title?: string;
}

/** A cross-design link as declared in the manifest. */
export interface WorkspaceLink {
  from: string;
  to: string;
  kind?: string;
  description?: string;
}

/** A parsed, un-loaded workspace manifest. */
export interface Manifest {
  name: string;
  designs: DesignEntry[];
  links: WorkspaceLink[];
}

/** A design after its model has been loaded and validated. */
export interface LoadedDesign {
  id: string;
  file: string;
  relFile: string;
  title: string;
  model: Model;
  diagnostics: Diagnostics;
}

/** A fully loaded workspace. */
export interface Workspace {
  dir: string;
  manifestPath: string;
  name: string;
  designs: LoadedDesign[];
  links: WorkspaceLink[];
}

/** A resolved cross-design link. */
export interface ResolvedLink {
  from: string;
  fromDesign: string;
  fromNode: string | null;
  to: string;
  kind: string;
  description: string;
}

/**
 * A workspace is a folder holding several designs and the links between them —
 * the portfolio the Studio edits and the CLI can export. It is deliberately a
 * thin layer over the single-design model: each design is an ordinary
 * validated model, and the manifest only records which files belong together
 * and how a node in one design points at another design.
 *
 * Manifest (workspace.netlas.yaml):
 *
 *   name: My Portfolio
 *   designs:
 *     - { id: core-dc, file: core-dc.netlas.yaml, title: Core Datacenter }
 *     - { id: branch-a, file: branch-a.netlas.yaml }
 *   links:
 *     - { from: core-dc:fw-edge-1, to: branch-a, kind: uplink, description: MPLS }
 *
 * A link's `from` is "<designId>:<nodeId>", where nodeId is a device or
 * external id in that design; `to` is another design's id. The designId is a
 * simple slug and never contains a colon, so from is split on the first colon
 * (the nodeId may itself contain colons).
 */

export const MANIFEST_NAME = 'workspace.netlas.yaml';

/** Locate the manifest given a directory or a direct path to the manifest. */
export function manifestPath(dir: string): string {
  const abs = resolve(dir);
  if (abs.endsWith('.yaml') || abs.endsWith('.yml')) return abs;
  return join(abs, MANIFEST_NAME);
}

/**
 * Read a workspace: parse the manifest, then load and validate every design it
 * lists. Design files are resolved relative to the manifest's directory. The
 * returned designs each carry their validated model plus its diagnostics, so a
 * caller can decide whether to render, warn, or refuse.
 */
export function loadWorkspace(dir: string): Workspace {
  const mpath = manifestPath(dir);
  if (!existsSync(mpath)) {
    const e: Error & { code?: string } = new Error(`No workspace manifest at ${mpath}`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  const manifest = parseManifest(readFileSync(mpath, 'utf8'), mpath);
  const base = dirname(mpath);

  const designs = manifest.designs.map((d) => {
    const file = resolve(base, d.file);
    const model = loadModel(file);
    return {
      id: d.id,
      file,
      relFile: d.file,
      title: d.title ?? model.meta.title,
      model,
      diagnostics: validateModel(model),
    };
  });

  return {
    dir: base,
    manifestPath: mpath,
    name: manifest.name,
    designs,
    links: manifest.links,
  };
}

/** Parse and normalise a manifest without touching the filesystem. */
export function parseManifest(text: string, source = '<inline>'): Manifest {
  let raw: unknown;
  try {
    raw = yaml.load(text, { filename: source });
  } catch (err) {
    const e: Error & { code?: string } = new Error(`Cannot parse ${source}: ${(err as Error).message}`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e: Error & { code?: string } = new Error(`${source} must contain a YAML mapping at the top level`);
    e.code = 'PARSE_ERROR';
    throw e;
  }
  const r = raw as { designs?: unknown; name?: string; links?: unknown };
  const designs = (Array.isArray(r.designs) ? r.designs : []) as DesignEntry[];
  const seen = new Set<string>();
  for (const d of designs) {
    if (!d || !d.id || !d.file) {
      const e: Error & { code?: string } = new Error(`${source}: every design needs an id and a file`);
      e.code = 'PARSE_ERROR';
      throw e;
    }
    if (seen.has(d.id)) {
      const e: Error & { code?: string } = new Error(`${source}: duplicate design id "${d.id}"`);
      e.code = 'PARSE_ERROR';
      throw e;
    }
    seen.add(d.id);
  }
  return {
    name: r.name ?? 'Untitled workspace',
    designs,
    links: (Array.isArray(r.links) ? r.links : []) as WorkspaceLink[],
  };
}

/** Split a link's `from` into { design, node } on the first colon. */
export function parseLinkFrom(from: string): { design: string; node: string | null } {
  const idx = String(from).indexOf(':');
  if (idx === -1) return { design: String(from), node: null };
  return { design: from.slice(0, idx), node: from.slice(idx + 1) };
}

/**
 * Validate every link against the loaded designs and return a resolved link
 * graph. A link is dangling when its source design or node does not exist, or
 * when it points at a design that is not in the workspace. JSON-shape checks
 * cannot catch these — only cross-design resolution can, which is why it lives
 * here.
 *
 * @returns {{ links: Array, dangling: Array<{link, reason}> }}
 */
export function resolveLinks(workspace: Workspace): { links: ResolvedLink[]; dangling: { link: WorkspaceLink; reason: string }[] } {
  const byId = new Map<string, LoadedDesign>(workspace.designs.map((d) => [d.id, d]));
  const indices = new Map(workspace.designs.map((d) => [d.id, indexModel(d.model)]));

  const links: ResolvedLink[] = [];
  const dangling: { link: WorkspaceLink; reason: string }[] = [];
  for (const link of workspace.links) {
    const { design, node } = parseLinkFrom(link.from);
    const src = byId.get(design);
    if (!src) {
      dangling.push({ link, reason: `no design "${design}"` });
      continue;
    }
    if (node) {
      const ix = indices.get(design)!;
      if (!ix.devices.has(node) && !ix.externals.has(node)) {
        dangling.push({ link, reason: `design "${design}" has no device or external "${node}"` });
        continue;
      }
    }
    if (!byId.has(link.to)) {
      dangling.push({ link, reason: `no design "${link.to}" to link to` });
      continue;
    }
    links.push({
      from: link.from,
      fromDesign: design,
      fromNode: node,
      to: link.to,
      kind: link.kind ?? 'link',
      description: link.description ?? '',
    });
  }
  return { links, dangling };
}

/** Serialise a workspace back to its manifest shape (id/file/title + links). */
export function manifestOf(workspace: Workspace): Manifest {
  return {
    name: workspace.name,
    designs: workspace.designs.map((d) => {
      const entry: DesignEntry = { id: d.id, file: d.relFile ?? d.file };
      if (d.title && d.title !== d.model?.meta?.title) entry.title = d.title;
      return entry;
    }),
    links: workspace.links,
  };
}

/** Write the manifest back to disk (used by the Studio on edit). */
export function saveWorkspace(workspace: Workspace): void {
  const text = yaml.dump(manifestOf(workspace), { lineWidth: 100, noRefs: true });
  writeFileSync(workspace.manifestPath ?? manifestPath(workspace.dir), text);
}

/**
 * Write one design's YAML back to disk after validating it, so the Studio
 * never persists a model that would not load again. Returns the diagnostics.
 */
export function saveDesign(file: string, model: Model): Diagnostics {
  // Validate against a normalised copy (so a hand-built model missing its
  // empty arrays still checks), but write the model as given to keep the YAML
  // free of defaulted empty sections. An invalid model is never written — the
  // caller gets the diagnostics and the file on disk stays loadable.
  const diagnostics = validateModel(normalizeModel(model));
  if (diagnostics.ok) {
    writeFileSync(resolve(file), yaml.dump(model, { lineWidth: 120, noRefs: true, sortKeys: false }));
  }
  return diagnostics;
}

/** Parse + validate design YAML text without writing (Studio live edit). */
export function checkDesign(text: string, source = '<inline>'): { model: Model; diagnostics: Diagnostics } {
  const model = parseModel(text, source);
  return { model, diagnostics: validateModel(model) };
}
