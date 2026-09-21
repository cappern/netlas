<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let adding = $state(false);
  let newId = $state('');
  let newTitle = $state('');
  let error = $state('');

  // Links grouped by source design, so each card can show what it drills into.
  let linksByDesign = $derived.by(() => {
    const map: Record<string, any[]> = {};
    for (const l of data.links) (map[l.from] ??= []).push(l);
    return map;
  });

  async function addDesign(event: SubmitEvent) {
    event.preventDefault();
    error = '';
    const res = await fetch('/api/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: newId.trim(), title: newTitle.trim() }),
    });
    const body = await res.json();
    if (!res.ok) { error = body.error ?? 'Could not add design'; return; }
    adding = false;
    newId = ''; newTitle = '';
    await invalidateAll();
    goto(`/design/${body.id}`);
  }
</script>

<div class="overview">
  <header class="overview__head">
    <div>
      <div class="micro">Workspace</div>
      <h1>Portfolio</h1>
    </div>
    <button class="btn btn--primary" onclick={() => (adding = !adding)}>+ Add design</button>
  </header>

  {#if adding}
    <form class="add" onsubmit={addDesign}>
      <input class="field" placeholder="id (slug, e.g. branch-oslo)" bind:value={newId} required />
      <input class="field" placeholder="Title (optional)" bind:value={newTitle} />
      <button class="btn btn--primary" type="submit">Create</button>
      <button class="btn btn--ghost" type="button" onclick={() => (adding = false)}>Cancel</button>
      {#if error}<span class="add__err">{error}</span>{/if}
    </form>
  {/if}

  {#if data.dangling.length}
    <div class="warn">
      {data.dangling.length} link{data.dangling.length === 1 ? '' : 's'} could not be resolved:
      <ul>{#each data.dangling as d}<li>{d.from} → {d.to} — {d.reason}</li>{/each}</ul>
    </div>
  {/if}

  <div class="grid">
    {#each data.designs as d (d.id)}
      <a class="card" href="/design/{d.id}">
        <div class="card__top">
          <h2>{d.title}</h2>
          {#if d.ok}<span class="dot dot--ok" title="valid"></span>{:else}<span class="badge badge--err">{d.errors} error{d.errors === 1 ? '' : 's'}</span>{/if}
        </div>
        {#if d.subtitle}<p class="card__sub">{d.subtitle}</p>{/if}
        <div class="card__stats">
          <span>{d.devices} devices</span>
          <span>{d.vlans} VLANs</span>
          {#if d.warnings}<span class="muted">{d.warnings} warning{d.warnings === 1 ? '' : 's'}</span>{/if}
        </div>
        {#if linksByDesign[d.id]}
          <div class="card__links">
            {#each linksByDesign[d.id] as l}
              <span class="chip">{l.node} → {l.to}</span>
            {/each}
          </div>
        {/if}
      </a>
    {/each}
  </div>
</div>

<style>
  .overview { padding: 28px 32px; max-width: 1100px; height: 100%; overflow-y: auto; }
  .overview__head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 22px; }
  h1 { margin: 4px 0 0; font-size: 26px; letter-spacing: -0.02em; }
  .add { display: flex; gap: 10px; align-items: center; margin-bottom: 20px; flex-wrap: wrap; }
  .field { font: inherit; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 8px; padding: 7px 11px; min-width: 220px; }
  .add__err { color: var(--err); }
  .warn { background: rgba(224,108,117,0.1); border: 1px solid rgba(224,108,117,0.3); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 20px; color: var(--err); }
  .warn ul { margin: 8px 0 0; padding-left: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; display: flex; flex-direction: column; gap: 10px; transition: border-color 0.12s; }
  .card:hover { border-color: var(--accent); }
  .card__top { display: flex; justify-content: space-between; align-items: center; }
  .card__top h2 { margin: 0; font-size: 17px; }
  .card__sub { margin: 0; color: var(--muted); font-size: 13px; }
  .card__stats { display: flex; gap: 14px; color: var(--faint); font-size: 12px; }
  .card__stats .muted { color: var(--muted); }
  .card__links { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
  .chip { font-size: 11px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; color: var(--accent); }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .dot--ok { background: var(--ok); }
</style>
