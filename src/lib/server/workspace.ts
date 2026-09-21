import { resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { loadWorkspace, resolveLinks } from '$lib/core/workspace/index.ts';
import type { Workspace, ResolvedLink } from '$lib/core/workspace/index.ts';

/**
 * The Studio edits one workspace at a time. Which folder that is comes from
 * NETLAS_WORKSPACE (set when launching the Studio), falling back to the bundled
 * example portfolio so a fresh checkout has something to open.
 */
export function workspaceDir(): string {
  return resolve(env.NETLAS_WORKSPACE ?? 'examples/portfolio');
}

export interface ActiveWorkspace {
  ws: Workspace;
  links: ResolvedLink[];
  dangling: { link: { from: string; to: string }; reason: string }[];
}

/** Load the active workspace together with its resolved cross-design links. */
export function activeWorkspace(): ActiveWorkspace {
  const ws = loadWorkspace(workspaceDir());
  const { links, dangling } = resolveLinks(ws);
  return { ws, links, dangling };
}

/** The links whose source node lives in a given design, keyed by node id. */
export function linksFromDesign(links: ResolvedLink[], designId: string): Record<string, ResolvedLink[]> {
  const byNode: Record<string, ResolvedLink[]> = {};
  for (const link of links) {
    if (link.fromDesign !== designId || !link.fromNode) continue;
    (byNode[link.fromNode] ??= []).push(link);
  }
  return byNode;
}
