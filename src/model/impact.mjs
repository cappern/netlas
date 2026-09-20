import { indexModel, resolveDepEndpoint } from './load.mjs';

/**
 * Direct dependency adjacency, keyed by device or external id.
 *
 * Rows are merged on (neighbour, kind, strength) exactly as deriveDep merges
 * edges, so "Used by · 6" counts six systems rather than six service rows.
 * Counting rows would make the headline number disagree with the number of
 * arrows on the drawing, and would over-report severity in precisely the
 * place the feature exists to report it accurately.
 *
 * Direct neighbours only, deliberately. "ISE is used by four network access devices
 * and needs AD, PKI and NTP" is the documentation answer, and it is the answer a reader
 * can check against reality. A transitive closure is an analysis answer: it
 * is derived from facts the model may only partly carry, and presenting it
 * with the same confidence as a declared edge would overstate what the
 * drawing knows.
 *
 * Emitted once at the top level of the viewer payload rather than per layer,
 * because the same device appears on L1, L2, L3 and dep, and because the
 * inspector has no layer context to thread through.
 *
 * @returns {Record<string, { dependsOn: Entry[], usedBy: Entry[] }>}
 *   Entry = { id, label, kind, strength, services: string[], descriptions: string[] }
 */
export function buildImpactMap(model) {
  const ix = indexModel(model);
  const out = {};
  const seen = new Map();

  const labelOf = (id) =>
    ix.devices.get(id)?.label ?? ix.externals.get(id)?.label ?? id;

  const add = (ownerId, direction, neighbourId, dep, service) => {
    if (!out[ownerId]) out[ownerId] = { dependsOn: [], usedBy: [] };
    const key = `${ownerId}~${direction}~${neighbourId}~${dep.kind}~${dep.strength}`;
    let entry = seen.get(key);
    if (!entry) {
      entry = {
        id: neighbourId,
        label: labelOf(neighbourId),
        kind: dep.kind,
        strength: dep.strength,
        services: [],
        descriptions: [],
      };
      seen.set(key, entry);
      out[ownerId][direction].push(entry);
    }
    if (service && entry.services.indexOf(service) === -1) entry.services.push(service);
    if (dep.description && entry.descriptions.indexOf(dep.description) === -1) {
      entry.descriptions.push(dep.description);
    }
  };

  for (const dep of model.dependencies ?? []) {
    const from = resolveDepEndpoint(dep.from, ix);
    const to = resolveDepEndpoint(dep.to, ix);
    if (!from.holder || !to.holder || from.holder === to.holder) continue;

    add(from.holder, 'dependsOn', to.holder, dep, to.service);
    add(to.holder, 'usedBy', from.holder, dep, to.service);
  }

  return out;
}
