<script lang="ts">
  import { invalidateAll } from '$app/navigation';

  // Manage the cross-design links that leave this design. Each link ties a
  // node (device/external) in this design to another design in the workspace.
  interface OutLink { to: string; kind: string; description?: string; }

  interface Props {
    id: string;
    nodes: { id: string; label: string }[];
    targets: { id: string; title: string }[];
    outLinks: Record<string, OutLink[]>;
  }

  let { id, nodes, targets, outLinks }: Props = $props();

  // Flatten the { node: [links] } map into rows for display.
  let rows = $derived(Object.entries(outLinks).flatMap(([node, links]) => links.map((l) => ({ node, ...l }))));

  let fromNode = $state('');
  let toDesign = $state('');
  let kind = $state('drilldown');
  let description = $state('');
  let busy = $state(false);
  let error = $state('');

  async function post(action: string, payload: Record<string, unknown>) {
    busy = true; error = '';
    try {
      const res = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });
      const body = await res.json();
      if (!res.ok) { error = body.error ?? 'Failed'; return false; }
      await invalidateAll();
      return true;
    } finally {
      busy = false;
    }
  }

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!fromNode || !toDesign) { error = 'Pick a node and a target design'; return; }
    const ok = await post('add-link', { from: `${id}:${fromNode}`, to: toDesign, kind, description });
    if (ok) { fromNode = ''; toDesign = ''; description = ''; }
  }

  async function remove(row: { node: string } & OutLink) {
    await post('remove-link', { from: `${id}:${row.node}`, to: row.to });
  }
</script>

<div class="links">
  <h3 class="micro">Cross-design links</h3>

  {#if rows.length}
    <ul class="link-list">
      {#each rows as row}
        <li>
          <span class="link-list__from">{row.node}</span>
          <span class="arrow">→</span>
          <a class="link-list__to" href="/design/{row.to}">{row.to}</a>
          <span class="link-list__kind">{row.kind}</span>
          <button class="x" onclick={() => remove(row)} aria-label="Remove link">×</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No links out of this design yet.</p>
  {/if}

  <form class="add" onsubmit={add}>
    <select bind:value={fromNode} class="field">
      <option value="" disabled>Node…</option>
      {#each nodes as n}<option value={n.id}>{n.label} ({n.id})</option>{/each}
    </select>
    <select bind:value={toDesign} class="field">
      <option value="" disabled>Links to design…</option>
      {#each targets as t}<option value={t.id}>{t.title}</option>{/each}
    </select>
    <input class="field" placeholder="kind (e.g. uplink)" bind:value={kind} />
    <input class="field" placeholder="description (optional)" bind:value={description} />
    <button class="btn btn--primary" type="submit" disabled={busy}>Add link</button>
    {#if error}<span class="err">{error}</span>{/if}
  </form>
</div>

<style>
  .links { padding: 14px 16px; border-top: 1px solid var(--line); background: var(--panel); }
  h3 { margin: 0 0 10px; }
  .link-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .link-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .link-list__from { font-family: var(--mono); }
  .arrow { color: var(--faint); }
  .link-list__to { color: var(--accent); }
  .link-list__kind { color: var(--faint); font-size: 11px; margin-left: auto; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; }
  .x:hover { color: var(--err); }
  .empty { color: var(--faint); font-size: 13px; margin: 0 0 12px; }
  .add { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .field { font: inherit; font-size: 13px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 7px; padding: 6px 9px; }
  .err { color: var(--err); font-size: 12px; width: 100%; }
</style>
