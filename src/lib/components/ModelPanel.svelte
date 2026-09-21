<script lang="ts">
  import type { Model } from '$lib/core/model/types.ts';

  // Edit the model's building blocks that aren't nodes on the canvas: sites,
  // zones, VLANs, subnets and dependencies. Operates on the live model proxy;
  // every change schedules a re-render via onchange().
  interface Props {
    model: Model;
    onchange?: () => void;
    onclose?: () => void;
  }

  let { model, onchange, onclose }: Props = $props();

  const SITE_KINDS = ['dc', 'branch', 'cloud', 'lab', 'edge'];
  const ZONE_KINDS = ['trust', 'dmz', 'untrust', 'mgmt', 'oob', 'internal', 'external'];
  const DEP_KINDS = ['transport', 'compute', 'auth', 'dns', 'ntp', 'pki', 'logging', 'monitoring', 'api', 'database', 'storage', 'backup', 'management', 'sync', 'license', 'other'];

  const changed = () => onchange?.();
  function ensure(key: keyof Model): any[] { (model as any)[key] ??= []; return (model as any)[key]; }
  function add(key: keyof Model, row: any) { ensure(key).push(row); changed(); }
  function remove(key: keyof Model, i: number) { (model as any)[key].splice(i, 1); changed(); }
</script>

<div class="mp">
  <header class="mp__head">
    <button class="mp__close" onclick={onclose} aria-label="Close">×</button>
    <h2>Model</h2>
  </header>

  <section class="mp__sect">
    <div class="mp__sub"><span class="micro">Sites</span><button class="mini" onclick={() => add('sites', { id: '', label: '', kind: 'dc' })}>+ Add</button></div>
    {#each model.sites ?? [] as s, i (i)}
      <div class="row">
        <input class="w-id" placeholder="id" bind:value={s.id} oninput={changed} />
        <input placeholder="label" bind:value={s.label} oninput={changed} />
        <select bind:value={s.kind} onchange={changed}>{#each SITE_KINDS as k}<option>{k}</option>{/each}</select>
        <button class="x" onclick={() => remove('sites', i)}>×</button>
      </div>
    {/each}
  </section>

  <section class="mp__sect">
    <div class="mp__sub"><span class="micro">Zones</span><button class="mini" onclick={() => add('zones', { id: '', label: '', kind: 'trust' })}>+ Add</button></div>
    {#each model.zones ?? [] as z, i (i)}
      <div class="row">
        <input class="w-id" placeholder="id" bind:value={z.id} oninput={changed} />
        <input placeholder="label" bind:value={z.label} oninput={changed} />
        <select bind:value={z.kind} onchange={changed}>{#each ZONE_KINDS as k}<option>{k}</option>{/each}</select>
        <select bind:value={z.site} onchange={changed}>
          <option value={undefined}>site —</option>
          {#each model.sites ?? [] as s}<option value={s.id}>{s.label ?? s.id}</option>{/each}
        </select>
        <button class="x" onclick={() => remove('zones', i)}>×</button>
      </div>
    {/each}
  </section>

  <section class="mp__sect">
    <div class="mp__sub"><span class="micro">VLANs</span><button class="mini" onclick={() => add('vlans', { id: null, name: '' })}>+ Add</button></div>
    {#each model.vlans ?? [] as v, i (i)}
      <div class="row">
        <input class="w-id" type="number" placeholder="id" bind:value={v.id} oninput={changed} />
        <input placeholder="name" bind:value={v.name} oninput={changed} />
        <input placeholder="subnet" bind:value={v.subnet} oninput={changed} />
        <button class="x" onclick={() => remove('vlans', i)}>×</button>
      </div>
    {/each}
  </section>

  <section class="mp__sect">
    <div class="mp__sub"><span class="micro">Subnets</span><button class="mini" onclick={() => add('subnets', { cidr: '', name: '' })}>+ Add</button></div>
    {#each model.subnets ?? [] as sn, i (i)}
      <div class="row">
        <input placeholder="cidr" bind:value={sn.cidr} oninput={changed} />
        <input placeholder="name" bind:value={sn.name} oninput={changed} />
        <input placeholder="gateway" bind:value={sn.gateway} oninput={changed} />
        <button class="x" onclick={() => remove('subnets', i)}>×</button>
      </div>
    {/each}
  </section>

  <section class="mp__sect">
    <div class="mp__sub"><span class="micro">Dependencies</span><button class="mini" onclick={() => add('dependencies', { from: '', to: '', kind: 'other', strength: 'hard' })}>+ Add</button></div>
    {#each model.dependencies ?? [] as dep, i (i)}
      <div class="dep">
        <div class="row">
          <input placeholder="from" bind:value={dep.from} oninput={changed} />
          <input placeholder="to" bind:value={dep.to} oninput={changed} />
          <button class="x" onclick={() => remove('dependencies', i)}>×</button>
        </div>
        <div class="row">
          <select bind:value={dep.kind} onchange={changed}>{#each DEP_KINDS as k}<option>{k}</option>{/each}</select>
          <select bind:value={dep.strength} onchange={changed}><option>hard</option><option>soft</option></select>
        </div>
        <input placeholder="description" bind:value={dep.description} oninput={changed} />
      </div>
    {/each}
  </section>
</div>

<style>
  .mp { width: 360px; flex: none; background: var(--panel); border-left: 1px solid var(--line); overflow-y: auto; height: 100%; }
  .mp__head { position: relative; padding: 14px 18px; border-bottom: 1px solid var(--line-soft); }
  .mp__head h2 { margin: 0; font-size: 17px; }
  .mp__close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; }
  .mp__sect { padding: 12px 16px; border-bottom: 1px solid var(--line-soft); }
  .mp__sub { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .row { display: flex; gap: 5px; margin-bottom: 5px; align-items: center; }
  .dep { border: 1px solid var(--line); border-radius: 8px; padding: 7px; margin-bottom: 7px; display: flex; flex-direction: column; gap: 5px; }
  input, select { font: inherit; font-size: 12.5px; background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 6px; padding: 5px 7px; width: 100%; min-width: 0; }
  .w-id { max-width: 64px; }
  .mini { font: inherit; font-size: 12px; background: var(--panel-2); color: var(--accent); border: 1px solid var(--line); border-radius: 6px; padding: 3px 9px; cursor: pointer; white-space: nowrap; }
  .x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 15px; padding: 0 3px; }
  .x:hover { color: var(--err); }
</style>
