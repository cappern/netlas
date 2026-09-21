import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseModel } from './load.ts';
import type { Model } from './types.ts';

/**
 * Read and parse a model from a file. Kept apart from load.mjs so that module
 * stays free of node:fs and can be bundled for the browser — the Studio derives
 * and renders models client-side, and must not drag the filesystem in with it.
 */
export function loadModel(path: string): Model {
  const abs = resolve(path);
  return parseModel(readFileSync(abs, 'utf8'), abs);
}
